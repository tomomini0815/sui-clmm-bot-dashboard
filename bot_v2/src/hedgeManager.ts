import { Logger } from './logger.js';
import { BluefinProSdk, BluefinRequestSigner, makeSigner, OrderSide, OrderType, OrderTimeInForce } from '@bluefin-exchange/pro-sdk';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import BigNumber from 'bignumber.js';

// BigNumber.js configuration for crypto precision
BigNumber.config({ EXPONENTIAL_AT: [-20, 20] });

/**
 * シミュレーション型 Hedge Manager (Phase 1)
 * 
 * 実際のPerp DEX接続はせず、ショートポジションの損益を
 * シミュレーションで計算する。将来的にBluefin SDK統合可能。
 * 
 * 目的: デルタニュートラル戦略の損益追跡と、
 * フロントエンドでのデルタ可視化を可能にする。
 */
export class HedgeManager {
  private hasPosition: boolean = false;
  private currentAmount: number = 0;          // ヘッジサイズ(USDC)
  private entryPrice: number = 0;             // ショートエントリー価格
  private mode: 'simulate' | 'bluefin' = 'simulate';

  // シミュレーション追跡
  private cumulativePnl: number = 0;          // 累積PnL
  private cumulativeFundingCost: number = 0;  // 累積Funding Rate コスト
  private lastFundingTime: number = 0;

  // Bluefin SDK
  private bluefinClient: BluefinProSdk | null = null;
  private readonly SIMULATED_FUNDING_RATE_8H = 0.0001; // 8時間ごとの Funding Rate (0.01%)
  private isInitialized: boolean = false;

  private currentAddress: string = ''; // 0xありの Sui アドレス
  private lastSyncTime: number = 0;   // 最終時刻同期タイムスタンプ

  constructor(mode: 'simulate' | 'bluefin' = 'simulate') {
    this.mode = mode;
    Logger.info(`HedgeManager: モード = ${mode}`);
  }

  /**
   * 現在の動作モードを取得
   */
  getMode() {
    return this.mode;
  }

  /**
   * 初期化が完了しているか
   */
  isReady() {
    return this.mode === 'simulate' || (this.mode === 'bluefin' && this.isInitialized);
  }

  /**
   * Bluefin SDK の初期化
   */
  async setupBluefin(keypair: Ed25519Keypair, rpcUrl: string, network: 'mainnet' | 'testnet' = 'mainnet') {
    if (this.mode === 'simulate') return;
    
    try {
      Logger.info(`Bluefin: Initializing for ${network}...`);
      const signer = new BluefinRequestSigner(makeSigner(keypair as any, false));
      const suiClient = new SuiClient({ url: rpcUrl });
      
      // ログイン用には 0x ありの Sui アドレスを使用 (テストで成功確認済み)
      this.currentAddress = keypair.toSuiAddress();
      
      this.bluefinClient = new BluefinProSdk(signer, network as any, suiClient as any, {
        currentAccountAddress: this.currentAddress
      });
      await this.bluefinClient.initialize();

      // [重要] サーバー時刻との同期処理 (初回)
      await this.syncTimeWithServer();

      // SDKの不具合対策: getAccountDetails に認証ヘッダーを手動で付与
      try {
        Logger.info(`Bluefin: Checking account onboarding status for ${this.currentAddress}...`);
        const details = await this.bluefinClient.accountDataApi.getAccountDetails(
          undefined, 
          this.getAuthHeaders()
        );
        const accountId = (details as any).data?.accountAddress;
        
        if (!accountId) {
          throw new Error('FAILED_TO_EXTRACT_ACCOUNT_ID');
        }
        
        Logger.success(`✅ Bluefin Account Onboarded: ${accountId}`);
        this.isInitialized = true;
      } catch (checkErr: any) {
        const errorMsg = checkErr.response?.data?.message || checkErr.message;
        Logger.warn(`Bluefin Onboarding Check Note: ${errorMsg}`);
        
        if (errorMsg.includes('account is not found') || errorMsg.includes('Failed to extract account id')) {
          // 画像で入金が確認できているため、致命的エラーにせず実稼働を試行
          Logger.info('⚠️ アカウントIDの抽出に失敗しましたが、入金済みのため稼動を開始します。');
          this.isInitialized = true;
          return;
        }
        throw checkErr;
      }
      Logger.success(`Bluefin SDK initialized. Wallet: ${this.currentAddress}`);
    } catch (e: any) {
      if (e.message === 'ONBOARDING_REQUIRED') {
        Logger.warn('⚠️ オンボーディング待ちのため、シミュレーションモードで待機します。');
      } else {
        Logger.error(`❌ Bluefin initialization failed: ${e.message}`, e);
        Logger.warn('⚠️ Bluefin の初期化に失敗したため、シミュレーションモードにフォールバックします。');
      }
      this.mode = 'simulate';
    }
  }

