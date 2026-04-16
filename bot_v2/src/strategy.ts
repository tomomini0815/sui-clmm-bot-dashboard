import TelegramBot from 'node-telegram-bot-api';
import { Logger } from './logger.js';
import { config } from './config.js';
import { PriceMonitor } from './priceMonitor.js';
import { LpManager } from './lpManager.js';
import { HedgeManager } from './hedgeManager.js';
import { GasTracker } from './gasTracker.js';
import { PnlEngine } from './pnlEngine.js';
import { Tracker } from './tracker.js';

/**
 * 利益最大化戦略エンジン V3
 * 
 * 市場調査に基づく改善点：
 * 1. ボラティリティ適応型レンジ（Bollinger Band方式）
 * 2. RSIによるスマートエントリー
 * 3. ガス代を考慮した採算性チェック
 * 4. 手数料回収の間隔最適化（ガス代 < 手数料 の場合のみ）
 * 5. リアルPnL計算（LP + ヘッジ - ガス代）
 * 6. デルタニュートラルのシミュレーション管理
 * 7. トレイリングストップ（価格急落対応）
 */
export class Strategy {
  private telegram: TelegramBot | null = null;
  private lastRebalanceTime: number = 0;
  public currentLowerBound: number = 0;
  public currentUpperBound: number = 0;
  public intervalId: NodeJS.Timeout | null = null;
  public isRunning: boolean = false;
  
  // トレイリングストップ用状態
  private highestPriceSurge: number = 0;
  private dipStartTime: number = 0; 
  private TRAILING_STOP_PERCENT: number = 0.08;
  private TIME_FILTER_MS: number = 10 * 60 * 1000;
  public isEmergencyStopped: boolean = false;

  // 価格履歴分析用
  private priceHistoryForAnalysis: number[] = [];
  private lastCollectedFee: number = 0;

  // 手数料回収タイミング管理
  private lastFeeCollectTime: number = 0;
  private accumulatedEstimatedFees: number = 0;

  // 戦略パラメータ
  private readonly VOLATILITY_WINDOW = 20;
  private readonly TREND_WINDOW = 50;
  private readonly RSI_PERIOD = 14;

  constructor(
    private priceMonitor: PriceMonitor,
    private lpManager: LpManager,
    private hedgeManager: HedgeManager,
    private gasTracker: GasTracker,
    private pnlEngine: PnlEngine
  ) {
    this.refreshConfig();
  }

  refreshConfig() {
    if (config.telegramToken && config.telegramChatId) {
      this.telegram = new TelegramBot(config.telegramToken, { polling: false });
      Logger.info('Strategy: Telegram notifications enabled.');
    } else {
      this.telegram = null;
    }
  }

  private notify(message: string) {
    if (this.telegram && config.telegramChatId) {
      this.telegram.sendMessage(config.telegramChatId, `🤖 SUI Bot\n${message}`).catch(e => {
        Logger.warn('Telegram notification failed: ' + e.message);
      });
    }
  }

  // ===== 分析ツール ===== //

  /**
   * ボラティリティ計算（過去N期間の標準偏差 / 平均）
   */
  private calculateVolatility(): number {
    if (this.priceHistoryForAnalysis.length < this.VOLATILITY_WINDOW) {
      return 0.05; // デフォルト5%
    }

    const recentPrices = this.priceHistoryForAnalysis.slice(-this.VOLATILITY_WINDOW);
    const mean = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const variance = recentPrices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / recentPrices.length;
    const stdDev = Math.sqrt(variance);
    
    return stdDev / mean;
  }

  /**
   * RSI（相対力指数）計算
   * RSI < 30: 売られすぎ、RSI > 70: 買われすぎ
   */
  private calculateRSI(): number {
    if (this.priceHistoryForAnalysis.length < this.RSI_PERIOD + 1) {
      return 50; // デフォルト中立
    }

    const prices = this.priceHistoryForAnalysis.slice(-(this.RSI_PERIOD + 1));
    let gains = 0;
    let losses = 0;

    for (let i = 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) {
        gains += change;
      } else {
        losses += Math.abs(change);
      }
    }

