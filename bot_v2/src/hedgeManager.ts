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
  
  constructor(mode: 'simulate' | 'bluefin' = 'simulate') {
    this.mode = mode;
    Logger.info(`HedgeManager: モード = ${mode}`);
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
      
      this.bluefinClient = new BluefinProSdk(signer, network as any, suiClient as any);
      await this.bluefinClient.initialize();
      
      Logger.success('Bluefin SDK initialized successfully.');
    } catch (e: any) {
      Logger.error(`Bluefin initialization failed: ${e.message}`);
      this.mode = 'simulate'; // 失敗した場合はシミュレーションにフォールバック
    }
  }

  async hasExistingHedge(): Promise<boolean> {
    if (this.mode === 'bluefin' && this.bluefinClient) {
      const details = await this.bluefinClient.accountDataApi.getAccountDetails();
      const positions = (details as any).positionDetails || [];
      return positions.some((p: any) => p.symbol === 'SUI-PERP');
    }
    return this.hasPosition;
  }

  /**
   * Bluefin サブアカウントに証拠金を入金する
   */
  async depositMargin(amountUsdc: number): Promise<{ digest: string }> {
    if (this.mode === 'simulate' || !this.bluefinClient) return { digest: 'simulated' };

    try {
      Logger.info(`Bluefin: Depositing $${amountUsdc.toFixed(2)} USDC as margin...`);
      
      const amountRaw = new BigNumber(amountUsdc).times(1e6).integerValue().toString();
      
      // @ts-ignore - Pro SDK v1 internal API
      const bankResponse = await (this.bluefinClient as any).transactionApi.postDeposit({
        amount: amountRaw,
        symbol: 'USDC'
      });

      Logger.info(`✅ Bluefin: 証拠金入金完了。Digest: ${bankResponse.hash}`);
      return { digest: bankResponse.hash };
    } catch (e: any) {
      Logger.error(`❌ Bluefin: 入金失敗: ${e.message}`);
      throw e;
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
        const details = await this.bluefinClient.accountDataApi.getAccountDetails();
        const marginBalance = new BigNumber((details as any).totalMarginBalance || 0).dividedBy(1e6).toNumber();
        
        // 必要な担保額（ポジションサイズの50%以上を推奨）
        if (marginBalance < amountUsdc * 0.5) {
          Logger.info(`Bluefin: 残高不足 ($${marginBalance.toFixed(2)})。自動補充を実行します...`);
          await this.depositMargin(amountUsdc); // 指定されたヘッジ割り当て額を入金
        }

        // 50%デルタヘッジ用に数量を計算 (amountUsdc / currentPrice)
        const quantity = amountUsdc / currentPrice;
        
        // 数量の単位調整 (SDKの仕様に合わせる e.g. 1e9)
        const quantityRaw = new BigNumber(quantity).times(1e9).integerValue().toString();

        Logger.info(`Bluefin: Placing Market SHORT order for ${quantity.toFixed(4)} SUI ($${amountUsdc.toFixed(2)})`);
        
        const response = await (this.bluefinClient as any).tradeApi.postCreateOrder({
          symbol: market,
          side: OrderSide.Short,
          type: OrderType.Market,
          quantity: quantityRaw,
          price: '0',
          timeInForce: OrderTimeInForce.Ioc,
          clientOrderId: Date.now().toString(),
        });

        this.hasPosition = true;
        this.currentAmount = amountUsdc;
        this.entryPrice = currentPrice;
        this.lastFundingTime = Date.now();

        Logger.stopSpin(`✅ Bluefin: ショートポジションを開設しました。Digest: ${response.hash}`);
        return { digest: response.hash };
      } catch (e: any) {
        Logger.stopSpin(`❌ Bluefin: ショート開設に失敗しました: ${e.message}`);
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
        const details = await this.bluefinClient.accountDataApi.getAccountDetails();
        const positions = (details as any).positionDetails || [];
        const suiPos = positions.find((p: any) => p.symbol === 'SUI-PERP');

        if (suiPos) {
          const qty = suiPos.quantity; 
          
          Logger.info(`Bluefin: Closing position with opposite order (BUY)...`);
          const response = await (this.bluefinClient as any).tradeApi.postCreateOrder({
            symbol: 'SUI-PERP',
            side: OrderSide.Long,
            type: OrderType.Market,
            quantity: qty,
            price: '0',
            timeInForce: OrderTimeInForce.Ioc,
            clientOrderId: Date.now().toString(),
          });
          digest = response.hash;
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
      const details = await this.bluefinClient.accountDataApi.getAccountDetails();
      const marginBalance = new BigNumber((details as any).totalMarginBalance || 0).dividedBy(1e6).toNumber();
      this.lastMarginBalance = marginBalance;
      
      // メンテナンスマージン（維持証拠金）の閾値
      // 理想は50%だが、急な価格変動を考慮して、40%を下回ったら補充するようにする
      const requiredMargin = this.currentAmount * 0.5;
      const minThreshold = this.currentAmount * 0.4;

      if (marginBalance < minThreshold) {
        Logger.warn(`⚠️ Bluefin: 証拠金維持率低下 ($${marginBalance.toFixed(2)} < $${minThreshold.toFixed(2)})。自動補充を実行します。`);
        
        // 足りない分ではなく、目標維持額(50%)まで補充し、プラスアルファでバッファを持たせる
        const topUpAmount = requiredMargin - marginBalance + (this.currentAmount * 0.1);
        await this.depositMargin(Math.max(10, topUpAmount)); // 最低10ドル単位で補充
        
        Logger.success(`✅ Bluefin: 証拠金を補充しました。`);
      } else {
        // 定期的なステータスログ
        const ratio = (marginBalance / (this.currentAmount || 1) * 100).toFixed(1);
        Logger.info(`📊 Bluefin維持証拠金: $${marginBalance.toFixed(2)} (${ratio}%)`);
      }
    } catch (e: any) {
      Logger.error(`❌ Bluefin証拠金チェック失敗: ${e.message}`);
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