  /**
   * SDKの不具合（ヘッダー漏れ）を補完するための認証ヘッダー取得ヘルパー
   */
  private getAuthHeaders() {
    const token = (this.bluefinClient as any).getTokenResponse()?.accessToken;
    if (!token) return {};
    return {
      headers: {
        Authorization: `Bearer ${token}`
      }
    };
  }

  /**
   * Bluefin サーバー時刻との同期を実行
   */
  async syncTimeWithServer() {
    if (!this.bluefinClient) return;
    try {
      const infoRes = await (this.bluefinClient as any).exchangeDataApi.getExchangeInfo();
      const serverDate = infoRes.headers?.date;
      if (serverDate) {
        const serverTimeMs = new Date(serverDate).getTime();
        this.bluefinClient.updateCurrentTimeMs(serverTimeMs);
        this.lastSyncTime = Date.now();
        Logger.success(`⏰ Bluefin: Server time synced to ${new Date(serverTimeMs).toISOString()} (Offset calibration applied)`);
      }
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message;
      Logger.warn(`⚠️ Bluefin time sync failed: ${msg}`);
    }
  }


  async hasExistingHedge(): Promise<boolean> {
    if (this.mode === 'bluefin' && this.bluefinClient) {
      const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(
        undefined, 
        this.getAuthHeaders()
      );
      const details = (detailsRes as any).data || detailsRes;
      const positions = details.positions || [];
      return positions.some((p: any) => p.symbol === 'SUI-PERP' || p.symbol === 'SUI-P');
    }
    return this.hasPosition;
  }

  /**
   * Bluefin上の実ポジションと内部状態を同期する
   */
  async syncPositionWithBluefin(): Promise<boolean> {
    if (this.mode === 'simulate' || !this.bluefinClient) return this.hasPosition;

    try {
      // 5分経過していたら自動で再同期
      if (Date.now() - this.lastSyncTime > 5 * 60 * 1000) {
        await this.syncTimeWithServer();
      }
      const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(
        undefined, 
        this.getAuthHeaders()
      );
      const details = (detailsRes as any).data || detailsRes;
      
      // デバッグログ: 利用可能なポジション情報を出力
      const positions = details.positions || [];
      if (positions.length > 0) {
        const symbols = positions.map((p: any) => p.symbol).join(', ');
        Logger.info(`Bluefin Account Positions: [${symbols}]`);
      }

      const suiPos = positions.find((p: any) => p.symbol === 'SUI-PERP' || p.symbol === 'SUI-P');

      if (suiPos) {
        // ポジションが存在する場合 (V2 SDK は E9 精度)
        const quantity = Math.abs(new BigNumber(suiPos.sizeE9 || 0).dividedBy(1e9).toNumber());
        const entryPrice = new BigNumber(suiPos.avgEntryPriceE9 || 0).dividedBy(1e9).toNumber();
        
        if (quantity > 0) {
          this.hasPosition = true;
          this.entryPrice = entryPrice;
          this.currentAmount = quantity * entryPrice;
          this.lastMarginBalance = new BigNumber(details.totalAccountValueE9 || 0).dividedBy(1e9).toNumber();
          
          Logger.info(`📊 Bluefin: 実ポジションを同期しました (Symbol: ${suiPos.symbol}, Size: ${quantity.toFixed(2)} SUI, Entry: $${this.entryPrice.toFixed(4)})`);
          return true;
        }
      }
      
      // ポジションがない場合
      if (this.hasPosition) {
        Logger.warn('📊 Bluefin: 内部では「ヘッジあり」ですが、実ポジションが見つかりません。フラグをオフにします。');
      }
      this.hasPosition = false;
      this.currentAmount = 0;
      this.entryPrice = 0;
      return false;
    } catch (e: any) {
      const errorMsg = e.response?.data?.message || e.message;
      Logger.error(`❌ Bluefin: ポジション同期失敗: ${errorMsg}`);
      
      // SignedAtUtcMillis エラーの場合は即座に時刻同期して次回に備える
      if (errorMsg.includes('SignedAtUtcMillis')) {
        await this.syncTimeWithServer();
      }
      return this.hasPosition;
    }
  }

