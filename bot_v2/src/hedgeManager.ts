import { Logger } from './logger.js';
import { BluefinProSdk, BluefinRequestSigner, makeSigner, OrderSide, OrderType, OrderTimeInForce } from '@bluefin-exchange/pro-sdk';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import BigNumber from 'bignumber.js';

// BigNumber.js configuration for crypto precision
BigNumber.config({ EXPONENTIAL_AT: [-20, 20] });

/**
 * HedgeManager V2
 * Bluefin SDK を使用して、SUI-PERP のショートポジションを管理する。
 */
export class HedgeManager {
  private hasPosition: boolean = false;
  private currentAmount: number = 0;          // ヘッジサイズ(USDC)
  private entryPrice: number = 0;             // エントリー価格
  public hedgeDirection: 'SHORT' | 'LONG' | 'NONE' = 'NONE'; // ヘッジ方向
  private mode: 'simulate' | 'bluefin' = 'simulate';
  public bluefinClient: BluefinProSdk | null = null;
  private isInitialized: boolean = false;
  private currentAddress: string = '';        // 0xありの Sui アドレス
  private lastSyncTime: number = 0;           // 最終時刻同期タイムスタンプ
  public lastMarginBalance: number = 0;      // 最終証拠金残高
  private cumulativePnl: number = 0;          // 累積PnL
  private cumulativeFundingCost: number = 0;  // 累積Funding Rate コスト
  private lastFundingTime: number = 0;
  private readonly SIMULATED_FUNDING_RATE_8H = 0.0001;

  // ファンディングレートキャッシュ
  private cachedFundingRate: number = 0;
  private lastFundingRateFetch: number = 0;
  private readonly FUNDING_CACHE_MS = 60 * 1000; // 1分キャッシュ

  constructor(mode: 'simulate' | 'bluefin' = 'simulate') {
    this.mode = mode;
    Logger.info(`HedgeManager: モード = ${mode}`);
  }

  /**
   * 安全な数値変換: 16進数 (0x...) と10進数文字列の両方に対応
   */
  private safeBN(value: any): BigNumber {
    if (value === undefined || value === null) return new BigNumber(0);
    if (typeof value === 'string' && value.startsWith('0x')) {
      return new BigNumber(value, 16);
    }
    return new BigNumber(value);
  }

  getMode() {
    return this.mode;
  }

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
      
      this.currentAddress = keypair.toSuiAddress();
      
      this.bluefinClient = new BluefinProSdk(signer, network as any, suiClient as any, {
        currentAccountAddress: this.currentAddress
      });
      await this.bluefinClient.initialize();
      await this.syncTimeWithServer();