    const avgGain = gains / this.RSI_PERIOD;
    const avgLoss = losses / this.RSI_PERIOD;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * トレンド判定（単純移動平均比較）
   */
  private detectTrend(): 'uptrend' | 'downtrend' | 'sideways' {
    if (this.priceHistoryForAnalysis.length < this.TREND_WINDOW) {
      return 'sideways';
    }

    const prices = this.priceHistoryForAnalysis;
    const shortMA = prices.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const longMA = prices.slice(-this.TREND_WINDOW).reduce((a, b) => a + b, 0) / this.TREND_WINDOW;
    const currentPrice = prices[prices.length - 1];

    const deviation = Math.abs(shortMA - longMA) / longMA;

    if (deviation < 0.02) {
      return 'sideways';
    } else if (shortMA > longMA && currentPrice > shortMA) {
      return 'uptrend';
    } else {
      return 'downtrend';
    }
  }

  // ===== レンジ計算 ===== //

  /**
   * Bollinger Band 方式の最適レンジ計算
   */
  private calculateOptimalRange(currentPrice: number) {
    const volatility = this.calculateVolatility();
    const trend = this.detectTrend();

    // Bollinger Band 的アプローチ: 平均 ± k × 標準偏差
    // k を市場状況に応じて調整
    let lowerWidth: number;
    let upperWidth: number;

    switch (trend) {
      case 'uptrend':
        // 上昇: 狭い下限、広い上限
        lowerWidth = Math.max(0.03, Math.min(volatility * 1.0, 0.10));
        upperWidth = Math.max(0.05, Math.min(volatility * 2.5, 0.15));
        Logger.info(`📈 上昇トレンド - レンジ: -${(lowerWidth*100).toFixed(1)}% / +${(upperWidth*100).toFixed(1)}%`);
        break;
      
      case 'downtrend':
        // 下落: 広い下限、狭い上限（防御的）
        lowerWidth = Math.max(0.05, Math.min(volatility * 2.0, 0.15));
        upperWidth = Math.max(0.03, Math.min(volatility * 1.0, 0.08));
        Logger.info(`📉 下落トレンド - レンジ: -${(lowerWidth*100).toFixed(1)}% / +${(upperWidth*100).toFixed(1)}%`);
        break;
      
      case 'sideways':
      default:
        // 横ばい: 対称レンジ（手数料密度最大化）
        const width = Math.max(0.03, Math.min(volatility * 1.5, 0.10));
        lowerWidth = width;
        upperWidth = width;
        Logger.info(`➡️ レンジ相場 - 対称レンジ: ±${(width*100).toFixed(1)}%`);
        break;
    }

    this.currentLowerBound = currentPrice * (1 - lowerWidth);
    this.currentUpperBound = currentPrice * (1 + upperWidth);
    
    Logger.info(`新レンジ設定: [$${this.currentLowerBound.toFixed(4)}, $${this.currentUpperBound.toFixed(4)}]`);
  }

  // ===== リバランス採算性チェック ===== //

  /**
   * ガス代を考慮したリバランス採算性判定
   */
  private isRebalanceProfitable(currentPrice: number): boolean {
    const midPrice = (this.currentLowerBound + this.currentUpperBound) / 2;
    const priceChangePercent = Math.abs(currentPrice - midPrice) / midPrice * 100;

    // 最小価格変動チェック
    if (priceChangePercent < 1.0) {
      Logger.info(`⏸️ 価格変化 ${priceChangePercent.toFixed(2)}% — リバランス不要`);
      return false;
    }

    // ガス代採算チェック
    // リバランス = remove(1) + add(1) + hedgeClose(0) + hedgeOpen(0) = 2TX
    if (!this.gasTracker.isRebalanceProfitable(config.minProfitForRebalance, 2)) {
      return false;
    }

    return true;
  }