  /**
   * Bluefin サブアカウントに証拠金を入金する
   */
  async depositMargin(amountUsdc: number): Promise<{ digest: string }> {
    if (this.mode === 'simulate' || !this.bluefinClient) return { digest: 'simulated' };

    try {
      const addr = (this.bluefinClient as any).currentAccountAddress; // 0xありのオリジナル地址

      // 既存マージン残高の確認
      try {
        const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(
          undefined, 
          this.getAuthHeaders()
        );
        const details = (detailsRes as any).data || detailsRes;
        const currentMargin = new BigNumber(details.totalAccountValueE9 || 0).dividedBy(1e9).toNumber();
        
        if (currentMargin >= amountUsdc - 0.1) {
          Logger.success(`📊 Bluefin: Current margin ($${currentMargin.toFixed(2)}) is sufficient for $${amountUsdc.toFixed(2)} hedge. Skipping deposit.`);
          return { digest: 'skipped' };
        }
        
        Logger.info(`Bluefin: Current margin is $${currentMargin.toFixed(2)}. Depositing additional funds...`);
      } catch (checkErr: any) {
        const errorMsg = checkErr.response?.data?.message || checkErr.message;
        Logger.warn(`Bluefin: Could not check current margin: ${errorMsg}`);
        if (errorMsg.includes('SignedAtUtcMillis')) {
          await this.syncTimeWithServer();
        }
      }

      Logger.info(`Bluefin: Depositing $${amountUsdc.toFixed(2)} USDC as margin...`);

      // 実際の Sui 残高を確認
      const suiClient = (this.bluefinClient as any).suiClient;
      const coinRes = await suiClient.getCoins({
        owner: addr,
        coinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
      });
      const walletBalanceRaw = coinRes.data.reduce((acc: bigint, c: any) => acc + BigInt(c.balance), 0n);
      const walletBalanceUsdc = new BigNumber(walletBalanceRaw.toString()).dividedBy(1e6).toNumber();
      
      Logger.info(`💰 Wallet USDC Balance: $${walletBalanceUsdc.toFixed(2)}`);

      // 入金額を残高内に収める (安全マージン 0.1 USDC 確保)
      let finalAmount = amountUsdc;
      if (walletBalanceUsdc < amountUsdc + 0.1) {
        finalAmount = Math.max(0, walletBalanceUsdc - 0.1);
        Logger.warn(`⚠️ 残高不足のため入金額を調整しました: $${amountUsdc.toFixed(2)} -> $${finalAmount.toFixed(2)}`);
      }

      if (finalAmount <= 0) {
        Logger.warn('入金可能な USDC がありません。スキップします。');
        return { digest: 'skipped' };
      }

      const amountRaw = new BigNumber(finalAmount).times(1e6).integerValue().toString();
      Logger.info(`Bluefin: 最終入金額: ${finalAmount.toFixed(4)} USDC (Raw E6: ${amountRaw})`);

      // 修正: 第2引数に明示的に Sui アドレス (0xあり) を渡すことでオンチェーン操作を正常化
      const response = await this.bluefinClient.deposit(amountRaw, this.currentAddress);
      const digest = (response as any).digest || (response as any).hash || 'success';

      Logger.info(`✅ Bluefin: 証拠金入金完了。Digest: ${digest}`);
      return { digest };
    } catch (e: any) {
      Logger.error(`❌ Bluefin: 入金失敗: ${e.message || 'Unknown Error'}`);
      if (e.response && e.response.data) {
        Logger.error(`Detailed Error Data: ${JSON.stringify(e.response.data)}`);
      }
      throw e;
    }
  }

