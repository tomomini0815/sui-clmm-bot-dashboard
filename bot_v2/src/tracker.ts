import fs from 'fs/promises';
import path from 'path';
import Table from 'cli-table3';
import chalk from 'chalk';
import { Logger } from './logger.js';

export interface TrackerData {
  rebalanceCount: number;
  totalFeesEarned: number;
  pnlTotal: number;
  entryPrice: number;
  currentPrice: number;
  positionSize: number;
  successfulRebalances: number;
  balanceHistory: Array<{
    timestamp: string;
    suiBalance: number;
    usdcBalance: number;
    bluefinMargin: number;
    totalValueUsdc: number;
  }>;
  history: Array<{
    timestamp: string;
    price: number;
    pnl: number;
    fee: number;
    lowerBound?: number;
    upperBound?: number;
    txDigest?: string;
    details?: string;
    action?: string;
  }>;
}

export class Tracker {
  private data: TrackerData = {
    rebalanceCount: 0,
    totalFeesEarned: 0,
    pnlTotal: 0,
    entryPrice: 0,
    currentPrice: 0,
    positionSize: 0,
    successfulRebalances: 0,
    balanceHistory: [],
    history: [],
  };

  private filePath: string;
  private lastSaveTime: number = 0;
  private readonly SAVE_INTERVAL_MS = 60 * 1000; // 1分ごとに保存
  private lastBalanceSnapshotTime: number = 0;
  private readonly BALANCE_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000; // 10分ごとに残高スナップショット

  constructor(private sessionId: string) {
    this.filePath = path.resolve(process.cwd(), `tracker_${this.sessionId}.json`);
  }

