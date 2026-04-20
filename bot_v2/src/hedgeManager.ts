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
  private entryPrice: number = 0;             // ショートエントリー価格
  private mode: 'simulate' | 'bluefin' = 'simulate';
  private bluefinClient: BluefinProSdk | null = null;
  private isInitialized: boolean = false;
  private currentAddress: string = '';        // 0xありの Sui アドレス
  private lastSyncTime: number = 0;           // 最終時刻同期タイムスタンプ
  private lastMarginBalance: number = 0;      // 最終証拠金残高
  private cumulativePnl: number = 0;          // 累積PnL
  private cumulativeFundingCost: number = 0;  // 累積Funding Rate コスト
  private lastFundingTime: number = 0;
  private readonly SIMULATED_FUNDING_RATE_8H = 0.0001;

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
        Logger.info(`Bluefin: SUI Position found. SizeE9: ${suiPos.sizeE9}, IsZero: ${sizeBN.isZero()}`);
        
        if (!sizeBN.isZero()) {
          const size = sizeBN.dividedBy(1e9).toNumber();
          const price = this.safeBN(suiPos.avgEntryPriceE9).dividedBy(1e9).toNumber();
          
          this.hasPosition = true;
          this.currentAmount = Math.abs(size * price);
          this.entryPrice = price;
          this.lastMarginBalance = this.safeBN(details.totalAccountValueE9).dividedBy(1e9).toNumber();
          return true;
        }
      }
      
      if (this.hasPosition) {
        Logger.info('Bluefin: Position was closed on exchange.');
      }
      
      this.hasPosition = false;
      this.currentAmount = 0;
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
        return { digest: 'skipped' };
      }

      Logger.info(`Bluefin: Depositing $${amountUsdc.toFixed(2)} USDC...`);
      const suiClient = (this.bluefinClient as any).suiClient;
      const coinRes = await suiClient.getCoins({
        owner: this.currentAddress,
        coinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
      });
      const walletBalanceRaw = coinRes.data.reduce((acc: bigint, c: any) => acc + BigInt(c.balance), 0n);
      const walletBalanceUsdc = this.safeBN(walletBalanceRaw.toString()).dividedBy(1e6).toNumber();
      
      let finalAmount = amountUsdc;
      if (walletBalanceUsdc < amountUsdc + 0.1) {
        finalAmount = Math.max(0, walletBalanceUsdc - 0.1);
      }

      if (finalAmount <= 0) return { digest: 'skipped' };

      const amountRaw = this.safeBN(finalAmount).times(1e6).integerValue().toString();
      const response = await this.bluefinClient.deposit(amountRaw, this.currentAddress);
      const digest = (response as any).digest || (response as any).hash || 'success';

      Logger.success(`✅ Bluefin: Margin deposit complete: ${digest}`);
      return { digest };
    } catch (e: any) {
      Logger.error(`Bluefin: Margin deposit failed: ${e.message}`);
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
   * ショートポジションを開く
   */
  async openHedge(amountUsdc: number, currentPrice: number): Promise<{ digest: string }> {
    if (this.mode === 'simulate') {
      this.hasPosition = true;
      this.currentAmount = amountUsdc;
      this.entryPrice = currentPrice;
      this.lastFundingTime = Date.now();
      return { digest: 'simulated' };
    }

    if (!this.bluefinClient) throw new Error('Bluefin client not initialized');

    try {
      const marginBalance = await this.getMarginBalance();
      if (marginBalance < amountUsdc * 0.55) {
        await this.depositMargin(amountUsdc * 0.55);
      }

      let quantity = amountUsdc / currentPrice;
      
      // Bluefin SUI-PERP 最小注文ロット (通常10 SUI) を下回らないように強制補正
      if (quantity < 10.1) {
        Logger.warn(`⚠️ Bluefin size ${quantity.toFixed(2)} SUI is below min lot. Forcing to 10.1 SUI.`);
        quantity = 10.1;
      }
      
      const quantityRaw = this.safeBN(quantity).times(1e9).integerValue().toString();
      
      const response = await this.bluefinClient.createOrder({
        symbol: 'SUI-PERP',
        side: OrderSide.Short,
        type: OrderType.Market,
        quantityE9: quantityRaw, 
        priceE9: '0',
        leverageE9: this.safeBN(3).times(1e9).toString(), // 3x leverage allows for sufficient margin buffer on 10 SUI+ positions
        isIsolated: true,
        expiresAtMillis: Date.now() + 600000,
        clientOrderId: Date.now().toString(),
      });

      this.hasPosition = true;
      this.currentAmount = amountUsdc;
      this.entryPrice = currentPrice;
      this.lastFundingTime = Date.now();

      const digest = (response as any).hash || (response as any).digest || 'success';
      Logger.success(`✅ Bluefin: Short opened: ${digest}`);
      return { digest };
    } catch (e: any) {
      Logger.error(`Bluefin: Failed to open short: ${e.message}`);
      throw e;
    }
  }

  /**
   * ショートポジションを閉じる
   */
  async closeHedge(currentPrice: number): Promise<{ pnl: number, digest: string }> {
    if (!this.hasPosition) return { pnl: 0, digest: '' };

    let pnl = this.calculateCurrentPnl(currentPrice);
    let digest = 'simulated';

    if (this.mode === 'bluefin' && this.bluefinClient) {
      try {
        const detailsRes = await this.bluefinClient.accountDataApi.getAccountDetails(
          undefined, 
          this.getAuthHeaders()
        );
        const details = (detailsRes as any).data || detailsRes;
        const suiPos = (details.positions || []).find((p: any) => p.symbol === 'SUI-PERP' || p.symbol === 'SUI-P');

        if (suiPos) {
          const response = await this.bluefinClient.createOrder({
            symbol: suiPos.symbol,
            side: OrderSide.Long,
            type: OrderType.Market,
            quantityE9: suiPos.sizeE9, 
            priceE9: '0',
            leverageE9: this.safeBN(1).times(1e9).toString(),
            isIsolated: true,
            expiresAtMillis: Date.now() + 600000,
            clientOrderId: Date.now().toString(),
          });
          digest = (response as any).hash || (response as any).digest || 'success';
        }
      } catch (e: any) {
        Logger.error(`Bluefin: Failed to close hedge: ${e.message}`);
        return { pnl, digest }; // エラー時は状態を維持して抜ける
      }
    }

    this.cumulativePnl += pnl;
    this.hasPosition = false;
    this.currentAmount = 0;
    // entryPrice は履歴用に保持

    return { pnl, digest };
  }

  calculateCurrentPnl(currentPrice: number): number {
    if (!this.hasPosition || this.entryPrice <= 0) return 0;
    const priceChangeRatio = (this.entryPrice - currentPrice) / this.entryPrice;
    return this.currentAmount * priceChangeRatio;
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

  getStatus(currentPrice: number) {
    const currentPnl = this.calculateCurrentPnl(currentPrice);
    return {
      active: this.hasPosition,
      mode: this.mode,
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
      cumulativePnl: this.cumulativePnl,
    };
  }

  restore(data: any) {
    if (!data) return;
    this.hasPosition = data.hasPosition || false;
    this.currentAmount = data.currentAmount || 0;
    this.entryPrice = data.entryPrice || 0;
    this.cumulativePnl = data.cumulativePnl || 0;
  }
}
