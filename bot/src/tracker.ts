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
  history: Array<{
    timestamp: string;
    price: number;
    pnl: number;
    fee: number;
  }>;
}

export class Tracker {
  private static data: TrackerData = {
    rebalanceCount: 0,
    totalFeesEarned: 0,
    pnlTotal: 0,
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

  static async recordRebalance(price: number, pnl: number, feeCollected: number) {
    this.data.rebalanceCount++;
    this.data.totalFeesEarned += feeCollected;
    this.data.pnlTotal += pnl;
    this.data.history.push({
      timestamp: new Date().toISOString(),
      price,
      pnl,
      fee: feeCollected,
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

  static showStats() {
    const table = new Table({
      head: [
        chalk.cyan('Rebalance Count'),
        chalk.cyan('Total Fees (USDC)'),
        chalk.cyan('Total P&L (USDC)'),
      ],
      style: { head: [], border: [] }
    });

    table.push([
      this.data.rebalanceCount.toString(),
      this.data.totalFeesEarned.toFixed(4),
      chalk[this.data.pnlTotal >= 0 ? 'green' : 'redBright'](this.data.pnlTotal.toFixed(4)),
    ]);

    console.log('\n' + table.toString() + '\n');
  }
}
