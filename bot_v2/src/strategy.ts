import TelegramBot from 'node-telegram-bot-api';
import { Logger } from './logger.js';
import { config, BotConfig } from './config.js';
import { PriceMonitor } from './priceMonitor.js';
import { LpManager } from './lpManager.js';
import { HedgeManager } from './hedgeManager.js';
import { GasTracker } from './gasTracker.js';
import { PnlEngine } from './pnlEngine.js';
import { Tracker } from './tracker.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

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
 * 8. サイクル管理（全決済 → 再構築の自動ループ）
 */

export enum CyclePhase {
  IDLE = '待機中',
  SWAPPING = 'スワップ中 (USDC -> SUI)',
  ADDING_LP = 'LP投入中',
  OPENING_HEDGE = 'ヘッジ注文中',
  MONITORING = '運用中 (監視)',
  REBALANCING = 'リバランス中 (全決済実行)',
  EMERGENCY = '緊急停止中',
}

export class Strategy {
  public currentPhase: CyclePhase = CyclePhase.IDLE;
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
    private pnlEngine: PnlEngine,
    private tracker: Tracker,
    private config: BotConfig
  ) {
    this.refreshConfig();
  }

  // セッション対応メソッド
  private sessionPrivateKey: string | null = null;
  private sessionWalletAddress: string | null = null;

  setPrivateKey(privateKey: string): void {
    this.sessionPrivateKey = privateKey;
    try {
      const decoded = decodeSuiPrivateKey(privateKey);
      const keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
      this.sessionWalletAddress = keypair.getPublicKey().toSuiAddress();
      
      // 各マネージャにキーペアを配布
      this.lpManager.setKeypair(keypair);
      
      // Bluefin SDKの初期化 (非同期で実行)
      const network = this.config.rpcUrl.includes('testnet') ? 'testnet' : 'mainnet';
      this.hedgeManager.setupBluefin(keypair, this.config.rpcUrl, network as any);
      
    } catch (e) {
      Logger.error('Invalid private key format');
    }
  }

  getWalletAddress(): string {
    return this.sessionWalletAddress || 'unknown';
  }

  getPrivateKey(): string | null {
    return this.sessionPrivateKey;
  }

  refreshConfig(newConfig?: BotConfig) {
    if (newConfig) {
      this.config = newConfig;
    }

    if (this.config.telegramToken && this.config.telegramChatId) {
      this.telegram = new TelegramBot(this.config.telegramToken, { polling: false });
      Logger.info('Strategy: Telegram notifications enabled.');
    } else {
      this.telegram = null;
    }
  }

  private notify(message: string) {
    if (this.telegram && this.config.telegramChatId) {
      this.telegram.sendMessage(this.config.telegramChatId, `🤖 SUI Bot\n${message}`).catch(e => {
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
    if (!this.gasTracker.isRebalanceProfitable(this.config.minProfitForRebalance, 2)) {
      return false;
    }

    return true;
  }

  /**
   * RSIベースのエントリー判定
   */
  private isGoodEntryTiming(): boolean {
    const rsi = this.calculateRSI();
    
    if (rsi < this.config.rsiEntryLow) {
      Logger.info(`⏸️ RSI=${rsi.toFixed(1)} — 売られすぎ、新規エントリー見送り`);
      return false;
    }
    
    if (rsi > this.config.rsiEntryHigh) {
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
    if (elapsed < this.config.feeCollectIntervalMs) {
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
    
    // クールダウン判定（起動直後や新規構築時は無視する）
    if (this.currentLowerBound > 0 && timeSinceLastRebalance < this.config.cooldownPeriodMs && this.lastRebalanceTime !== 0) {
      const remaining = Math.floor((this.config.cooldownPeriodMs - timeSinceLastRebalance) / 1000);
      Logger.warn(`⏳ クールダウン中: あと${remaining}秒`);
      return;
    }

    try {
      this.currentPhase = CyclePhase.REBALANCING;
      this.notify(`⚡ 戦略サイクル再構築開始 (価格: $${currentPrice.toFixed(4)})`);
      Logger.box('Strategy Cycle Start', `Price: $${currentPrice.toFixed(4)} USDC/SUI`);

      // STEP 1: 全決済 (リムーブLP & クローズヘッジ)
      Logger.info('--- [STEP 1] 全ポジションのクローズ ---');
      try {
        const removeRes = await this.lpManager.removeLiquidity();
        if (removeRes.digest) {
          await this.tracker.recordEvent('LP解除', 'レンジ外のためLPを削除しました', currentPrice, removeRes.digest);
        }
        
        const hedgeRes = await this.hedgeManager.closeHedge(currentPrice);
        if (hedgeRes.digest) {
          await this.tracker.recordEvent('ヘッジ決済', 'LP解除に伴いショートポジションを決済しました', currentPrice, hedgeRes.digest);
        }
      } catch (e) {
        Logger.warn('ポジションクローズ中にエラーが発生しましたが、新規構築を続行します');
      }

      // STEP 2: 25/25/50 戦略構築
      Logger.info('--- [STEP 2] 戦略の構築 (25/25/50分配) ---');
      const totalCapital = 10; // ユーザー指定の10 USDC
      const swapStepAmount = totalCapital * 0.25;      // ① 2.5 USDC で SUI購入
      const lpUsdcAmount = totalCapital * 0.25;        // ② 2.5 USDC を LP投入用
      const marginAmount = totalCapital * 0.50;        // ③ 5.0 USDC をヘッジ担保

      // ① SUI購入 (25%)
      this.currentPhase = CyclePhase.SWAPPING;
      Logger.info(`① 25%分 ($${swapStepAmount.toFixed(2)}) の SUI を購入中...`);
      const swapRes = await this.lpManager.swapUsdcToSui(swapStepAmount);
      await this.tracker.recordEvent('SUI購入', `LP用資産として ${swapRes.amountOut.toFixed(4)} SUI を購入`, currentPrice, swapRes.digest);

      // ② LP投入 (25%)
      this.currentPhase = CyclePhase.ADDING_LP;
      this.calculateOptimalRange(currentPrice); // 価格変動に基づきレンジ計算
      Logger.info(`② 25%分 ($${lpUsdcAmount.toFixed(2)}) + SUI で LP を提供中...`);
      const lpRes = await this.lpManager.addLiquidity(this.currentLowerBound, this.currentUpperBound, lpUsdcAmount);
      await this.tracker.recordRebalance(currentPrice, 0, 0, lpRes.digest, 'LP提供完了', this.currentLowerBound, this.currentUpperBound, 'LP投入');

      // ③ ヘッジ証拠金入金 (50%)
      this.currentPhase = CyclePhase.OPENING_HEDGE;
      Logger.info(`③ 50%分 ($${marginAmount.toFixed(2)}) をヘッジ証拠金として入金中...`);
      const depositRes = await this.hedgeManager.depositMargin(marginAmount);
      await this.tracker.recordEvent('証拠金入金', `ヘッジ用担保 $${marginAmount.toFixed(2)} をBluefinへ入金`, currentPrice, depositRes.digest);

      // ④ ヘッジショート構築 (LPのSUI数量の 50%)
      // 実際のスワップで得たSUI数量の半分をヘッジ
      const hedgeSuiSize = swapRes.amountOut * 0.5;
      const hedgeUsdcValue = hedgeSuiSize * currentPrice;
      Logger.info(`④ LP保有SUIの50% (${hedgeSuiSize.toFixed(4)} SUI) をショート中...`);
      const hedgeOpenRes = await this.hedgeManager.openHedge(hedgeUsdcValue, currentPrice);
      await this.tracker.recordHedge('SHORT', 'デルタ中立化のためのショート開設', currentPrice, hedgeSuiSize, hedgeOpenRes.digest);

      // 完了処理
      this.currentPhase = CyclePhase.MONITORING;
      this.lastRebalanceTime = Date.now();
      
      this.pnlEngine.recordLpEntry(currentPrice, lpUsdcAmount * 2); // LP総額 (~5 USDC)
      this.pnlEngine.recordHedgeEntry(currentPrice, hedgeUsdcValue);

      const msg = `✅ 戦略サイクル構築完了 (25/25/50)\n運用額: ${totalCapital} USDC\nレンジ: $${this.currentLowerBound.toFixed(4)} 〜 $${this.currentUpperBound.toFixed(4)}`;
      Logger.success(msg);
      this.notify(msg);

    } catch (e: any) {
      this.currentPhase = CyclePhase.IDLE;
      Logger.error('サイクル実行中にエラーが発生しました', e);
      this.notify(`❌ サイクルエラー: ${e.message}`);
      this.lastRebalanceTime = Date.now();
    }
  }

  // ===== メインループ ===== //

  async start() {
    if (this.intervalId) {
      Logger.warn('Bot is already running.');
      return;
    }
    
    Logger.info(`🚀 ボット起動 (監視間隔: ${this.config.monitorIntervalMs / 1000}秒)`);
    this.isRunning = true;
    this.notify('🚀 ボットを起動しました');
    await this.tracker.recordEvent('Bot起動', `監視開始 (間隔: ${this.config.monitorIntervalMs / 1000}秒)　運用金額: ${this.config.lpAmountUsdc} USDC`);

    this.tracker.setConfig({ lpAmountUsdc: this.config.lpAmountUsdc });

    // 運用初期化: 前回のレンジとクールダウンをリセットして強制的に新規構築プロセスを開始する
    this.currentLowerBound = 0;
    this.currentUpperBound = 0;
    this.lastRebalanceTime = 0; // クールダウンをリセット

    // 起動直後に一回実行して最初の価格をチャートに載せる
    const firstPrice = await this.priceMonitor.getCurrentPrice();
    if (firstPrice > 0) {
      this.priceHistoryForAnalysis.push(firstPrice);
      this.tracker.updateCurrentPrice(firstPrice);
      
      Logger.box('Strategy Reset Triggered', `Forcing fresh 25/25/50 cycle at $${firstPrice.toFixed(4)}`);
      this.tracker.recordEvent('戦略テスト開始', `10 USDC での新戦略 (25/25/50) の構築をゼロから開始します。`);
      
      // 非同期でリバランスを開始 (1秒後)
      setTimeout(() => this.runRebalance(firstPrice), 1000);
    }

    this.intervalId = setInterval(async () => {
      try {
        const currentPrice = await this.priceMonitor.getCurrentPrice();

        if (currentPrice <= 0) {
          Logger.warn('価格取得失敗 - スキップ');
          return;
        }

        this.tracker.updateCurrentPrice(currentPrice);

        // 価格履歴を記録
        this.priceHistoryForAnalysis.push(currentPrice);
        if (this.priceHistoryForAnalysis.length > 200) {
          this.priceHistoryForAnalysis.shift();
        }

        // 推定手数料を累積（大まかな推定）
        if (this.currentLowerBound > 0 && this.currentUpperBound > 0) {
          const rangeWidth = this.currentUpperBound - this.currentLowerBound;
          const feeRate = 0.0025; // 0.25% スワップ手数料の想定
          const estimatedIntervalFee = this.config.lpAmountUsdc * feeRate * (this.config.monitorIntervalMs / (24 * 60 * 60 * 1000));
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
              await this.tracker.recordFee(feeRes.amount);
              Logger.info(`💰 手数料回収: +$${feeRes.amount.toFixed(4)} (ガス: $${feeRes.gasCostUsdc.toFixed(4)})`);
            }
          }

          // === 新規: Bluefin維持証拠金チェック ===
          await this.hedgeManager.checkAndMaintainMargin(currentPrice);

          const pnl = this.pnlEngine.calculateNetPnl(currentPrice);
          Logger.info(`✓ レンジ内 ($${currentPrice.toFixed(4)}) | 純利益: $${pnl.netPnl} | APR: ${pnl.apr}%`);
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
      this.tracker.recordEvent('Bot停止', 'ユーザーまたはシステムにより停止').catch(() => {});
    }
  }

  /**
   * PnL/Delta/Gas情報をAPIに返す
   */
  async getPnlData(currentPrice: number) {
    const balance = await this.lpManager.checkBalance();
    const trackerStats = this.tracker.getStats();
    
    return {
      pnl: {
        ...this.pnlEngine.calculateNetPnl(currentPrice),
        botWalletBalanceSui: balance.suiBalance,
        botWalletBalanceUsdc: balance.usdcBalance,
      },
      delta: this.pnlEngine.calculateDelta(config.hedgeRatio),
      gasStats: this.gasTracker.getStats(),
      hedge: this.hedgeManager.getStatus(currentPrice),
      rsi: this.calculateRSI(),
      volatility: Number((this.calculateVolatility() * 100).toFixed(2)),
      trend: this.detectTrend(),
      dailySnapshots: this.pnlEngine.getDailySnapshots(),
      currentPhase: this.currentPhase,
      ...trackerStats, // trackerからの統計（履歴含む）を追加
    };
  }
}
