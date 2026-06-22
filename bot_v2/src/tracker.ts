import * as fs from 'fs/promises';
import * as path from 'path';
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
  coinInitialAssetsSui?: number;
  latestCoinStats?: CoinStats;
  coinStatsHistory?: CoinStats[];
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

export interface CoinStats {
  timestamp: string;
  totalAssetsSui: number;
  netPnlSui: number;
  pnl24hSui: number;
  pnl24hPct: number;
  netYieldSui: number;
  bot1LpValue: number;
  bot2LpValue: number;
  botWalletBalanceSui: number;
  botWalletBalanceUsdc: number;
  feesCollected: number;
  gasSpent: number;
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
    coinStatsHistory: [],
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
      if (!this.data.coinStatsHistory) {
        this.data.coinStatsHistory = [];
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
      if (this.data.history.length > 1000) {
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
    if (this.data.history.length > 1000) {
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
    if (this.data.history.length > 1000) {
      this.data.history.shift();
    }
    await this.save();
  }

  /**
   * 価格とPnLの定期的更新（1分以上の間隔で自動保存）
   */
  async update(price: number, pnl: number, coinValues?: Omit<CoinStats, 'timestamp' | 'netPnlSui' | 'pnl24hSui' | 'pnl24hPct'>) {
    this.data.currentPrice = price;
    this.data.pnlTotal = pnl; // ストラテジーから渡された最新の純利益（LP + ヘッジ + 手数料）を反映

    const now = Date.now();
    if (coinValues) {
      if (!this.data.coinInitialAssetsSui || this.data.coinInitialAssetsSui <= 0) {
        const legacyPnlSui = price > 0 ? this.data.pnlTotal / price : 0;
        this.data.coinInitialAssetsSui = coinValues.totalAssetsSui - legacyPnlSui;
      }

      const history = this.data.coinStatsHistory || [];
      const cutoff = now - 24 * 60 * 60 * 1000;
      const baseline = history.find(item => new Date(item.timestamp).getTime() >= cutoff) || history[0];
      const pnl24hSui = baseline ? coinValues.totalAssetsSui - baseline.totalAssetsSui : 0;
      const pnl24hPct = baseline?.totalAssetsSui
        ? (pnl24hSui / baseline.totalAssetsSui) * 100
        : 0;

      const latest: CoinStats = {
        ...coinValues,
        timestamp: new Date(now).toISOString(),
        netPnlSui: coinValues.totalAssetsSui - this.data.coinInitialAssetsSui,
        pnl24hSui,
        pnl24hPct,
      };
      this.data.latestCoinStats = latest;

      const lastTimestamp = history.length > 0
        ? new Date(history[history.length - 1].timestamp).getTime()
        : 0;
      if (now - lastTimestamp >= this.BALANCE_SNAPSHOT_INTERVAL_MS) {
        history.push(latest);
      }
      this.data.coinStatsHistory = history.filter(item => new Date(item.timestamp).getTime() >= now - 8 * 24 * 60 * 60 * 1000);
    }

    if (now - this.lastSaveTime > this.SAVE_INTERVAL_MS) {
      await this.save();
      this.lastSaveTime = now;
    }
  }

  getLatestCoinStats(): CoinStats | null {
    return this.data.latestCoinStats ? { ...this.data.latestCoinStats } : null;
  }

  /**
   * @deprecated update(price, pnl) を使用してください
   */
  updateCurrentPrice(price: number) {
    this.data.currentPrice = price;
  }

  /**
   * 他の履歴データを統合する
   */
  async mergeHistory(otherHistory: any[]) {
    if (!otherHistory || otherHistory.length === 0) return;
    
    // 重複を排除しつつ結合 (timestamp と action をキーにする)
    const combined = [...this.data.history, ...otherHistory];
    const unique = Array.from(new Map(combined.map(h => [`${h.timestamp}_${h.action}`, h])).values());
    
    // 時間順にソート
    unique.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    // 最新1000件を保持
    this.data.history = unique.slice(-1000);
    await this.save();
  }

  /**
   * 統計データと残高履歴を統合する
   */
  async mergeData(otherData: TrackerData) {
    if (!otherData) return;

    // 統計の単純加算 (再起動等で重複する可能性があるが、セッションIDが別なら加算)
    this.data.rebalanceCount += (otherData.rebalanceCount || 0);
    this.data.successfulRebalances += (otherData.successfulRebalances || 0);
    this.data.totalFeesEarned += (otherData.totalFeesEarned || 0);
    this.data.pnlTotal += (otherData.pnlTotal || 0);

    // 残高履歴の統合
    if (otherData.balanceHistory && otherData.balanceHistory.length > 0) {
      const combined = [...this.data.balanceHistory, ...otherData.balanceHistory];
      // 10分以内の重複は排除
      const unique = combined.filter((item, index, self) =>
        index === self.findIndex((t) => 
          Math.abs(new Date(t.timestamp).getTime() - new Date(item.timestamp).getTime()) < 5 * 60 * 1000
        )
      );
      unique.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      this.data.balanceHistory = unique.slice(-500); // 最大500点保持
    }

    await this.save();
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
      history: data.history || this.data.history,
      coinStatsHistory: data.coinStatsHistory || this.data.coinStatsHistory || []
    };
    Logger.info(`Tracker data restored (Rebalances: ${this.data.rebalanceCount})`);
  }
}