  /**
   * RSIベースのエントリー判定
   */
  private isGoodEntryTiming(): boolean {
    const rsi = this.calculateRSI();
    
    if (rsi < config.rsiEntryLow) {
      Logger.info(`⏸️ RSI=${rsi.toFixed(1)} — 売られすぎ、新規エントリー見送り`);
      return false;
    }
    
    if (rsi > config.rsiEntryHigh) {
      Logger.info(`⏸️ RSI=${rsi.toFixed(1)} — 買われすぎ、新規エントリー見送り`);
      return false;
    }

    Logger.info(`✅ RSI=${rsi.toFixed(1)} — エントリー適正範囲`);
    return true;
  }

  // ===== 手数料回収最適化 ===== //

  /**
   * 手数料回収すべきかどうか判定
   * (毎ループではなく、一定間隔 or 累積が閾値を超えた場合のみ)
   */
  private shouldCollectFees(): boolean {
    const elapsed = Date.now() - this.lastFeeCollectTime;
    
    // 最小間隔チェック (デフォルト5分)
    if (elapsed < config.feeCollectIntervalMs) {
      return false;
    }

    // ガス代より稼げるか推定
    const avgGas = this.gasTracker.getAvgGasUsdc();
    if (avgGas > 0 && this.accumulatedEstimatedFees < avgGas * 2) {
      // 推定手数料がガス代の2倍未満ならスキップ
      Logger.info(`⏸️ 手数料回収スキップ: 推定手数料 $${this.accumulatedEstimatedFees.toFixed(4)} < ガス代×2 $${(avgGas * 2).toFixed(4)}`);
      return false;
    }

    return true;
  }

  // ===== 緊急停止 ===== //

  async executeEmergencyStop() {
    try {
      this.notify(`🚨 強制撤退開始！\n下落トレンドを確認したため、資金を保護します。`);
      Logger.error(`EXECUTING EMERGENCY STOP`);
      
      const currentPrice = this.priceHistoryForAnalysis[this.priceHistoryForAnalysis.length - 1] || 0;
      
      await this.lpManager.removeLiquidity();
      await this.hedgeManager.closeHedge(currentPrice);
      
      this.isEmergencyStopped = true;
      this.dipStartTime = 0;
      this.notify(`🛑 強制撤退完了\nシステムは待機状態です。`);
    } catch (e: any) {
      Logger.error('Emergency stop failed', e);
      this.notify(`❌ 強制撤退エラー: ${e.message}`);
    }
  }

  // ===== リバランス実行 ===== //

