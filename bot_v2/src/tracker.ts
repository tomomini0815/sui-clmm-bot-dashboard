import fs from 'fs/promises';
import path from 'path';
import Table from 'cli-table3';
import chalk from 'chalk';
import { Logger } from './logger.js';

const TRACKER_FILE = path.resolve(process.cwd(), 'tracker_data.json');

export interface TrackerData {
  rebalanceCount: number;
  totalFeesEarned: number;
  pnlTotal: number;
  entryPrice: number; // エントリー価格
  currentPrice: number; // 現在価格
  positionSize: number; // ポジションサイズ
  successfulRebalances: number; // 成功したリバランス数
  history: Array<{
    timestamp: string;
    price: number;
    pnl: number;
    fee: number;
    txDigest?: string;
    details?: string;
  }>;
}

export class Tracker {
  private static data: TrackerData = {
    rebalanceCount: 0,
    totalFeesEarned: 0,
    pnlTotal: 0,
    entryPrice: 0,
    currentPrice: 0,
    positionSize: 0,
    successfulRebalances: 0,
    history: [],
  };

  static async init() {
    try {
      const content = await fs.readFile(TRACKER_FILE, 'utf-8');
      this.data = JSON.parse(content);
      Logger.info('Prior tracking data loaded.');
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        Logger.info('No prior tracking data found. Starting fresh.');
        await this.save();
      } else {
        Logger.warn('Failed to parse tracker data, initializing empty tracking info.');
      }
    }
  }

  private static async save() {
    try {
      await fs.writeFile(TRACKER_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) {
      Logger.error('Failed to save tracking data', e);
    }
  }

  static async recordRebalance(price: number, pnl: number, feeCollected: number, txDigest?: string, details?: string) {
    this.data.rebalanceCount++;
    this.data.totalFeesEarned += feeCollected;
    this.data.pnlTotal += pnl;
    this.data.entryPrice = price; // エントリー価格を更新
    this.data.currentPrice = price;
    
    // 手数料が取得できていたら成功としてカウント
    if (feeCollected > 0) {
      this.data.successfulRebalances++;
    }
    
    this.data.history.push({
      timestamp: new Date().toISOString(),
      price,
      pnl,
      fee: feeCollected,
      txDigest,
      details: details || (feeCollected > 0 ? `手数料 +${feeCollected.toFixed(4)} USDC` : 'リバランス実行')
    });
    
    if (this.data.history.length > 100) {
      this.data.history.shift();
    }

    await this.save();
  }

  static async recordFee(feeCollected: number) {
    if (feeCollected > 0) {
      this.data.totalFeesEarned += feeCollected;
      await this.save();
    }
  }

  static updateCurrentPrice(price: number) {
    this.data.currentPrice = price;
  }

  static setConfig(config: { lpAmountUsdc: number }) {
    this.data.positionSize = config.lpAmountUsdc;
  }

  static getStats() {
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
      history: this.data.history.map(h => ({
        time: new Date(h.timestamp).toLocaleTimeString('ja-JP', { hour12: false }),
        action: 'Rebalance',
        price: h.price,
        range: '-',
        fee: h.fee > 0 ? h.fee.toFixed(4) : undefined,
        status: h.fee > 0 ? `+${h.fee.toFixed(2)}` : 'Success',
        details: h.details,
        txDigest: h.txDigest
      }))
    };
  }

  static showStats() {
// ... existing code ...
    const table = new Table({
      head: [
        chalk.cyan('Rebalance Count'),
        chalk.cyan('Total Fees (USDC)'),
        chalk.cyan('Total P&L (USDC)'),
        chalk.cyan('Win Rate'),
      ],
      style: { head: [], border: [] }
    });

    const winRate = this.data.rebalanceCount > 0 
      ? (this.data.successfulRebalances / this.data.rebalanceCount * 100).toFixed(1)
      : '0.0';

    table.push([
      this.data.rebalanceCount.toString(),
      this.data.totalFeesEarned.toFixed(4),
      chalk[this.data.pnlTotal >= 0 ? 'green' : 'redBright'](this.data.pnlTotal.toFixed(4)),
      `${winRate}%`
    ]);

    console.log('\n' + table.toString() + '\n');
  }
}
