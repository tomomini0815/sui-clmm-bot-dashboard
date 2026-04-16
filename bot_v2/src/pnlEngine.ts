import { Logger } from './logger.js';

/**
 * リアルタイムPnL計算エンジン
 * 
 * LP損益 + ヘッジ損益 - ガス代 = 純利益
 * APR/日次収益率も計算
 */
export class PnlEngine {
  // LP側
  private lpEntryValue: number = 0;       // エントリー時のLP USDC価値
  private lpEntryPrice: number = 0;       // エントリー時のSUI価格
  private lpEntryTime: number = 0;        // エントリー時刻
  private totalFeesCollected: number = 0; // 累積手数料(USDC)

  // ヘッジ側
  private hedgeEntryPrice: number = 0;    // ヘッジ（ショート）エントリー価格
  private hedgeSize: number = 0;          // ヘッジサイズ($USDC建て)
  private hedgePnl: number = 0;           // ヘッジ累積PnL
  private simulatedFundingCost: number = 0; // シミュレーション: Funding Rate累積コスト

  // ガス
  private totalGasCost: number = 0;       // 累積ガス代(USDC)

  // 日次追跡
  private dailySnapshots: Array<{
    date: string;
    netPnl: number;
    fees: number;
    gasCost: number;
    lpPnl: number;
    hedgePnl: number;
  }> = [];
  private lastSnapshotDate: string = '';

  /**
   * LPポジション新規エントリーを記録
   */
  recordLpEntry(entryPrice: number, lpValueUsdc: number) {
    this.lpEntryValue = lpValueUsdc;
    this.lpEntryPrice = entryPrice;
    this.lpEntryTime = Date.now();
    Logger.info(`📊 PnL: LPエントリー記録 - 価格: $${entryPrice.toFixed(4)}, 価値: $${lpValueUsdc.toFixed(4)}`);
  }

  /**
   * ヘッジポジションエントリーを記録
   */
  recordHedgeEntry(entryPrice: number, sizeUsdc: number) {
    this.hedgeEntryPrice = entryPrice;
    this.hedgeSize = sizeUsdc;
    this.hedgePnl = 0;
    Logger.info(`📊 PnL: ヘッジエントリー記録 - 価格: $${entryPrice.toFixed(4)}, サイズ: $${sizeUsdc.toFixed(4)}`);
  }

  /**
   * 手数料回収を記録
   */
  recordFee(feeUsdc: number) {
    this.totalFeesCollected += feeUsdc;
  }

  /**
   * ガス代を記録
   */
  recordGas(gasUsdc: number) {
    this.totalGasCost += gasUsdc;
  }

  /**
   * LP側のPnLを計算
   * 
   * CLMMのLP価値は、価格変動による Impermanent Loss を含む。
   * 簡易計算: IL ≈ 2 * sqrt(priceRatio) / (1 + priceRatio) - 1
   */
  calculateLpPnl(currentPrice: number): number {
    if (this.lpEntryPrice <= 0 || this.lpEntryValue <= 0) return 0;

    const priceRatio = currentPrice / this.lpEntryPrice;
    
    // Impermanent Loss 計算（集中流動性用の近似）
    // CLMMの場合はレンジの幅に依存するが、簡易版としてUniswap v2のIL公式を使用
    const ilFactor = 2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1;
    
    // LP価値 = エントリー価値 × (1 + IL) × 平均(1, priceRatio)
    // ※ 50:50 split の場合の近似
    const holdValue = this.lpEntryValue * (1 + priceRatio) / 2;
    const lpValue = holdValue * (1 + ilFactor);
    
    return lpValue - this.lpEntryValue;
  }

  /**
   * ヘッジ（ショート）PnLを計算
   * 
   * ショートなので価格下落 → 利益、価格上昇 → 損失
   */
  calculateHedgePnl(currentPrice: number): number {
    if (this.hedgeEntryPrice <= 0 || this.hedgeSize <= 0) return 0;

    // ショートPnL: サイズ × (エントリー価格 - 現在価格) / エントリー価格
    const priceChange = (this.hedgeEntryPrice - currentPrice) / this.hedgeEntryPrice;
    return this.hedgeSize * priceChange;
  }

  /**
   * シミュレーション: Funding Rate コスト
   * 
   * Perp市場では通常8時間ごとにFunding Rate支払いがある
   * 平均年率 -5% ～ +15% 想定（ショート側がもらう場合もある）
   * ここでは控えめに年率 -3%（ショート側がコスト負担）で計算
   */
  calculateSimulatedFundingCost(): number {
    if (this.lpEntryTime <= 0 || this.hedgeSize <= 0) return 0;

    const elapsedMs = Date.now() - this.lpEntryTime;
    const elapsedYears = elapsedMs / (365.25 * 24 * 60 * 60 * 1000);
    const annualFundingRate = -0.03; // 年率-3%（ショート側コスト）
    
    return this.hedgeSize * annualFundingRate * elapsedYears;
  }

