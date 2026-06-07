import { Logger } from './logger.js';
import { LpManager } from './lpManager.js';
import { HedgeManager } from './hedgeManager.js';

export class RiskGuard {
  private consecutiveErrors = 0;
  private rebalanceTimestamps: number[] = [];

  constructor(
    private lpManager: LpManager,
    private hedgeManager: HedgeManager
  ) {}

  /**
   * 異常状態の検知
   * @returns { isEmergency: boolean; reason?: string } 緊急停止フラグと理由
   */
  async checkSafety(
    initialCapital: number,
    currentCapital: number,
    suiBalance: number
  ): Promise<{ isEmergency: boolean; reason?: string }> {
    
    // 1. 総資産減少率チェック (-30%以上)
    if (initialCapital > 0) {
      const lossPct = (initialCapital - currentCapital) / initialCapital;
      if (lossPct >= 0.30) {
        const msg = `[RISK_GUARD] 資産減少率が30%を超えました (現在: ${(lossPct*100).toFixed(1)}%減)。緊急停止を実行します。`;
        Logger.error(msg);
        return { isEmergency: true, reason: msg };
      }
    }

    // 2. 連続リバランスチェック (30分以内に5回以上)
    const now = Date.now();
    this.rebalanceTimestamps = this.rebalanceTimestamps.filter(t => now - t < 30 * 60 * 1000);
    if (this.rebalanceTimestamps.length >= 5) {
      const msg = `[RISK_GUARD] 30分以内に5回以上のリバランスが発生しました。過剰取引防止のため一時停止します。`;
      Logger.error(msg);
      return { isEmergency: true, reason: msg };
    }

    // 3. ガス残高不足 (SUI残高 < 0.1 SUI)
    if (suiBalance < 0.1) {
      Logger.warn(`[RISK_GUARD] SUI残高が 0.1 SUI を下回っています (現在: ${suiBalance.toFixed(4)} SUI)。ガス欠アラート。`);
    }

    // 4. APIエラー10回連続失敗 (約5分間の接続エラー)
    if (this.consecutiveErrors >= 10) {
      const msg = `[RISK_GUARD] API接続エラーが10回連続で発生しました。安全のため手動確認待ちモードへ移行します。`;
      Logger.error(msg);
      return { isEmergency: true, reason: msg };
    }

    return { isEmergency: false };
  }

  recordRebalance() {
    this.rebalanceTimestamps.push(Date.now());
  }

  recordError() {
    this.consecutiveErrors++;
  }

  resetErrors() {
    this.consecutiveErrors = 0;
  }
}
