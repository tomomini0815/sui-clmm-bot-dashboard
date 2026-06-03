import { Logger } from './logger.js';
import { BotState } from './stateManager.js';

export class RebalanceEngine {
  
  /**
   * 仕様書 4.2 に基づく動的レンジ調整
   * @param state 現在のボット状態
   * @returns 新しい片側レンジ幅 (例: 0.10 => ±10%)
   */
  static calculateNewRangeWidth(state: BotState): number {
    const now = Date.now();
    
    // 24時間以内のリバランス回数
    const count24h = (state.rebalanceHistory || []).filter(
      t => now - t < 24 * 60 * 60 * 1000
    ).length;

    // 72時間 (3日) 以内のリバランス回数
    const count72h = (state.rebalanceHistory || []).filter(
      t => now - t < 3 * 24 * 60 * 60 * 1000
    ).length;

    let newWidth = state.rangeWidth;

    if (count24h > 3) {
      // 1日3回超えでレンジ幅を+2.5%広げる
      newWidth = Math.min(0.20, state.rangeWidth + 0.025); // 上限±20%
      Logger.info(`[REBALANCE_ENGINE] 24hリバランス回数(${count24h}回)が3回を超えたため、レンジを拡大します: ±${(state.rangeWidth*100).toFixed(1)}% → ±${(newWidth*100).toFixed(1)}%`);
    } else if (count72h < 1) {
      // 3日で1回未満ならレンジ幅を-2.5%狭める
      newWidth = Math.max(0.05, state.rangeWidth - 0.025); // 下限±5%
      Logger.info(`[REBALANCE_ENGINE] 72hリバランス回数(${count72h}回)が3日未満で0回のため、レンジを縮小します: ±${(state.rangeWidth*100).toFixed(1)}% → ±${(newWidth*100).toFixed(1)}%`);
    } else {
      Logger.info(`[REBALANCE_ENGINE] レンジ幅を維持します: ±${(state.rangeWidth*100).toFixed(1)}% (24h回数: ${count24h}, 72h回数: ${count72h})`);
    }

    return newWidth;
  }

  /**
   * クールダウンチェック（5分間）
   */
  static isCooldown(lastRebalanceAt: number, cooldownMin: number = 5): boolean {
    const elapsedMs = Date.now() - lastRebalanceAt;
    const cooldownMs = cooldownMin * 60 * 1000;
    return elapsedMs < cooldownMs;
  }
}