  async init() {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.data = JSON.parse(content);
      
      // バランス履歴のマイグレーション
      if (!this.data.balanceHistory) {
        this.data.balanceHistory = [];
      }
      
      Logger.info(`Tracker initialized for session ${this.sessionId}`);
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        Logger.info(`New tracker created for session ${this.sessionId}`);
        await this.save();
      } else {
        Logger.warn(`Failed to parse tracker data for ${this.sessionId}, starting fresh.`);
      }
    }
  }

  private async save() {
    try {
      await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) {
      Logger.error(`Failed to save tracking data for ${this.sessionId}`, e);
    }
  }

  /**
   * 残高履歴を記録
   */
  async recordBalance(sui: number, usdc: number, bluefinMargin: number, totalValue: number, price: number) {
    const now = Date.now();
    
    // インターバル判定 (または初回)
    if (now - this.lastBalanceSnapshotTime >= this.BALANCE_SNAPSHOT_INTERVAL_MS || this.data.balanceHistory.length === 0) {
      this.data.balanceHistory.push({
        timestamp: new Date().toISOString(),
        suiBalance: sui,
        usdcBalance: usdc,
        bluefinMargin: bluefinMargin,
        totalValueUsdc: totalValue
      });
      
      this.data.currentPrice = price;

      // 履歴制限 (約1週間分 = 144 snapshot / day * 7 = 1008)
      if (this.data.balanceHistory.length > 1000) {
        this.data.balanceHistory.shift();
      }

      this.lastBalanceSnapshotTime = now;
      await this.save();
      Logger.info(`📈 資産スナップショットを記録しました: $${totalValue.toFixed(2)} (SUI: ${sui.toFixed(2)}, USDC: ${usdc.toFixed(2)}, Bluefin: ${bluefinMargin.toFixed(2)})`);
    }
  }

  async recordRebalance(
    price: number,
    pnl: number,
    feeCollected: number,
    txDigest?: string,
    details?: string,
    lowerBound?: number,
    upperBound?: number,
    action?: string
  ) {
    this.data.rebalanceCount++;
    this.data.totalFeesEarned += feeCollected;
    this.data.pnlTotal += pnl;
    this.data.entryPrice = price;
    this.data.currentPrice = price;

    if (feeCollected > 0) {
      this.data.successfulRebalances++;
    }

    this.data.history.push({
      timestamp: new Date().toISOString(),
      price,
      pnl,
      fee: feeCollected,
      lowerBound,
      upperBound,
      txDigest,
      action: action || 'リバランス',
      details: details || (feeCollected > 0 ? `手数料 +${feeCollected.toFixed(4)} USDC` : 'リバランス実行')
    });

    if (this.data.history.length > 200) {
      this.data.history.shift();
    }

    await this.save();
  }

  async recordFee(feeCollected: number, txDigest?: string) {
    if (feeCollected > 0) {
      this.data.totalFeesEarned += feeCollected;
      this.data.history.push({
        timestamp: new Date().toISOString(),
        price: this.data.currentPrice,
        pnl: 0,
        fee: feeCollected,
        action: '手数料回収',
        lowerBound: undefined,
        upperBound: undefined,
        txDigest,
        details: `手数料回収: +${feeCollected.toFixed(4)} USDC`
      });
      if (this.data.history.length > 200) {
        this.data.history.shift();
      }
      await this.save();
    }
  }

  async recordEvent(action: string, details: string, price?: number, txDigest?: string) {
    this.data.history.push({
      timestamp: new Date().toISOString(),
      price: price ?? this.data.currentPrice,
      pnl: 0,
      fee: 0,
      action,
      lowerBound: undefined,
      upperBound: undefined,
      txDigest,
      details
    });
    if (this.data.history.length > 200) {
      this.data.history.shift();
    }
    await this.save();
  }

  async recordHedge(action: string, details: string, price: number, size: number, txDigest?: string) {
    this.data.history.push({
      timestamp: new Date().toISOString(),
      price,
      pnl: 0,
      fee: 0,
      action: `ヘッジ:${action}`,
      txDigest,
      details: `${details} (Size: ${size.toFixed(4)} SUI)`
    });
    if (this.data.history.length > 200) {
      this.data.history.shift();
    }
    await this.save();
  }

  /**
   * 価格とPnLの定期的更新（1分以上の間隔で自動保存）
   */
  async update(price: number, pnl: number) {
    this.data.currentPrice = price;
    this.data.pnlTotal = pnl; // ストラテジーから渡された最新の純利益（LP + ヘッジ + 手数料）を反映
    
    const now = Date.now();
    if (now - this.lastSaveTime > this.SAVE_INTERVAL_MS) {
      await this.save();
      this.lastSaveTime = now;
    }
  }

  /**
   * @deprecated update(price, pnl) を使用してください
   */
  updateCurrentPrice(price: number) {
    this.data.currentPrice = price;
  }

  setConfig(config: { totalOperationalCapitalUsdc?: number; lpAmountUsdc?: number }) {
    this.data.positionSize = config.totalOperationalCapitalUsdc || config.lpAmountUsdc || 0;
  }

  getStats() {
    const priceChange = this.data.entryPrice > 0 
      ? ((this.data.currentPrice - this.data.entryPrice) / this.data.entryPrice * 100) 
      : 0;
    
    const winRate = this.data.rebalanceCount > 0 
      ? (this.data.successfulRebalances / this.data.rebalanceCount * 100) 
      : 0;

    return {
      totalPnl: this.data.pnlTotal.toFixed(2),
      totalFees: this.data.totalFeesEarned.toFixed(4),
      totalRebalances: this.data.rebalanceCount,
      currentPrice: this.data.currentPrice,
      entryPrice: this.data.entryPrice,
      positionSize: this.data.positionSize,
      priceChangePercent: priceChange.toFixed(2),
      winRate: winRate.toFixed(1),
      balanceHistory: this.data.balanceHistory.map(b => ({
        ...b,
        time: new Date(b.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
        date: new Date(b.timestamp).toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' })
      })),
      history: [...this.data.history].reverse().map(h => ({
        time: new Date(h.timestamp).toLocaleTimeString('ja-JP', { hour12: false }),
        date: new Date(h.timestamp).toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' }),
        action: h.action || 'リバランス',
        price: h.price,
        range: (h.lowerBound && h.upperBound)
          ? `${h.lowerBound.toFixed(4)} 〜 ${h.upperBound.toFixed(4)}`
          : '-',
        fee: h.fee > 0 ? h.fee.toFixed(4) : undefined,
        status: (h.action?.includes('失敗') || h.details?.includes('失敗')) 
          ? '失敗' 
          : (h.fee > 0 ? `+${h.fee.toFixed(2)}` : '完了'),
        details: h.details,
        txDigest: h.txDigest
      }))
    };
  }

  /**
   * データのシリアライズ（保存用）
   */
  serialize(): TrackerData {
    return { ...this.data };
  }

  /**
   * データの復元
   */
  restore(data: any): void {
    if (!data) return;
    this.data = {
      ...this.data,
      ...data,
      history: data.history || this.data.history
    };
    Logger.info(`Tracker data restored (Rebalances: ${this.data.rebalanceCount})`);
  }
}
