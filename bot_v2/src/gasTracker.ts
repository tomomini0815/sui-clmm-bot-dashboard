import { Logger } from './logger.js';

/**
 * ガス代追跡モジュール
 * 
 * 各トランザクションのガス代を記録し、
 * リバランスの採算性を事前判定する。
 */
export class GasTracker {
  private totalGasSui: number = 0;
  private totalGasUsdc: number = 0;
  private txCount: number = 0;
  private gasHistory: Array<{ timestamp: number; gasSui: number; gasUsdc: number; txType: string }> = [];

  /**
   * トランザクション結果からガス代を抽出・記録
   */
  recordGas(effects: any, suiPriceUsdc: number, txType: string = 'unknown'): number {
    if (!effects?.gasUsed) return 0;

    const gasUsed = effects.gasUsed;
    // Sui のガスは computationCost + storageCost - storageRebate で計算
    const computationCost = BigInt(gasUsed.computationCost || '0');
    const storageCost = BigInt(gasUsed.storageCost || '0');
    const storageRebate = BigInt(gasUsed.storageRebate || '0');

    // MIST → SUI 変換 (1 SUI = 10^9 MIST)
    const totalGasMist = computationCost + storageCost - storageRebate;
    const gasSui = Number(totalGasMist) / 1e9;
    const gasUsdc = gasSui * suiPriceUsdc;

    this.totalGasSui += gasSui;
    this.totalGasUsdc += gasUsdc;
    this.txCount++;

    this.gasHistory.push({
      timestamp: Date.now(),
      gasSui,
      gasUsdc,
      txType,
    });

    // 直近100件のみ保持
    if (this.gasHistory.length > 100) {
      this.gasHistory.shift();
    }

    Logger.info(`⛽ ガス代: ${gasSui.toFixed(6)} SUI ($${gasUsdc.toFixed(4)}) [${txType}]`);
    return gasUsdc;
  }

  /**
   * 平均ガス代を取得（USDC建て）
   */
  getAvgGasUsdc(): number {
    if (this.txCount === 0) return 0.005; // デフォルト推定 $0.005
    return this.totalGasUsdc / this.txCount;
  }

  /**
   * リバランスが採算的に実行する価値があるか事前チェック
   * 
   * @param estimatedFeeRevenue 推定手数料収入 (USDC)
   * @param rebalanceTxCount リバランスに必要なTX数 (通常3: remove + add + hedge)
   */
  isRebalanceProfitable(estimatedFeeRevenue: number, rebalanceTxCount: number = 3): boolean {
    const estimatedGasCost = this.getAvgGasUsdc() * rebalanceTxCount;
    const netProfit = estimatedFeeRevenue - estimatedGasCost;
    
    if (netProfit <= 0) {
      Logger.info(`❌ リバランス非推奨: 推定利益 $${estimatedFeeRevenue.toFixed(4)} < ガス代 $${estimatedGasCost.toFixed(4)}`);
      return false;
    }

    Logger.info(`✅ リバランス推奨: 推定純利益 $${netProfit.toFixed(4)} (手数料 $${estimatedFeeRevenue.toFixed(4)} - ガス $${estimatedGasCost.toFixed(4)})`);
    return true;
  }

  /**
   * 統計情報を取得
   */
  getStats() {
    return {
      totalGasSui: Number(this.totalGasSui.toFixed(6)),
      totalGasUsdc: Number(this.totalGasUsdc.toFixed(4)),
      txCount: this.txCount,
      avgGasPerTx: Number(this.getAvgGasUsdc().toFixed(4)),
    };
  }

  /**
   * 直近N件のガス代合計 (USDC)
   */
  getRecentGasUsdc(n: number = 10): number {
    const recent = this.gasHistory.slice(-n);
    return recent.reduce((sum, entry) => sum + entry.gasUsdc, 0);
  }
}
