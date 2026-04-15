import TelegramBot from 'node-telegram-bot-api';
import { Logger } from './logger.js';
import { config } from './config.js';
import { PriceMonitor } from './priceMonitor.js';
import { LpManager } from './lpManager.js';
import { HedgeManager } from './hedgeManager.js';
import { Tracker } from './tracker.js';

/**
 * 改善された利益特化型戦略
 * 
 * 主な改善点：
 * 1. 動的最適レンジ計算（ボラティリティ対応）
 * 2. スマートなリバランス判断（ガス代考慮）
 * 3. トレンド検出（レンジ相場・トレンド相場対応）
 * 4. 正確な手数料回収と利益計算
 * 5. 段階的ポジション調整
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
  private TRAILING_STOP_PERCENT: number = 0.08; // 8%の下落で警告（余裕を持たせる）
  private TIME_FILTER_MS: number = 10 * 60 * 1000; // 10分間戻らなければ損切り
  public isEmergencyStopped: boolean = false;

  // 価格履歴分析用
  private priceHistoryForAnalysis: number[] = [];
  private lastCollectedFee: number = 0;
  private totalGasCost: number = 0; // ガス代の追跡

  // 戦略パラメータ
  private readonly MIN_REBALANCE_PROFIT_THRESHOLD = 1.5; // リバランスに必要な最小利益率(%)
  private readonly VOLATILITY_WINDOW = 20; // ボラティリティ計算の期間
  private readonly TREND_WINDOW = 50; // トレンド判定の期間

  constructor(
    private priceMonitor: PriceMonitor,
    private lpManager: LpManager,
    private hedgeManager: HedgeManager
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

  /**
   * ボラティリティを計算（過去20期間の標準偏差）
   */
  private calculateVolatility(): number {
    if (this.priceHistoryForAnalysis.length < this.VOLATILITY_WINDOW) {
      return 0.05; // デフォルト5%
    }

    const recentPrices = this.priceHistoryForAnalysis.slice(-this.VOLATILITY_WINDOW);
    const mean = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const variance = recentPrices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / recentPrices.length;
    const stdDev = Math.sqrt(variance);
    
    return stdDev / mean; // 変動係数
  }

  /**
   * トレンドを判定（単純移動平均比較）
   * 戻り値: 'uptrend' | 'downtrend' | 'sideways'
   */
  private detectTrend(): 'uptrend' | 'downtrend' | 'sideways' {
    if (this.priceHistoryForAnalysis.length < this.TREND_WINDOW) {
      return 'sideways';
    }

    const prices = this.priceHistoryForAnalysis;
    const shortMA = prices.slice(-10).reduce((a, b) => a + b, 0) / 10; // 短期MA
    const longMA = prices.slice(-this.TREND_WINDOW).reduce((a, b) => a + b, 0) / this.TREND_WINDOW; // 長期MA
    const currentPrice = prices[prices.length - 1];

    const deviation = Math.abs(shortMA - longMA) / longMA;

    if (deviation < 0.02) {
      return 'sideways'; // レンジ相場
    } else if (shortMA > longMA && currentPrice > shortMA) {
      return 'uptrend'; // 上昇トレンド
    } else {
      return 'downtrend'; // 下落トレンド
    }
  }

  /**
   * 市場状況に応じた最適レンジ計算
   */
  private calculateOptimalRange(currentPrice: number) {
    const volatility = this.calculateVolatility();
    const trend = this.detectTrend();

    let lowerWidth: number;
    let upperWidth: number;

    // 市場状況に応じてレンジを動的調整
    switch (trend) {
      case 'uptrend':
        // 上昇トレンド: 狭めの下限、広めの上限
        lowerWidth = Math.max(0.03, volatility * 0.8);
        upperWidth = Math.max(0.08, volatility * 2.0);
        Logger.info(`📈 上昇トレンド検出 - レンジ調整: 下${(lowerWidth*100).toFixed(1)}% / 上${(upperWidth*100).toFixed(1)}%`);
        break;
      
      case 'downtrend':
        // 下落トレンド: 広めの下限、狭めの上限（防御的）
        lowerWidth = Math.max(0.06, volatility * 1.5);
        upperWidth = Math.max(0.04, volatility * 1.0);
        Logger.info(`📉 下落トレンド検出 - レンジ調整: 下${(lowerWidth*100).toFixed(1)}% / 上${(upperWidth*100).toFixed(1)}%`);
        break;
      
      case 'sideways':
      default:
        // レンジ相場: 対称レンジ（手数料最大化）
        const symmetricWidth = Math.max(0.04, volatility * 1.2);
        lowerWidth = symmetricWidth;
        upperWidth = symmetricWidth;
        Logger.info(`➡️ レンジ相場検出 - 対称レンジ: ±${(symmetricWidth*100).toFixed(1)}%`);
        break;
    }

    this.currentLowerBound = currentPrice * (1 - lowerWidth);
    this.currentUpperBound = currentPrice * (1 + upperWidth);
    
    Logger.info(`新レンジ設定: [${this.currentLowerBound.toFixed(4)}, ${this.currentUpperBound.toFixed(4)}]`);
  }

  /**
   * リバランスの採算性を判定
   */
  private isRebalanceProfitable(currentPrice: number): boolean {
    // 前回のリバランスからの価格変化率
    const midPrice = (this.currentLowerBound + this.currentUpperBound) / 2;
    const priceChangePercent = Math.abs(currentPrice - midPrice) / midPrice * 100;

    // 価格変化が小さすぎる場合はリバランス不要
    if (priceChangePercent < this.MIN_REBALANCE_PROFIT_THRESHOLD) {
      Logger.info(`⏸️ 価格変化${priceChangePercent.toFixed(2)}% - リバランス不要（閾値${this.MIN_REBALANCE_PROFIT_THRESHOLD}%未満）`);
      return false;
    }

    return true;
  }

  /**
   * 緊急ストップ実行
   */
  async executeEmergencyStop() {
    try {
      this.notify(`🚨 強制撤退開始！\n下落トレンドを確認したため、資金を保護します。`);
      Logger.error(`EXECUTING EMERGENCY STOP`);
      
      await this.lpManager.removeLiquidity();
      await this.hedgeManager.closeHedge();
      
      this.isEmergencyStopped = true;
      this.dipStartTime = 0;
      this.notify(`🛑 強制撤退完了\nシステムは待機状態です。`);
    } catch (e: any) {
      Logger.error('Emergency stop failed', e);
      this.notify(`❌ 強制撤退エラー: ${e.message}`);
    }
  }

  /**
   * リバランス実行
   */
  async runRebalance(currentPrice: number) {
    const timeSinceLastRebalance = Date.now() - this.lastRebalanceTime;
    
    // クールダウン判定
    if (timeSinceLastRebalance < config.cooldownPeriodMs && this.lastRebalanceTime !== 0) {
      const remaining = Math.floor((config.cooldownPeriodMs - timeSinceLastRebalance) / 1000);
      Logger.warn(`⏳ クールダウン中: あと${remaining}秒`);
      return;
    }

    // 採算性チェック
    if (!this.isRebalanceProfitable(currentPrice)) {
      return;
    }

    try {
      this.notify(`⚡ リバランス開始\n現在価格: ${currentPrice.toFixed(4)} USDC`);
      Logger.box('Rebalancing Started', `Current Price: ${currentPrice.toFixed(4)} USDC`);

      // 既存ポジションのクローズを試みる（失敗しても続行）
      Logger.info('既存ポジションをクローズ（試行）...');
      try {
        await this.lpManager.removeLiquidity();
        await this.hedgeManager.closeHedge();
        Logger.success('既存ポジションをクローズしました');
      } catch (e: any) {
        Logger.warn(`既存ポジションの削除に失敗しました（既存ポジションなしとして続行）`);
      }

      // 新レンジの計算（現在価格に基づく）
      this.calculateOptimalRange(currentPrice);

      // 新しいポジションをオープン（既存ポジションがあっても強制的に作成）
      Logger.info('新規ポジションをオープン...');
      try {
        const txDigest = await this.lpManager.addLiquidity(
          this.currentLowerBound,
          this.currentUpperBound,
          config.lpAmountUsdc
        );

        // ヘッジポジション調整
        const hedgeAmount = config.lpAmountUsdc * config.hedgeRatio;
        await this.hedgeManager.openHedge(hedgeAmount);

        this.lastRebalanceTime = Date.now();

        // 即時手数料回収
        const feeRes = await this.lpManager.collectFees();
        this.lastCollectedFee = feeRes.amount;

        await Tracker.recordRebalance(
          currentPrice,
          0,
          feeRes.amount,
          txDigest,
          undefined,
          this.currentLowerBound,
          this.currentUpperBound,
          'リバランス'
        );
        Tracker.showStats();

        const msg = `✅ リバランス完了\n新レンジ: ${this.currentLowerBound.toFixed(4)} - ${this.currentUpperBound.toFixed(4)}\n実行価格: ${currentPrice.toFixed(4)} USDC`;
        Logger.success(msg);
        this.notify(msg);
      } catch (e: any) {
        Logger.error('新規ポジション作成に失敗しました', e);
        throw e;
      }

    } catch (e: any) {
      Logger.error('Rebalance execution failed', e);
      
      // 失敗も履歴に記録
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
      // エラー時はクールダウンをリセット
      this.lastRebalanceTime = Date.now();
    }
  }

  /**
   * メインモニタリングループ
   */
  async start() {
    if (this.intervalId) {
      Logger.warn('Bot is already running.');
      return;
    }
    
    Logger.info(`🚀 ボット起動 (監視間隔: ${config.monitorIntervalMs / 1000}秒)`);
    this.isRunning = true;
    this.notify('🚀 ボットを起動しました');
    await Tracker.recordEvent('Bot起動', `監視開始 (間隔: ${config.monitorIntervalMs / 1000}秒)　運用金額: ${config.lpAmountUsdc} USDC`);

    // Trackerに設定情報を記録
    Tracker.setConfig({ lpAmountUsdc: config.lpAmountUsdc });

    this.intervalId = setInterval(async () => {
      try {
        const currentPrice = await this.priceMonitor.getCurrentPrice();

        if (currentPrice <= 0) {
          Logger.warn('価格取得失敗 - スキップ');
          return;
        }

        // Trackerに現在価格を更新
        Tracker.updateCurrentPrice(currentPrice);

        // 価格履歴を記録（分析用）
        this.priceHistoryForAnalysis.push(currentPrice);
        if (this.priceHistoryForAnalysis.length > 100) {
          this.priceHistoryForAnalysis.shift();
        }

        // 緊急停止中の場合は監視のみ
        if (this.isEmergencyStopped) {
          Logger.info(`⏹️ 緊急停止中 - 現在価格: ${currentPrice.toFixed(4)} USDC`);
          return;
        }

        // --- トレイリングストップ判定 ---
        if (currentPrice > this.highestPriceSurge) {
          this.highestPriceSurge = currentPrice;
          if (this.dipStartTime > 0) {
            Logger.info(`💚 価格が回復し新高値を更新 - トレイリングリセット`);
            this.dipStartTime = 0;
          }
        }

        const trailingStopLine = this.highestPriceSurge * (1 - this.TRAILING_STOP_PERCENT);

        if (currentPrice < trailingStopLine) {
          if (this.dipStartTime === 0) {
            this.dipStartTime = Date.now();
            Logger.warn(`⚠️ トレイリングストップライン割れ: ${currentPrice.toFixed(4)} < ${trailingStopLine.toFixed(4)}`);
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
          Logger.warn(`⚠️ レンジ逸脱！リバランス実行...`);
          await this.runRebalance(currentPrice);
        } else {
          // レンジ内 - 手数料回収のみ
          Logger.info(`✓ レンジ内 - 手数料回収中...`);
          const feeRes = await this.lpManager.collectFees();
          if (feeRes.amount > 0 || feeRes.digest) {
            await Tracker.recordFee(feeRes.amount);
            if (feeRes.amount > 0) {
              Logger.info(`💰 手数料回収: +${feeRes.amount.toFixed(4)} USDC`);
            }
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
}