  /**
   * Bluefin サブアカウントから全ての証拠金を引き出す
   */
  async withdrawAllMargin(): Promise<{ digest: string }> {
    if (this.mode === 'simulate' || !this.bluefinClient) return { digest: 'simulated' };

    try {
      const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(
        undefined, 
        this.getAuthHeaders()
      );
      const details = (detailsRes as any).data || detailsRes;
      const marginRaw = new BigNumber(details.totalAccountValueE9 || 0);
      
      if (marginRaw.isZero()) {
        Logger.info(`Bluefin: 回収可能な証拠金はありません。`);
        return { digest: '' };
      }

      const amountUsdc = marginRaw.dividedBy(1e9).toNumber();
      Logger.info(`Bluefin: Withdrawing all margin ($${amountUsdc.toFixed(2)} USDC) to wallet...`);
      
      const withdrawAmountRaw = new BigNumber(amountUsdc).times(1e9).integerValue().toString();
      
      await this.bluefinClient.withdraw('USDC', withdrawAmountRaw);

      Logger.info(`✅ Bluefin: 証拠金回収をリクエストしました`);
      return { digest: 'success' };
    } catch (e: any) {
      Logger.warn(`⚠️ Bluefin: 証拠金回収に失敗しました（無視して続行可能）: ${e.message}`);
      return { digest: '' };
    }
  }

  /**
   * ショートポジションを開く
   */
  async openHedge(amountUsdc: number, currentPrice: number): Promise<{ digest: string }> {
    Logger.startSpin(`Opening Short Position for $${amountUsdc.toFixed(2)} at $${currentPrice.toFixed(4)}...`);

    if (this.mode === 'simulate') {
      // シミュレーション: 即座にポジション記録
      this.hasPosition = true;
      this.currentAmount = amountUsdc;
      this.entryPrice = currentPrice;
      this.lastFundingTime = Date.now();

      Logger.stopSpin(`📊 [SIM] ショートポジション $${amountUsdc.toFixed(2)} @ $${currentPrice.toFixed(4)} を開設（シミュレーション）`);
      return { digest: 'simulated' };
    } else if (this.bluefinClient) {
      try {
        const market = 'SUI-PERP';

        // --- 自動マージン補充 ---
        const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(
          undefined, 
          this.getAuthHeaders()
        );
        const details = (detailsRes as any).data || detailsRes;
        const marginBalance = new BigNumber(details.totalAccountValueE9 || 0).dividedBy(1e9).toNumber();
        
        // 必要な担保額（ポジションサイズの50%以上を推奨）
        // 修正: 実際にウォレットにある USDC 残高を超えないように制限する
        const safetyMargin = 0.5; // ガス代等
        let targetDeposit = amountUsdc;
        
        if (marginBalance < amountUsdc * 0.5) {
          Logger.info(`Bluefin: 残高不足 ($${marginBalance.toFixed(2)})。自動補充を検討します...`);
          // ここでは実際の入金は depositMargin 内で残高チェックを行うように任せるか、
          // あるいはここで量を調整する
          await this.depositMargin(targetDeposit);
        }

        // 50%デルタヘッジ用に数量を計算 (amountUsdc / currentPrice)
        const quantity = amountUsdc / currentPrice;
        
        // --- 修正: Bluefin SDK の注文パラメータ(E9)は 9桁 (1e9) を期待します ---
        const quantityRaw = new BigNumber(quantity).times(1e9).integerValue().toString();
        
        // 成行注文でも価格指定が必要な場合のための計算 (現在は '0' を使用)
        const slippagePrice = currentPrice * 0.9; 
        const priceRaw = new BigNumber(slippagePrice).times(1e9).integerValue().toString();

        Logger.info(`Bluefin: Placing Market SHORT order for ${quantity.toFixed(4)} SUI ($${amountUsdc.toFixed(2)})`);
        
        const response = await this.bluefinClient.createOrder({
          symbol: market,
          side: OrderSide.Short,
          type: OrderType.Market,
          quantityE9: quantityRaw, 
          priceE9: '0', // 成行注文では価格を '0' に設定する必要がある (400エラー回避)
          leverageE9: new BigNumber(1).times(1e9).toString(), // レバレッジ1倍 (E9 = 10^9)
          isIsolated: true,
          expiresAtMillis: Date.now() + 600000, // 有効期限を10分に延長 (時刻同期ズレ対策)
          clientOrderId: Date.now().toString(),
        });

        this.hasPosition = true;
        this.currentAmount = amountUsdc;
        this.entryPrice = currentPrice;
        this.lastFundingTime = Date.now();

        const digest = (response as any).hash || (response as any).digest || 'success';
        Logger.stopSpin(`✅ Bluefin: ショートポジションを開設しました。Digest: ${digest}`);
        return { digest };
      } catch (e: any) {
        Logger.stopSpin(`❌ Bluefin: ショート開設に失敗しました: ${e.message}`);
        if (e.response && e.response.data) {
           Logger.error(`Order Error Details: ${JSON.stringify(e.response.data)}`);
        }
        throw e;
      }
    }
    return { digest: '' };
  }

