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
  private currentLowerBound: number = 0;
  private currentUpperBound: number = 0;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private priceMonitor: PriceMonitor,
    private lpManager: LpManager,
    private hedgeManager: HedgeManager
  ) {
    if (config.telegramToken && config.telegramChatId) {
      this.telegram = new TelegramBot(config.telegramToken, { polling: false });
    }
  }

  private notify(message: string) {
    if (this.telegram && config.telegramChatId) {
      this.telegram.sendMessage(config.telegramChatId, message).catch(e => {
        Logger.warn('Failed to send telegram notification: ' + e.message);
      });
    }
  }

  private calculateNewRange(currentPrice: number) {
    this.currentLowerBound = currentPrice * (1 - config.rangeWidth);
    this.currentUpperBound = currentPrice * (1 + config.rangeWidth);
  }

  async runRebalance(currentPrice: number) {
    const timeSinceLastRebalance = Date.now() - this.lastRebalanceTime;
    if (timeSinceLastRebalance < config.cooldownPeriodMs && this.lastRebalanceTime !== 0) {
      Logger.warn(`Cooldown active. Skipping rebalance. Time remaining: ${Math.floor((config.cooldownPeriodMs - timeSinceLastRebalance) / 1000)}s`);
      return;
    }

    try {
      this.notify(`リバランス開始: 現在価格 ${currentPrice.toFixed(4)} USDC`);
      Logger.box('Rebalancing Started', `Current Price: ${currentPrice.toFixed(4)}`);

      // 既存ポジションのクローズ
      await this.lpManager.removeLiquidity();
      await this.hedgeManager.closeHedge();

      // 新レンジの計算とポジションオープン
      this.calculateNewRange(currentPrice);
      await this.lpManager.addLiquidity(this.currentLowerBound, this.currentUpperBound, config.lpAmountUsdc);
      
      const hedgeAmount = config.lpAmountUsdc * config.hedgeRatio;
      await this.hedgeManager.openHedge(hedgeAmount);

      this.lastRebalanceTime = Date.now();
      
      // 今回はモックとしてPnLをランダム変動させます
      const mockPnl = (Math.random() - 0.4) * 5; 
      const mockFee = await this.lpManager.collectFees();

      await Tracker.recordRebalance(currentPrice, mockPnl, mockFee);
      Tracker.showStats();

      const msg = `リバランス完了:\n新レンジ: ${this.currentLowerBound.toFixed(4)} - ${this.currentUpperBound.toFixed(4)}\n実行価格: ${currentPrice.toFixed(4)}`;
      Logger.success(msg);
      this.notify(msg);

    } catch (e: any) {
      Logger.error('Rebalance execution failed', e);
      this.notify(`リバランス失敗: ${e.message}`);
    }
  }

  async start() {
    if (this.intervalId) return;
    Logger.info(`Starting monitoring loop (${config.monitorIntervalMs}ms interval).`);

    this.intervalId = setInterval(async () => {
      try {
        const currentPrice = await this.priceMonitor.getCurrentPrice();
        Logger.info(`TICK - Current SUI Price: ${currentPrice.toFixed(4)} USDC`);

        if (this.currentLowerBound === 0 || this.currentUpperBound === 0) {
          // 初回起動時、レンジが未設定なら即実行
          await this.runRebalance(currentPrice);
          return;
        }

        if (this.priceMonitor.isOutOfRange(currentPrice, this.currentLowerBound, this.currentUpperBound)) {
          Logger.warn(`Price ${currentPrice.toFixed(4)} is OUT of range [${this.currentLowerBound.toFixed(4)}, ${this.currentUpperBound.toFixed(4)}]`);
          await this.runRebalance(currentPrice);
        } else {
          // レンジ内なら手数料だけ回収
          Logger.info('Price is within range. Collecting fees...');
          const fee = await this.lpManager.collectFees();
          await Tracker.recordFee(fee);
        }
      } catch (e: any) {
        Logger.error('Error during loop iteration', e);
      }
    }, config.monitorIntervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      Logger.info('Bot monitoring loop paused.');
      this.notify('ボットの稼働を一時停止しました。');
    }
  }
}
