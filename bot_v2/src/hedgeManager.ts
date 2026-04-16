import { Logger } from './logger.js';

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

  // 設定
  private readonly SIMULATED_FUNDING_RATE_8H = 0.0001; // 8時間ごとの Funding Rate (0.01%)
  
  constructor(mode: 'simulate' | 'bluefin' = 'simulate') {
    this.mode = mode;
    Logger.info(`HedgeManager: モード = ${mode}`);
  }

  async hasExistingHedge(): Promise<boolean> {
    Logger.info('Checking existing short (hedge) positions...');
    return this.hasPosition;
  }

  /**
   * ショートポジションを開く（シミュレーション）
   */
  async openHedge(amountUsdc: number, currentPrice: number): Promise<void> {
    Logger.startSpin(`Opening Short Position for $${amountUsdc.toFixed(2)} at $${currentPrice.toFixed(4)}...`);

    if (this.mode === 'simulate') {
      // シミュレーション: 即座にポジション記録
      this.hasPosition = true;
      this.currentAmount = amountUsdc;
      this.entryPrice = currentPrice;
      this.lastFundingTime = Date.now();

      Logger.stopSpin(`📊 [SIM] ショートポジション $${amountUsdc.toFixed(2)} @ $${currentPrice.toFixed(4)} を開設（シミュレーション）`);
    } else {
      // Bluefin SDK統合 (Phase 2)
      // TODO: @bluefin-exchange/pro-sdk を使用した実装
      Logger.stopSpin('Bluefin SDK not yet integrated. Using simulation.');
      this.hasPosition = true;
      this.currentAmount = amountUsdc;
      this.entryPrice = currentPrice;
      this.lastFundingTime = Date.now();
    }
  }

  /**
   * ショートポジションを閉じる（シミュレーション）
   */
  async closeHedge(currentPrice: number): Promise<{ pnl: number }> {
    if (!this.hasPosition) return { pnl: 0 };

    Logger.startSpin(`Closing Short Position of $${this.currentAmount.toFixed(2)}...`);

    // PnLを計算
    const pnl = this.calculateCurrentPnl(currentPrice);
    this.cumulativePnl += pnl;

    // Funding コスト精算
    this.settleFunding();

    const closedAmount = this.currentAmount;
    this.hasPosition = false;
    this.currentAmount = 0;
    this.entryPrice = 0;

    Logger.stopSpin(`📊 [SIM] ショート決済: PnL = ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} (累積: $${this.cumulativePnl.toFixed(4)})`);
    return { pnl };
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
}