  /**
   * ショートポジションを閉じる（シミュレーション）
   */
  async closeHedge(currentPrice: number): Promise<{ pnl: number, digest: string }> {
    if (!this.hasPosition) return { pnl: 0, digest: '' };

    Logger.startSpin(`Closing Short Position of $${this.currentAmount.toFixed(2)}...`);

    let pnl = this.calculateCurrentPnl(currentPrice);
    let digest = 'simulated';

    if (this.mode === 'bluefin' && this.bluefinClient) {
      try {
        // 修正: 引数なしで呼び出す
        const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails();
        const details = (detailsRes as any).data || detailsRes;
        const positions = details.positions || [];
        const suiPos = positions.find((p: any) => p.symbol === 'SUI-PERP' || p.symbol === 'SUI-P');

        if (suiPos) {
          const qty = suiPos.sizeE9; 
          
          // 決済用成行買い注文 (ロング)
          // 現在価格の +10% をスリッページ許容価格とする
          const slippagePrice = currentPrice * 1.1;
          const priceRaw = new BigNumber(slippagePrice).times(1e9).integerValue().toString();

          Logger.info(`Bluefin: Closing position with opposite order (BUY) at limit $${slippagePrice.toFixed(4)}...`);
          const response = await this.bluefinClient.createOrder({
            symbol: suiPos.symbol,
            side: OrderSide.Long,
            type: OrderType.Market,
            quantityE9: qty, 
            priceE9: priceRaw,
            leverageE9: new BigNumber(1).times(1e9).toString(),
            isIsolated: true,
            expiresAtMillis: Date.now() + 60000,
            clientOrderId: Date.now().toString(),
          });
          digest = (response as any).hash || (response as any).digest || 'success';
          Logger.info(`✅ Bluefin: ショートを決済しました。Digest: ${digest}`);
        }
      } catch (e: any) {
        Logger.error(`❌ Bluefin: 決済に失敗しました: ${e.message}`);
      }
    }

    this.cumulativePnl += pnl;
    this.settleFunding();

    this.hasPosition = false;
    this.currentAmount = 0;
    this.entryPrice = 0;

    Logger.stopSpin(`📊 ショート決済完了: PnL = ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}`);
    return { pnl, digest };
  }

  /**
   * 現在のショートPnLを計算
   * （ショート = 価格下落で利益、上昇で損失）
   */
  calculateCurrentPnl(currentPrice: number): number {
    if (!this.hasPosition || this.entryPrice <= 0) return 0;

    // ショート PnL = サイズ × (エントリー - 現在) / エントリー
    const priceChangeRatio = (this.entryPrice - currentPrice) / this.entryPrice;
    return this.currentAmount * priceChangeRatio;
  }

  /**
   * Funding Rate コストをシミュレーション
   * Perp市場では8時間ごとにFunding支払いが発生
   */
  private settleFunding() {
    if (this.lastFundingTime <= 0) return;

    const elapsed = Date.now() - this.lastFundingTime;
    const intervals = elapsed / (8 * 60 * 60 * 1000); // 8時間ごとの間隔数
    const cost = this.currentAmount * this.SIMULATED_FUNDING_RATE_8H * intervals;

    this.cumulativeFundingCost += cost;
    this.lastFundingTime = Date.now();
  }

  private lastMarginBalance: number = 0;