  /**
   * 総合PnLを計算
   */
  calculateNetPnl(currentPrice: number): {
    lpPnl: number;
    hedgePnl: number;
    fees: number;
    gasCost: number;
    fundingCost: number;
    netPnl: number;
    apr: number;
    dailyPnl: number;
    elapsedHours: number;
  } {
    const lpPnl = this.calculateLpPnl(currentPrice);
    const hedgePnl = this.calculateHedgePnl(currentPrice);
    const fundingCost = this.calculateSimulatedFundingCost();

    const netPnl = lpPnl + hedgePnl + this.totalFeesCollected - this.totalGasCost + fundingCost;

    // 経過時間
    const elapsedMs = this.lpEntryTime > 0 ? Date.now() - this.lpEntryTime : 0;
    const elapsedHours = elapsedMs / (1000 * 60 * 60);
    const elapsedDays = elapsedHours / 24;

    // APR計算
    let apr = 0;
    if (this.lpEntryValue > 0 && elapsedDays > 0) {
      const dailyReturn = netPnl / this.lpEntryValue / elapsedDays;
      apr = dailyReturn * 365 * 100;
    }

    // 日次PnL
    const dailyPnl = elapsedDays > 0 ? netPnl / elapsedDays : 0;

    // 日次スナップショット
    this.tryDailySnapshot(currentPrice, lpPnl, hedgePnl);

    return {
      lpPnl: Number(lpPnl.toFixed(4)),
      hedgePnl: Number(hedgePnl.toFixed(4)),
      fees: Number(this.totalFeesCollected.toFixed(4)),
      gasCost: Number(this.totalGasCost.toFixed(4)),
      fundingCost: Number(fundingCost.toFixed(4)),
      netPnl: Number(netPnl.toFixed(4)),
      apr: Number(apr.toFixed(2)),
      dailyPnl: Number(dailyPnl.toFixed(4)),
      elapsedHours: Number(elapsedHours.toFixed(1)),
    };
  }

  /**
   * デルタ（方向性リスク）を計算
   * 
   * Delta = LP側のデルタ - ヘッジ側のデルタ
   * LPのデルタはおよそ0.5（50:50ポジション）
   * ヘッジのデルタは -hedgeRatio
   * 
   * 完全にニュートラル = 0
   */
  calculateDelta(hedgeRatio: number): {
    current: number;
    hedgeActive: boolean;
    hedgeSize: number;
    recommendation: string;
  } {
    const lpDelta = 0.5; // LP は約50%のSUIエクスポージャー
    const hedgeDelta = hedgeRatio; // ヘッジ比率
    const netDelta = lpDelta - hedgeDelta;

    let recommendation: string;
    const absDelta = Math.abs(netDelta);

    if (absDelta < 0.05) {
      recommendation = '✅ ほぼ完全なニュートラル';
    } else if (absDelta < 0.15) {
      recommendation = '🟡 軽微な偏り — 許容範囲内';
    } else if (absDelta < 0.3) {
      recommendation = '🟠 偏りあり — ヘッジ調整推奨';
    } else {
      recommendation = '🔴 大きな偏り — 即座のヘッジ調整が必要';
    }

    return {
      current: Number(netDelta.toFixed(3)),
      hedgeActive: this.hedgeSize > 0,
      hedgeSize: Number(this.hedgeSize.toFixed(2)),
      recommendation,
    };
  }

  /**
   * 日次スナップショットの記録
   */
  private tryDailySnapshot(currentPrice: number, lpPnl: number, hedgePnl: number) {
    const today = new Date().toISOString().split('T')[0];
    if (today === this.lastSnapshotDate) return;

    this.lastSnapshotDate = today;
    this.dailySnapshots.push({
      date: today,
      netPnl: lpPnl + hedgePnl + this.totalFeesCollected - this.totalGasCost,
      fees: this.totalFeesCollected,
      gasCost: this.totalGasCost,
      lpPnl,
      hedgePnl,
    });

    // 最大90日のヒストリーを保持
    if (this.dailySnapshots.length > 90) {
      this.dailySnapshots.shift();
    }
  }

  /**
   * 日次スナップショットを取得（フロントエンド用）
   */
  getDailySnapshots() {
    return [...this.dailySnapshots];
  }

  /**
   * セッション間で状態を復元するためのシリアライズ
   */
  serialize() {
    return {
      lpEntryValue: this.lpEntryValue,
      lpEntryPrice: this.lpEntryPrice,
      lpEntryTime: this.lpEntryTime,
      totalFeesCollected: this.totalFeesCollected,
      hedgeEntryPrice: this.hedgeEntryPrice,
      hedgeSize: this.hedgeSize,
      totalGasCost: this.totalGasCost,
      dailySnapshots: this.dailySnapshots,
    };
  }

  /**
   * シリアライズされた状態から復元
   */
  restore(data: any) {
    if (!data) return;
    this.lpEntryValue = data.lpEntryValue || 0;
    this.lpEntryPrice = data.lpEntryPrice || 0;
    this.lpEntryTime = data.lpEntryTime || 0;
    this.totalFeesCollected = data.totalFeesCollected || 0;
    this.hedgeEntryPrice = data.hedgeEntryPrice || 0;
    this.hedgeSize = data.hedgeSize || 0;
    this.totalGasCost = data.totalGasCost || 0;
    this.dailySnapshots = data.dailySnapshots || [];
    Logger.info(`📊 PnL: 前回データ復元 - 累積手数料: $${this.totalFeesCollected.toFixed(4)}, ガス代: $${this.totalGasCost.toFixed(4)}`);
  }
}