      try {
        const details = await this.bluefinClient.accountDataApi.getAccountDetails(
          undefined, 
          this.getAuthHeaders()
        );
        Logger.success(`✅ Bluefin Account Initialized: ${this.currentAddress}`);
        this.isInitialized = true;
      } catch (checkErr: any) {
        Logger.warn(`Bluefin Onboarding Check: ${checkErr.message}`);
        this.isInitialized = true; 
      }
    } catch (e: any) {
      Logger.error(`Bluefin Setup Failed: ${e.message}`);
      this.mode = 'simulate';
    }
  }

  private async syncTimeWithServer() {
    if (!this.bluefinClient) return;
    try {
      const infoRes = await (this.bluefinClient as any).exchangeDataApi.getExchangeInfo();
      const serverDate = infoRes.headers?.date;
      if (serverDate) {
        const serverTimeMs = new Date(serverDate).getTime();
        this.bluefinClient.updateCurrentTimeMs(serverTimeMs);
        this.lastSyncTime = Date.now();
      }
    } catch (e) {
      Logger.warn('Bluefin time sync failed.');
    }
  }

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
   * 現在の証拠金残高をチェック
   */
  async getMarginBalance(): Promise<number> {
    if (this.mode === 'simulate') return this.currentAmount * 0.5;
    if (!this.bluefinClient) return 0;

    try {
      const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(
        undefined, 
        this.getAuthHeaders()
      );
      const details = (detailsRes as any).data || detailsRes;
      return this.safeBN(details.totalAccountValueE9).dividedBy(1e9).toNumber();
    } catch (e) {
      return 0;
    }
  }

  /**
   * ポジション情報を取引所と同期
   */
  async syncPositionWithBluefin(): Promise<boolean> {
    if (this.mode === 'simulate' || !this.bluefinClient) return this.hasPosition;

    try {
      if (Date.now() - this.lastSyncTime > 5 * 60 * 1000) {
        await this.syncTimeWithServer();
      }
      const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(
        undefined, 
        this.getAuthHeaders()
      );
      const details = (detailsRes as any).data || detailsRes;
      const positions = details.positions || [];
      
      // デバッグログ: 取引所から返された全シンボルを確認
      if (positions.length > 0) {
        const symbols = positions.map((p: any) => p.symbol);
        Logger.info(`Bluefin: Found positions for ${symbols.join(', ')}`);
      }

      // 大文字小文字を区別せず、SUIが含まれるパーペチュアルを探す
      const suiPos = positions.find((p: any) => {
        const s = String(p.symbol).toUpperCase();
        return s === 'SUI-PERP' || s === 'SUI-P' || s === 'SUI' || s.includes('SUI-');
      });

      if (suiPos) {
        const sizeBN = this.safeBN(suiPos.sizeE9);
        Logger.info(`Bluefin: SUI Position found. Object: ${JSON.stringify(suiPos)}`);
        
        if (!sizeBN.isZero()) {
          const size = sizeBN.dividedBy(1e9).toNumber();
          const price = this.safeBN(suiPos.avgEntryPriceE9).dividedBy(1e9).toNumber();
          
          this.hasPosition = true;
          this.currentAmount = Math.abs(size * price);
          this.entryPrice = price;
          // ポジション方向を取引所データから復元 (size < 0 = SHORT, size > 0 = LONG, もしくは side フィールド確認)
          let parsedDirection = size < 0 ? 'SHORT' : 'LONG';
          if (suiPos.side && typeof suiPos.side === 'string') {
            parsedDirection = suiPos.side.toUpperCase();
          } else if (suiPos.positionSide && typeof suiPos.positionSide === 'string') {
            parsedDirection = suiPos.positionSide.toUpperCase();
          }
          this.hedgeDirection = parsedDirection as 'SHORT' | 'LONG';
          this.lastMarginBalance = parseFloat(details.totalAccountValueE9) / 1e9;
          Logger.info(`Bluefin: Position synced - Direction: ${this.hedgeDirection}, Size: $${this.currentAmount.toFixed(2)}`);
          return true;
        }
      }
      
      this.lastMarginBalance = details && details.totalAccountValueE9 ? parseFloat(details.totalAccountValueE9) / 1e9 : 0;
    
      // SDKのメソッド構成に合わせて同期
      if (this.lastSyncTime === 0 && this.isInitialized) {
        await this.syncTimeWithServer();
      }
      Logger.info('Bluefin: Position was closed on exchange.');
      
      this.hasPosition = false;
      this.currentAmount = 0;
      this.hedgeDirection = 'NONE';
      // entryPrice は履歴表示のために保持し続ける
      return false;
    } catch (e: any) {
      Logger.warn(`Bluefin: syncPosition failed but keeping state: ${e.message}`);
      return this.hasPosition;
    }
  }

  /**
   * 証拠金を入金する
   */
  async depositMargin(amountUsdc: number): Promise<{ digest: string }> {
    if (this.mode === 'simulate' || !this.bluefinClient) return { digest: 'simulated' };

    try {
      // 既存残高チェック
      const currentMargin = await this.getMarginBalance();
      if (currentMargin >= amountUsdc - 0.1) {
        Logger.info(`HedgeManager: Margin sufficient ($${currentMargin.toFixed(2)} >= $${amountUsdc.toFixed(2)}). Skipping deposit.`);
        return { digest: 'skipped' };
      }

      const needed = amountUsdc - currentMargin;
      Logger.info(`HedgeManager: Topping up margin. Current: $${currentMargin.toFixed(2)}, Target: $${amountUsdc.toFixed(2)}, Needed: $${needed.toFixed(2)}`);

      // BluefinClient から SuiClient を取得
      let suiClient: any = null;
      try {
        suiClient = (this.bluefinClient as any).getPublicApi?.().getSuiClient?.() || (this.bluefinClient as any).suiClient;
      } catch (e) {}
      
      let walletBalanceUsdc = 0;
      if (suiClient) {
        try {
          const coinRes = await suiClient.getCoins({
            owner: this.currentAddress,
            coinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
          });
          const walletBalanceRaw = coinRes.data.reduce((acc: bigint, c: any) => acc + BigInt(c.balance), 0n);
          walletBalanceUsdc = Number(walletBalanceRaw) / 1e6;
        } catch (e) {
          Logger.warn('HedgeManager: Failed to fetch wallet balance via SuiClient.');
          walletBalanceUsdc = needed + 1.0; // フォールバック
        }
      } else {
        Logger.warn('HedgeManager: SuiClient not found. Skipping balance check.');
        walletBalanceUsdc = needed + 1.0; // フォールバック
      }
      
      let finalAmount = needed;
      if (walletBalanceUsdc < needed + 0.1) {
        finalAmount = Math.max(0, walletBalanceUsdc - 0.1);
        Logger.warn(`HedgeManager: Wallet USDC balance ($${walletBalanceUsdc.toFixed(2)}) is low. Capping deposit to $${finalAmount.toFixed(2)}`);
      }

      if (finalAmount <= 0) {
        Logger.warn('HedgeManager: No USDC available to deposit.');
        return { digest: 'no_funds' };
      }

      const amountRaw = BigInt(Math.floor(finalAmount * 1e6));
      Logger.info(`Bluefin: Manual Deposit Implementation for $${finalAmount.toFixed(2)} (Raw: ${amountRaw})`);

      try {
        // SDKの自動コイン選択に頼らず、手動でトランザクションを構築してNaNエラーを回避
        const { Transaction } = await import('@mysten/sui/transactions');
        const tx = new Transaction();
        
        // 1. USDCコインの取得
        const coinType = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
        const coins = await suiClient.getCoins({ owner: this.currentAddress, coinType });
        if (coins.data.length === 0) throw new Error('No USDC coins found in wallet');
        
        // 2. コインの準備
        const coinObjects = coins.data.map((c: any) => tx.object(c.coinObjectId));
        tx.mergeCoins(coinObjects[0], coinObjects.slice(1));
        const [depositCoin] = tx.splitCoins(coinObjects[0], [tx.pure.u64(amountRaw)]);
        
        // 3. Bluefin: deposit_margin 呼び出し (ClearingHouse)
        const config = (this.bluefinClient as any).contractsConfig;
        if (!config) throw new Error('Bluefin contractsConfig not found. SDK might not be initialized.');
        
        const edsId = config.edsId;
        if (!edsId) throw new Error("Bluefin: Missing edsId in contractsConfig");

        tx.moveCall({
          target: `${config.currentContractAddress}::exchange::deposit_to_asset_bank`,
          arguments: [
            tx.object(edsId),               // 1. ExternalDataStore
            tx.pure.string("USDC"),         // 2. Asset Symbol
            tx.pure.address(this.currentAddress), // 3. Target Account
            tx.pure.u64(amountRaw),         // 4. Amount
            depositCoin                     // 5. Coin Object
          ],
          typeArguments: [coinType]
        });

        // 4. 残ったメインコイン（マージ済み）をウォレットに返却
        tx.transferObjects([coinObjects[0]], tx.pure.address(this.currentAddress));

        Logger.info(`Bluefin: Executing manual deposit PTB (Amount: ${finalAmount} USDC)...`);
        const response = await (this.bluefinClient as any).bfSigner.executeTx(tx, (this.bluefinClient as any).suiClient);
        
        const digest = response.digest || 'success';
        Logger.success(`✅ Bluefin: Manual margin deposit complete: ${digest}`);
        await this.getMarginBalance().catch(() => {});
        return { digest };
      } catch (sdkErr: any) {
        Logger.error(`Bluefin Manual Deposit Failure: ${sdkErr.message}`);
        throw sdkErr;
      }
    } catch (e: any) {
      Logger.error(`Bluefin: Margin deposit total failure: ${e.message}`, e.stack);
      throw e;
    }
  }

  /**
   * 全証拠金を引き出す
   */
  async withdrawAllMargin() {
    if (this.mode === 'simulate' || !this.bluefinClient) return;

    try {
      const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(
        undefined, 
        this.getAuthHeaders()
      );
      const details = (detailsRes as any).data || detailsRes;
      const marginRaw = this.safeBN(details.totalAccountValueE9);
      
      if (marginRaw.isZero()) return;

      const amountUsdc = marginRaw.dividedBy(1e9).toNumber();
      Logger.info(`Bluefin: Withdrawing all margin ($${amountUsdc.toFixed(2)} USDC)...`);
      const withdrawAmountRaw = this.safeBN(amountUsdc).times(1e9).integerValue().toString();
      await this.bluefinClient.withdraw('USDC', withdrawAmountRaw);
      Logger.success('✅ Bluefin: Margin withdrawal complete');
    } catch (e: any) {
      Logger.warn(`⚠️ Bluefin: Margin withdrawal failed: ${e.message}`);
    }
  }

  /**
   * ポジションを開く（ショートまたはロング）
   */
  async openHedge(amountUsdc: number, currentPrice: number, side: 'SHORT' | 'LONG' = 'SHORT'): Promise<{ digest: string; gasCostUsdc: number }> {
    if (this.mode === 'simulate') {
      this.hasPosition = true;
      this.currentAmount = amountUsdc;
      this.entryPrice = currentPrice;
      this.hedgeDirection = side;
      this.lastFundingTime = Date.now();
      return { digest: 'simulated', gasCostUsdc: 0 };
    }

    if (!this.bluefinClient) throw new Error('Bluefin client not initialized');

    try {
      const directionLabel = side === 'SHORT' ? 'ショート' : 'ロング';
      Logger.info(`🎯 Bluefin: ${directionLabel}ポジションを開きます ($${amountUsdc.toFixed(2)})`);

      // BluefinのSUI-PERPは整数ロット (最低1 SUI)
      let targetNotional = amountUsdc;

      const marginBalance = await this.getMarginBalance();
      // 証拠金が想定ポジション価値の55%を下回る場合は補充
      if (marginBalance < targetNotional * 0.55) {
        await this.depositMargin(targetNotional * 0.55);
      }

      let quantity = targetNotional / currentPrice;
      
      // Bluefin SUI-PERP では SUI の注文サイズは整数(Step size = 1)である必要あり
      quantity = Math.round(quantity);
      
      // Bluefin SUI-PERP 最小注文ロット (1 SUI) を下回らないように補正
      if (quantity < 1) {
        Logger.warn(`⚠️ Bluefin size ${quantity} SUI is below min lot. Forcing to 1 SUI.`);
        quantity = 1;
      }
      
      const quantityRaw = this.safeBN(quantity).times(1e9).integerValue().toString();
      const orderSide = side === 'SHORT' ? OrderSide.Short : OrderSide.Long;
      
      const response = await this.bluefinClient.createOrder({
        symbol: 'SUI-PERP',
        side: orderSide,
        type: OrderType.Market,
        quantityE9: quantityRaw, 
        priceE9: '0',
        leverageE9: this.safeBN(3).times(1e9).toString(),
        isIsolated: true,
        expiresAtMillis: Date.now() + 600000,
        clientOrderId: Date.now().toString(),
      });

      this.hasPosition = true;
      // 実際のヘッジ額は四捨五入されたSUI枚数 × 現在価格
      const actualNotional = quantity * currentPrice;
      this.currentAmount = actualNotional;
      this.entryPrice = currentPrice;
      this.hedgeDirection = side;
      this.lastFundingTime = Date.now();

      const digest = (response as any).hash || (response as any).digest || 'success';
      
      Logger.success(`✅ Bluefin: ${directionLabel} opened: ${digest}`);
      return { digest, gasCostUsdc: 0 }; // ガス記録はstrategy.ts側で実施
    } catch (e: any) {
      const errorDetail = e.response?.data || e.message;
      Logger.error(`❌ Bluefin Order Failed: ${JSON.stringify(errorDetail)}`);
      throw new Error(`Bluefin API Error: ${JSON.stringify(errorDetail)}`);
    }
  }

  /**
   * ポジションを完全に清算する
   */
  async closeHedge(currentPrice: number): Promise<{ pnl: number, digest: string }> {
    // 最新状態を確認
    await this.syncPositionWithBluefin().catch(() => {});
    
    if (!this.hasPosition) {
      Logger.info("Bluefin: クローズすべきポジションはありません。");
      return { pnl: 0, digest: '' };
    }

    let pnl = this.calculateCurrentPnl(currentPrice);
    let digest = 'none';
    const directionLabel = this.hedgeDirection === 'SHORT' ? 'ショート' : 'ロング';

    if (this.mode === 'bluefin' && this.bluefinClient) {
      try {
        Logger.info(`🔄 Bluefin: ${directionLabel}ポジション ($${this.currentAmount.toFixed(2)}) をクローズします...`);
        
        // 取引所から直接最新のサイズを取得
        const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(
          undefined, 
          this.getAuthHeaders()
        );
        const details = (detailsRes as any).data || detailsRes;
        const positions = details.positions || [];
        const suiPos = positions.find((p: any) => {
          const s = String(p.symbol).toUpperCase();
          return s === 'SUI-PERP' || s === 'SUI-P' || s === 'SUI' || s.includes('SUI-');
        });

        if (suiPos && suiPos.sizeE9 !== '0') {
          const sizeBN = this.safeBN(suiPos.sizeE9);
          const absSize = sizeBN.abs().toString();
          
          // 明示的な方向判定
          let isPosShort = sizeBN.isNegative();
          if (suiPos.side && typeof suiPos.side === 'string') {
            isPosShort = suiPos.side.toUpperCase() === 'SHORT';
          } else if (suiPos.positionSide && typeof suiPos.positionSide === 'string') {
            isPosShort = suiPos.positionSide.toUpperCase() === 'SHORT';
          }
          
          const closeSide = isPosShort ? OrderSide.Long : OrderSide.Short;
          
          Logger.info(`Bluefin: 反対売買注文作成: ${closeSide} (Size: ${absSize} E9)`);

          const response = await this.bluefinClient.createOrder({
            symbol: suiPos.symbol,
            side: closeSide,
            type: OrderType.Market,
            quantityE9: absSize, 
            priceE9: '0',
            leverageE9: suiPos.leverageE9, // ポジションと同じレバレッジを指定
            isIsolated: true,
            reduceOnly: true, // ポジション縮小専用として指定
            expiresAtMillis: Date.now() + 6000 * 1000, 
            clientOrderId: 'close_' + Date.now().toString(),
          });

          digest = (response as any).hash || (response as any).digest || (response as any).id || 'success';
          Logger.success(`✅ Bluefin: ${directionLabel}決済注文を送信しました: ${digest}`);
          
          // 決済後は確実に hasPosition を落とす（失敗なら catch へ）
          this.hasPosition = false;
          this.currentAmount = 0;
          this.hedgeDirection = 'NONE';
        } else {
          Logger.warn("Bluefin: 取引所にポジションが見つかりませんでした。内部状態のみクリアします。");
          this.hasPosition = false;
          this.currentAmount = 0;
          this.hedgeDirection = 'NONE';
        }
      } catch (e: any) {
        const errorDetail = e.response?.data || e.message;
        Logger.error(`❌ Bluefin: 決済に失敗しました: ${JSON.stringify(errorDetail)}`);
        // 決済失敗時は hasPosition = true を維持し、例外を投げて strategy を停止させる
        throw new Error(`Bluefin Close Failed: ${JSON.stringify(errorDetail)}`);
      }
    } else {
      // シミュレーションモード等
      this.hasPosition = false;
      this.currentAmount = 0;
      this.hedgeDirection = 'NONE';
    }

    this.cumulativePnl += pnl;
    return { pnl, digest };
  }

  calculateCurrentPnl(currentPrice: number): number {
    if (!this.hasPosition || this.entryPrice <= 0) return 0;
    if (this.hedgeDirection === 'SHORT') {
      // ショート: 価格下落 → 利益
      const priceChangeRatio = (this.entryPrice - currentPrice) / this.entryPrice;
      return this.currentAmount * priceChangeRatio;
    } else {
      // ロング: 価格上昇 → 利益
      const priceChangeRatio = (currentPrice - this.entryPrice) / this.entryPrice;
      return this.currentAmount * priceChangeRatio;
    }
  }

  async checkAndMaintainMargin(currentPrice: number): Promise<void> {
    if (this.mode === 'simulate' || !this.bluefinClient || !this.hasPosition) return;
    try {
      await this.syncPositionWithBluefin();
      if (!this.hasPosition) return;

      const marginBalance = await this.getMarginBalance();
      const minThreshold = this.currentAmount * 0.4;

      if (marginBalance < minThreshold) {
        Logger.warn(`⚠️ Bluefin: Margin low ($${marginBalance.toFixed(2)}). Refilling...`);
        await this.depositMargin(this.currentAmount * 0.5);
      }
    } catch (e: any) {
      Logger.error(`Bluefin margin maintenance failed: ${e.message}`);
    }
  }

  /**
   * Bluefinからファンディングレート（1時間あたり）を取得
   * 安全ゲート・採算性判断に使用
   */
  async getFundingRate(): Promise<number> {
    // キャッシュ有効期間内はキャッシュを返す
    if (Date.now() - this.lastFundingRateFetch < this.FUNDING_CACHE_MS) {
      return this.cachedFundingRate;
    }

    if (this.mode === 'simulate') {
      // シミュレーション: 8時間レートを1時間に換算
      return this.SIMULATED_FUNDING_RATE_8H / 8;
    }

    try {
      if (!this.bluefinClient) return 0;
      // Bluefin REST APIからファンディングレートを取得
      const resp = await fetch('https://dapi.api.sui-prod.bluefin.io/fundingRate?symbol=SUI-PERP');
      if (resp.ok) {
        const data = await resp.json();
        // 8時間レートを1時間に換算
        const rate8h = parseFloat(data?.fundingRate || '0');
        this.cachedFundingRate = rate8h / 8;
        this.lastFundingRateFetch = Date.now();
        Logger.info(`💸 FundingRate: ${(this.cachedFundingRate * 100).toFixed(4)}%/h`);
        return this.cachedFundingRate;
      }
    } catch (e: any) {
      Logger.warn(`FundingRate fetch failed: ${e.message}`);
    }
    return this.cachedFundingRate; // フォールバック
  }

  /**
   * 証拠金比率(%)を計算
   * 安全ゲート: 150%未満で緊急停止
   */
  async getMarginRatio(): Promise<number> {
    if (!this.hasPosition || this.currentAmount <= 0) return 999;

    if (this.mode === 'simulate') {
      return 200; // シミュレーションでは常に安全とみなす
    }

    try {
      const marginBalance = await this.getMarginBalance();
      if (marginBalance <= 0) return 0;
      // 証拠金比率 = 証拠金残高 / ポジション名目価値 × 100
      const ratio = (marginBalance / this.currentAmount) * 100;
      Logger.info(`📊 MarginRatio: ${ratio.toFixed(1)}% (margin=$${marginBalance.toFixed(2)}, pos=$${this.currentAmount.toFixed(2)})`);
      return ratio;
    } catch (e: any) {
      Logger.warn(`MarginRatio calc failed: ${e.message}`);
      return 999;
    }
  }

  /**
   * LP のデルタを数学的に計算
   * 集中流動性プール（CLMM）のデルタ:
   *   price が [L, U] 内: delta ≈ sqrt(price/U) - sqrt(price/L) → 近似として 0.5 ± 調整
   *   price < L: delta = 0 (全額USDC)
   *   price > U: delta = 1 (全額SUI)
   * @returns deltaHedgeUsd ヘッジすべきUSD額
   */
  calcHedgeDelta(currentPrice: number, lowerTick: number, upperTick: number, lpValueUsdc: number): {
    delta: number;
    hedgeUsd: number;
  } {
    if (lowerTick <= 0 || upperTick <= lowerTick || lpValueUsdc <= 0) {
      return { delta: 0.5, hedgeUsd: lpValueUsdc * 0.5 };
    }

    let delta: number;
    if (currentPrice <= lowerTick) {
      delta = 0; // 全額USDC → ヘッジ不要
    } else if (currentPrice >= upperTick) {
      delta = 1.0; // 全額SUI → フルヘッジ
    } else {
      // CLMM delta近似式
      const sqrtP = Math.sqrt(currentPrice);
      const sqrtL = Math.sqrt(lowerTick);
      const sqrtU = Math.sqrt(upperTick);
      delta = (sqrtP - sqrtL) / (sqrtU - sqrtL);
      delta = Math.max(0, Math.min(1, delta));
    }

    const hedgeUsd = delta * lpValueUsdc;
    Logger.info(`🔢 HedgeDelta: δ=${delta.toFixed(4)}, hedgeUsd=$${hedgeUsd.toFixed(2)}`);
    return { delta, hedgeUsd };
  }

  /**
   * ポジションサイズを新しいnotionalに調整
   * 現在より大きい → 追加注文
   * 現在より小さい → 部分決済
   */
  async adjustPosition(newNotionalUsdc: number, currentPrice: number): Promise<{ digest: string }> {
    const currentNotional = this.currentAmount;
    const diff = newNotionalUsdc - currentNotional;
    const diffPct = Math.abs(diff) / (currentNotional || 1);

    Logger.info(`🔧 AdjustPosition: current=$${currentNotional.toFixed(2)}, target=$${newNotionalUsdc.toFixed(2)}, diff=${(diffPct*100).toFixed(1)}%`);

    if (diffPct < 0.05) {
      Logger.info('AdjustPosition: 差異5%未満 → スキップ');
      return { digest: 'skipped' };
    }

    if (this.mode === 'simulate') {
      this.currentAmount = newNotionalUsdc;
      return { digest: 'simulated' };
    }

    if (diff > 0) {
      // 追加発注 (同方向)
      return await this.openHedge(Math.abs(diff), currentPrice, this.hedgeDirection as 'SHORT' | 'LONG');
    } else {
      // 部分決済 → 全決済して再オープン (Bluefinは部分決済がシンプル)
      Logger.info('AdjustPosition: 縮小 → 全決済して新サイズで再オープン');
      await this.closeHedge(currentPrice);
      if (newNotionalUsdc > 1) {
        return await this.openHedge(newNotionalUsdc, currentPrice, this.hedgeDirection as 'SHORT' | 'LONG');
      }
      return { digest: 'closed' };
    }
  }

  getStatus(currentPrice: number) {
    const currentPnl = this.calculateCurrentPnl(currentPrice);
    return {
      active: this.hasPosition,
      mode: this.mode,
      direction: this.hedgeDirection,
      size: Number(this.currentAmount.toFixed(2)),
      entryPrice: Number(this.entryPrice.toFixed(4)),
      currentPnl: Number(currentPnl.toFixed(4)),
      cumulativePnl: Number(this.cumulativePnl.toFixed(4)),
      marginBalance: Number(this.lastMarginBalance.toFixed(2)),
    };
  }

  serialize() {
    return {
      hasPosition: this.hasPosition,
      currentAmount: this.currentAmount,
      entryPrice: this.entryPrice,
      hedgeDirection: this.hedgeDirection,
      cumulativePnl: this.cumulativePnl,
    };
  }

  restore(data: any) {
    if (!data) return;
    this.hasPosition = data.hasPosition || false;
    this.currentAmount = data.currentAmount || 0;
    this.entryPrice = data.entryPrice || 0;
    this.hedgeDirection = data.hedgeDirection || 'NONE';
    this.cumulativePnl = data.cumulativePnl || 0;
  }
}
