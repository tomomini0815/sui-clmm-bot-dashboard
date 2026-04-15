import TelegramBot from 'node-telegram-bot-api';
import { Logger } from './logger.js';
import { config } from './config.js';
import { PriceMonitor } from './priceMonitor.js';
import { LpManager } from './lpManager.js';
import { HedgeManager } from './hedgeManager.js';
import { Tracker } from './tracker.js';

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
  private TRAILING_STOP_PERCENT: number = 0.05; // 5%の下落で警告
  private TIME_FILTER_MS: number = 5 * 60 * 1000; // 5分間戻らなければ損切り
  public isEmergencyStopped: boolean = false;

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
      this.telegram.sendMessage(config.telegramChatId, `🤖 Sui Bot\n${message}`).catch(e => {
        Logger.warn('Telegram notification failed: ' + e.message);
      });
    }
  }

  private calculateNewRange(currentPrice: number) {
    // 上昇トレンド追従のため、上方幅を広く取る（非対称：下は指定幅、上は2倍）
    this.currentLowerBound = currentPrice * (1 - config.rangeWidth);
    this.currentUpperBound = currentPrice * (1 + (config.rangeWidth * 2));
    Logger.info(`New range set (Asymmetric): [${this.currentLowerBound.toFixed(4)}, ${this.currentUpperBound.toFixed(4)}]`);
  }

  async executeEmergencyStop() {
    try {
      this.notify(`🚨 強制撤退（ストップロス）開始！\n下落トレンドを確認したため、資金を保護します。`);
      Logger.error(`EXECUTING EMERGENCY STOP`);
      
      await this.lpManager.removeLiquidity();
      await this.hedgeManager.closeHedge();
      
      // 本来ここでSUIをUSDCにスワップする
      
      this.isEmergencyStopped = true;
      this.dipStartTime = 0;
      this.notify(`🛑 強制撤退完了\nシステムは現在待機状態（Emergency Stop）です。`);
    } catch (e: any) {
      Logger.error('Emergency stop failed', e);
      this.notify(`❌ 強制撤退中にエラー発生\n手動で確認してください: ${e.message}`);
    }
  }

  async runRebalance(currentPrice: number) {
    const timeSinceLastRebalance = Date.now() - this.lastRebalanceTime;
    if (timeSinceLastRebalance < config.cooldownPeriodMs && this.lastRebalanceTime !== 0) {
      const remaining = Math.floor((config.cooldownPeriodMs - timeSinceLastRebalance) / 1000);
      Logger.warn(`Cooldown active. Skipping rebalance. ${remaining}s remaining.`);
      return;
    }

    try {
      this.notify(`⚡ リバランス開始\n現在価格: ${currentPrice.toFixed(4)} USDC`);
      Logger.box('Rebalancing Started', `Current Price: ${currentPrice.toFixed(4)} USDC`);

      // 既存ポジションのクローズ
      await this.lpManager.removeLiquidity();
      await this.hedgeManager.closeHedge();

      // 新レンジの計算
      this.calculateNewRange(currentPrice);

      // 新しいポジションをオープン
      const txDigest = await this.lpManager.addLiquidity(
        this.currentLowerBound,
        this.currentUpperBound,
        config.lpAmountUsdc
      );

      const hedgeAmount = config.lpAmountUsdc * config.hedgeRatio;
      await this.hedgeManager.openHedge(hedgeAmount);

      this.lastRebalanceTime = Date.now();

      // 手数料回収
      const feeRes = await this.lpManager.collectFees();

      await Tracker.recordRebalance(currentPrice, 0, feeRes.amount, txDigest);
      Tracker.showStats();

      const msg = `✅ リバランス完了\n新レンジ: ${this.currentLowerBound.toFixed(4)} - ${this.currentUpperBound.toFixed(4)}\n実行価格: ${currentPrice.toFixed(4)} USDC`;
      Logger.success(msg);
      this.notify(msg);

    } catch (e: any) {
      Logger.error('Rebalance execution failed', e);
      this.notify(`❌ リバランス失敗\n${e.message}`);
      // エラー時はリバランス済みにしておき、連続試行を防ぐ
      this.lastRebalanceTime = Date.now();
    }
  }

  async start() {
    if (this.intervalId) {
      Logger.warn('Bot is already running.');
      return;
    }
    Logger.info(`Starting bot monitoring loop (interval: ${config.monitorIntervalMs}ms)`);
    this.isRunning = true;
    this.notify('🚀 ボット起動しました');

    this.intervalId = setInterval(async () => {
      try {
        const currentPrice = await this.priceMonitor.getCurrentPrice();

        if (currentPrice <= 0) {
          Logger.warn('Could not fetch price. Skipping this tick.');
          return;
        }

        if (this.isEmergencyStopped) {
          // 緊急停止中は監視のみ行い、リバランス等は控える
          Logger.info(`TICK - System in Emergency Stop. Manual restart required. Current SUI: ${currentPrice.toFixed(4)} USDC`);
          return;
        }

        // --- トレイリングストップとダマシ回避（時間フィルター）のロジック ---
        if (currentPrice > this.highestPriceSurge) {
          this.highestPriceSurge = currentPrice;
          if (this.dipStartTime > 0) {
            Logger.info(`💚 SUI価格が下落ラインから回復し、新高値を更新。ダマシフィルターをリセットしました。`);
            this.dipStartTime = 0;
          }
        }

        const trailingStopLine = this.highestPriceSurge * (1 - this.TRAILING_STOP_PERCENT);

        if (currentPrice < trailingStopLine) {
          if (this.dipStartTime === 0) {
            this.dipStartTime = Date.now();
            Logger.warn(`⚠ 警告: 価格(${currentPrice.toFixed(4)}) がトレイリング撤退ライン(${trailingStopLine.toFixed(4)}) を割りました。5分フィルター開始。`);
          } else {
            const elapsed = Date.now() - this.dipStartTime;
            if (elapsed > this.TIME_FILTER_MS) {
              await this.executeEmergencyStop();
              return;
            } else {
              Logger.warn(`⚠ タイムフィルター待機中... 下落から ${(elapsed / 1000).toFixed(0)} 秒経過`);
            }
          }
        } else {
          if (this.dipStartTime > 0) {
            Logger.info(`💚 価格が撤退ライン以上に回復。フィルターをキャンセリングしました。`);
            this.dipStartTime = 0;
          }
        }

        Logger.info(`TICK - SUI: ${currentPrice.toFixed(4)} USDC | Range: [${this.currentLowerBound.toFixed(4)} - ${this.currentUpperBound.toFixed(4)}] | Trailing Stop: ${trailingStopLine.toFixed(4)}`);

        if (this.currentLowerBound === 0 || this.currentUpperBound === 0) {
          // 初回: 即リバランス実行
          this.highestPriceSurge = currentPrice; // トレイリング基準のリセット
          Logger.info('First run: Starting initial rebalance...');
          await this.runRebalance(currentPrice);
        } else if (this.priceMonitor.isOutOfRange(currentPrice, this.currentLowerBound, this.currentUpperBound)) {
          Logger.warn(`⚠ Price OUT of range! Triggering rebalance...`);
          await this.runRebalance(currentPrice);
        } else {
          Logger.info('✓ Price within range. Collecting fees...');
          const feeRes = await this.lpManager.collectFees();
          if (feeRes.amount > 0 || feeRes.digest) {
            await Tracker.recordFee(feeRes.amount, feeRes.digest);
          }
        }
      } catch (e: any) {
        Logger.error('Error during monitoring loop', e);
      }
    }, config.monitorIntervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      Logger.info('Bot monitoring loop stopped.');
      this.notify('⏹ ボットを停止しました');
    }
  }
}