  /**
   * 証拠金維持率をチェックし、必要に応じて自動補充する
   * @param currentPrice 現在のSUI価格
   */
  async checkAndMaintainMargin(currentPrice: number): Promise<void> {
    if (this.mode === 'simulate' || !this.bluefinClient || !this.hasPosition) return;

    try {
      // 5分経過していたら自動で再同期
      if (Date.now() - this.lastSyncTime > 5 * 60 * 1000) {
        await this.syncTimeWithServer();
      }

      const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(
        undefined, 
        this.getAuthHeaders()
      );
      const details = (detailsRes as any).data || detailsRes;
      
      // totalAccountValueE9 を使用 (E9精度)
      const marginBalance = new BigNumber(details.totalAccountValueE9 || 0).dividedBy(1e9).toNumber();
      
      this.lastMarginBalance = marginBalance;
      
      // メンテナンスマージン（維持証拠金）の閾値
      const requiredMargin = this.currentAmount * 0.5;
      const minThreshold = this.currentAmount * 0.4;

      if (marginBalance < minThreshold) {
        Logger.warn(`⚠️ Bluefin: 証拠金維持率低下 ($${marginBalance.toFixed(2)} < $${minThreshold.toFixed(2)})。自動補充を実行します。`);
        
        const topUpAmount = requiredMargin - marginBalance + (this.currentAmount * 0.1);
        await this.depositMargin(Math.max(10, topUpAmount)); 
        
        Logger.success(`✅ Bluefin: 証拠金を補充しました。`);
      } else {
        const ratio = (marginBalance / (this.currentAmount || 1) * 100).toFixed(1);
        Logger.info(`📊 Bluefin維持証拠金: $${marginBalance.toFixed(2)} (${ratio}%)`);
      }
    } catch (e: any) {
      const errorMsg = e.response?.data?.message || e.message;
      Logger.error(`❌ Bluefin証拠金チェック失敗: ${errorMsg}`);
      
      if (errorMsg.includes('SignedAtUtcMillis')) {
        await this.syncTimeWithServer();
      }
    }
  }

  /**
   * ヘッジの状態情報を取得
   */
  getStatus(currentPrice: number): {
    active: boolean;
    mode: string;
    size: number;
    entryPrice: number;
    currentPnl: number;
    cumulativePnl: number;
    fundingCost: number;
    marginBalance: number;
    maintenanceMargin: number;
  } {
    const currentPnl = this.calculateCurrentPnl(currentPrice);

    return {
      active: this.hasPosition,
      mode: this.mode,
      size: Number(this.currentAmount.toFixed(2)),
      entryPrice: Number(this.entryPrice.toFixed(4)),
      currentPnl: Number(currentPnl.toFixed(4)),
      cumulativePnl: Number(this.cumulativePnl.toFixed(4)),
      fundingCost: Number(this.cumulativeFundingCost.toFixed(4)),
      marginBalance: Number(this.lastMarginBalance.toFixed(2)),
      maintenanceMargin: Number((this.currentAmount * 0.4).toFixed(2)),
    };
  }

  /**
   * ヘッジサイズを調整（デルタ再調整時）
   */
  async adjustHedgeSize(newAmountUsdc: number, currentPrice: number): Promise<void> {
    if (!this.hasPosition) {
      await this.openHedge(newAmountUsdc, currentPrice);
      return;
    }

    const diff = newAmountUsdc - this.currentAmount;
    if (Math.abs(diff) < 0.01) {
      Logger.info(`ヘッジサイズ変更なし ($${this.currentAmount.toFixed(2)})`);
      return;
    }

    Logger.info(`📊 ヘッジサイズ調整: $${this.currentAmount.toFixed(2)} → $${newAmountUsdc.toFixed(2)}`);
    this.currentAmount = newAmountUsdc;
    // 部分決済のPnLは簡易的にリセットしない（累積に含む）
  }

  /**
   * セッション間で状態を復元するためのシリアライズ
   */
  serialize() {
    return {
      hasPosition: this.hasPosition,
      currentAmount: this.currentAmount,
      entryPrice: this.entryPrice,
      cumulativePnl: this.cumulativePnl,
      cumulativeFundingCost: this.cumulativeFundingCost,
      lastFundingTime: this.lastFundingTime,
    };
  }

  /**
   * シリアライズされた状態から復元
   */
  restore(data: any) {
    if (!data) return;
    this.hasPosition = data.hasPosition || false;
    this.currentAmount = data.currentAmount || 0;
    this.entryPrice = data.entryPrice || 0;
    this.cumulativePnl = data.cumulativePnl || 0;
    this.cumulativeFundingCost = data.cumulativeFundingCost || 0;
    this.lastFundingTime = data.lastFundingTime || 0;
    Logger.info(`📊 [SIM] ヘッジ状態復元 - 累積PnL: $${this.cumulativePnl.toFixed(4)}`);
  }
}