  async runRebalance(currentPrice: number) {
    const timeSinceLastRebalance = Date.now() - this.lastRebalanceTime;
    
    // クールダウン判定
    if (timeSinceLastRebalance < config.cooldownPeriodMs && this.lastRebalanceTime !== 0) {
      const remaining = Math.floor((config.cooldownPeriodMs - timeSinceLastRebalance) / 1000);
      Logger.warn(`⏳ クールダウン中: あと${remaining}秒`);
      return;
    }

    // RSIチェック（初回以外）
    if (this.lastRebalanceTime !== 0 && this.currentLowerBound > 0) {
      if (!this.isGoodEntryTiming()) {
        return;
      }
    }

    // 採算性チェック（初回以外）
    if (this.currentLowerBound > 0 && this.currentUpperBound > 0) {
      if (!this.isRebalanceProfitable(currentPrice)) {
        return;
      }
    }

    try {
      this.notify(`⚡ リバランス開始\n現在価格: $${currentPrice.toFixed(4)} USDC`);
      Logger.box('Rebalancing Started', `Current Price: $${currentPrice.toFixed(4)} USDC`);

      // 既存ポジションのクローズ
      Logger.info('既存ポジションをクローズ...');
      let removeGas = 0;
      try {
        const removeResult = await this.lpManager.removeLiquidity();
        removeGas = removeResult.gasCostUsdc;
        const hedgeResult = await this.hedgeManager.closeHedge(currentPrice);
        if (hedgeResult.pnl !== 0) {
          Logger.info(`📊 ヘッジ決済PnL: ${hedgeResult.pnl >= 0 ? '+' : ''}$${hedgeResult.pnl.toFixed(4)}`);
        }
        Logger.success('既存ポジションをクローズしました');
      } catch (e: any) {
        Logger.warn(`既存ポジションの削除に失敗（既存なしとして続行）`);
      }

      // 新レンジの計算
      this.calculateOptimalRange(currentPrice);

      // 新しいポジションをオープン
      Logger.info('新規ポジションをオープン...');
      try {
        const addResult = await this.lpManager.addLiquidity(
          this.currentLowerBound,
          this.currentUpperBound,
          config.lpAmountUsdc
        );

        // ガス代をPnLに記録
        const totalGas = removeGas + addResult.gasCostUsdc;
        this.pnlEngine.recordGas(totalGas);
        this.pnlEngine.recordLpEntry(currentPrice, config.lpAmountUsdc);

        // ヘッジポジション開設
        const hedgeAmount = config.lpAmountUsdc * config.hedgeRatio;
        await this.hedgeManager.openHedge(hedgeAmount, currentPrice);
        this.pnlEngine.recordHedgeEntry(currentPrice, hedgeAmount);

        this.lastRebalanceTime = Date.now();
        this.lastFeeCollectTime = Date.now(); // 手数料回収タイマーリセット

        // PnL状況を記録
        const pnlStatus = this.pnlEngine.calculateNetPnl(currentPrice);

        await Tracker.recordRebalance(
          currentPrice,
          pnlStatus.netPnl,
          0,
          addResult.digest,
          undefined,
          this.currentLowerBound,
          this.currentUpperBound,
          'リバランス'
        );
        Tracker.showStats();

        const msg = `✅ リバランス完了\n新レンジ: $${this.currentLowerBound.toFixed(4)} - $${this.currentUpperBound.toFixed(4)}\n実行価格: $${currentPrice.toFixed(4)}\nガス代: $${totalGas.toFixed(4)}\n純利益: $${pnlStatus.netPnl.toFixed(4)} (APR: ${pnlStatus.apr.toFixed(1)}%)`;
        Logger.success(msg);
        this.notify(msg);
      } catch (e: any) {
        Logger.error('新規ポジション作成に失敗しました', e);
        throw e;
      }

    } catch (e: any) {
      Logger.error('Rebalance execution failed', e);
      
      const errorMsg = e.message.substring(0, 100);
      await Tracker.recordRebalance(
        currentPrice,
        0,
        0,
        undefined,
        `失敗: ${errorMsg}`,
        this.currentLowerBound,
        this.currentUpperBound,
        'リバランス(失敗)'
      );
      
      this.notify(`❌ リバランス失敗\n${errorMsg}`);
      this.lastRebalanceTime = Date.now();
    }
  }

  // ===== メインループ ===== //

  async start() {
    if (this.intervalId) {
      Logger.warn('Bot is already running.');
      return;
    }
    
    Logger.info(`🚀 ボット起動 (監視間隔: ${config.monitorIntervalMs / 1000}秒)`);
    this.isRunning = true;
    this.notify('🚀 ボットを起動しました');
    await Tracker.recordEvent('Bot起動', `監視開始 (間隔: ${config.monitorIntervalMs / 1000}秒)　運用金額: ${config.lpAmountUsdc} USDC`);

    Tracker.setConfig({ lpAmountUsdc: config.lpAmountUsdc });

    this.intervalId = setInterval(async () => {
      try {
        const currentPrice = await this.priceMonitor.getCurrentPrice();

        if (currentPrice <= 0) {
          Logger.warn('価格取得失敗 - スキップ');
          return;
        }

        Tracker.updateCurrentPrice(currentPrice);

        // 価格履歴を記録
        this.priceHistoryForAnalysis.push(currentPrice);
        if (this.priceHistoryForAnalysis.length > 200) {
          this.priceHistoryForAnalysis.shift();
        }

        // 推定手数料を累積（大まかな推定）
        if (this.currentLowerBound > 0 && this.currentUpperBound > 0) {
          const rangeWidth = this.currentUpperBound - this.currentLowerBound;
          const feeRate = 0.0025; // 0.25% スワップ手数料の想定
          const estimatedIntervalFee = config.lpAmountUsdc * feeRate * (config.monitorIntervalMs / (24 * 60 * 60 * 1000));
          this.accumulatedEstimatedFees += estimatedIntervalFee;
        }

        // 緊急停止中
        if (this.isEmergencyStopped) {
          Logger.info(`⏹️ 緊急停止中 - 現在価格: $${currentPrice.toFixed(4)}`);
          return;
        }

        // --- トレイリングストップ ---
        if (currentPrice > this.highestPriceSurge) {
          this.highestPriceSurge = currentPrice;
          if (this.dipStartTime > 0) {
            Logger.info(`💚 価格回復 - トレイリングリセット`);
            this.dipStartTime = 0;
          }
        }

        const trailingStopLine = this.highestPriceSurge * (1 - this.TRAILING_STOP_PERCENT);

        if (currentPrice < trailingStopLine) {
          if (this.dipStartTime === 0) {
            this.dipStartTime = Date.now();
            Logger.warn(`⚠️ トレイリングストップライン割れ: $${currentPrice.toFixed(4)} < $${trailingStopLine.toFixed(4)}`);
          } else {
            const elapsed = Date.now() - this.dipStartTime;
            if (elapsed > this.TIME_FILTER_MS) {
              Logger.error(`🚨 10分間下落継続 - 緊急撤退実行`);
              await this.executeEmergencyStop();
              return;
            } else {
              Logger.warn(`⏱️ 下落継続中... ${(elapsed / 1000).toFixed(0)}秒経過`);
            }
          }
        } else {
          if (this.dipStartTime > 0) {
            Logger.info(`✅ 価格回復 - 緊急停止キャンセル`);
            this.dipStartTime = 0;
          }
        }

        // --- メインロジック ---
        if (this.currentLowerBound === 0 || this.currentUpperBound === 0) {
          // 初回実行
          this.highestPriceSurge = currentPrice;
          Logger.info('🎯 初回リバランス実行...');
          await this.runRebalance(currentPrice);
        } else if (this.priceMonitor.isOutOfRange(currentPrice, this.currentLowerBound, this.currentUpperBound)) {
          // レンジ逸脱
          Logger.warn(`⚠️ レンジ逸脱！ リバランス検討...`);
          await this.runRebalance(currentPrice);
        } else {
          // レンジ内: 手数料回収（最適化されたタイミング）
          if (this.shouldCollectFees()) {
            Logger.info(`💰 手数料回収実行 (${((Date.now() - this.lastFeeCollectTime) / 60000).toFixed(1)}分経過)...`);
            const feeRes = await this.lpManager.collectFees();
            this.lastFeeCollectTime = Date.now();
            this.accumulatedEstimatedFees = 0; // リセット

            if (feeRes.amount > 0) {
              this.pnlEngine.recordFee(feeRes.amount);
              this.pnlEngine.recordGas(feeRes.gasCostUsdc);
              await Tracker.recordFee(feeRes.amount);
              Logger.info(`💰 手数料回収: +$${feeRes.amount.toFixed(4)} (ガス: $${feeRes.gasCostUsdc.toFixed(4)})`);
            }
          } else {
            const pnl = this.pnlEngine.calculateNetPnl(currentPrice);
            Logger.info(`✓ レンジ内 ($${currentPrice.toFixed(4)}) | 純利益: $${pnl.netPnl} | APR: ${pnl.apr}%`);
          }
        }

      } catch (e: any) {
        Logger.error('モニタリングループでエラー', e);
      }
    }, config.monitorIntervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      Logger.info('⏹️ ボットを停止しました');
      this.notify('⏹️ ボットを停止しました');
      Tracker.recordEvent('Bot停止', 'ユーザーまたはシステムにより停止').catch(() => {});
    }
  }

  /**
   * PnL/Delta/Gas情報をAPIに返す
   */
  getPnlData(currentPrice: number) {
    return {
      pnl: this.pnlEngine.calculateNetPnl(currentPrice),
      delta: this.pnlEngine.calculateDelta(config.hedgeRatio),
      gasStats: this.gasTracker.getStats(),
      hedge: this.hedgeManager.getStatus(currentPrice),
      rsi: this.calculateRSI(),
      volatility: Number((this.calculateVolatility() * 100).toFixed(2)),
      trend: this.detectTrend(),
      dailySnapshots: this.pnlEngine.getDailySnapshots(),
    };
  }
}
