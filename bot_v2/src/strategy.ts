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
  private lastHeartbeatTime: number = 0;
  private readonly HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000; // 1時間ごとにログ
  private lastRepairAttemptTime: number = 0; // REPAIRロジックのスパム防止用

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

  async setPrivateKey(privateKey: string): Promise<void> {
    this.sessionPrivateKey = privateKey;
    try {
      const decoded = decodeSuiPrivateKey(privateKey);
      const keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
      this.sessionWalletAddress = keypair.getPublicKey().toSuiAddress();
      
      // 各マネージャにキーペアを配布
      this.lpManager.setKeypair(keypair);
      
      // Bluefin SDKの初期化 (完了を待機)
      const network = this.config.rpcUrl.includes('testnet') ? 'testnet' : 'mainnet';
      await this.hedgeManager.setupBluefin(keypair, this.config.rpcUrl, network as any);
      
      Logger.info(`Strategy session initialized for ${this.sessionWalletAddress} (HedgeMode: ${this.hedgeManager.getMode()})`);
    } catch (e: any) {
      Logger.error(`Failed to initialize strategy for private key: ${e.message}`);
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

  // ===== 戦略ディスパッチャー ===== //

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
      
      if (this.config.strategyMode === 'range_order') {
        await this.executeRangeOrderStrategy(currentPrice);
      } else {
        await this.executeBalancedStrategy(currentPrice);
      }

    } catch (e: any) {
      this.currentPhase = CyclePhase.IDLE;
      Logger.error('戦略実行中に重大なエラーが発生しました', e);
      await this.tracker.recordEvent('エラー', `リバランス失敗: ${e.message}`, currentPrice);
      this.notify(`❌ 戦略エラー: ${e.message}`);
      this.lastRebalanceTime = Date.now();
    }
  }

  /**
   * [戦略A] バランス型デルタニュートラル (25/25/50)
   * 既存の標準ロジック
   */
  private async executeBalancedStrategy(currentPrice: number) {
    this.notify(`⚡ バランス型戦略サイクル開始 (価格: $${currentPrice.toFixed(4)})`);
    Logger.box('Balanced Strategy Start', `Price: $${currentPrice.toFixed(4)} USDC/SUI`);

    // STEP 1: 全決済
    await this.closeAllPositions(currentPrice);

    // STEP 2: 資産評価とターゲット計算
    await new Promise(resolve => setTimeout(resolve, 2000));
    const { suiBalance, usdcBalance } = await this.lpManager.checkBalance();
    const GAS_RESERVE_SUI = 1.0;
    const usableSui = Math.max(0, suiBalance - GAS_RESERVE_SUI);
    const totalEquity = usdcBalance + (usableSui * currentPrice);
    const totalCapital = totalEquity * 0.99;

    if (totalCapital < 1.0) throw new Error('運用可能資金が不足しています');

    const targetSuiValue = totalCapital * 0.25;
    const lpUsdcAmount = totalCapital * 0.25;
    const marginAmount = totalCapital * 0.50;

    // STEP 3: 資産の不均衡調整
    const currentSuiValue = usableSui * currentPrice;
    if (currentSuiValue > targetSuiValue + 0.1) {
      const suiToSell = Math.max(0, (currentSuiValue - targetSuiValue) / currentPrice);
      if (suiToSell > 0.1) {
        const sellRes = await this.lpManager.swapSuiToUsdc(suiToSell);
        await this.tracker.recordEvent('資産調整', `${suiToSell.toFixed(2)} SUIを売却: ${sellRes}`);
      }
    } else if (currentSuiValue < targetSuiValue - 0.1) {
      const usdcToSell = targetSuiValue - currentSuiValue;
      if (usdcToSell > 0.1) {
        const buyRes = await this.lpManager.swapUsdcToSui(usdcToSell);
        await this.tracker.recordEvent('資産調整', `${usdcToSell.toFixed(2)} USDCでSUIを購入: ${buyRes}`);
      }
    }
    
    // STEP 4: レンジ計算とLP提供
    this.currentLowerBound = currentPrice * (1 - this.config.rangeWidth);
    this.currentUpperBound = currentPrice * (1 + this.config.rangeWidth);
    
    Logger.info(`🎯 目標レンジ設定: $${this.currentLowerBound.toFixed(4)} 〜 $${this.currentUpperBound.toFixed(4)}`);
    this.currentPhase = CyclePhase.ADDING_LP;

    // targetSuiValue == lpUsdcAmount なので、lpUsdcAmount分のUSDC(と対になるSUI)を投入する
    const lpRes = await this.lpManager.addLiquidity(this.currentLowerBound, this.currentUpperBound, lpUsdcAmount, true);
    await this.tracker.recordRebalance(currentPrice, targetSuiValue, lpUsdcAmount, lpRes.digest, 'バランス型LP提供完了', this.currentLowerBound, this.currentUpperBound, 'BALANCED');

    // STEP 5: ヘッジポジション構築
    Logger.info("⏳ Indexer同期待機 (5秒)...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    this.currentPhase = CyclePhase.OPENING_HEDGE;
    const hedgeRes = await this.hedgeManager.openHedge(marginAmount, currentPrice);
    await this.tracker.recordHedge('SHORT', 'バランス型ヘッジ構築', currentPrice, marginAmount / currentPrice, hedgeRes.digest);

    this.finalizeRebalance(currentPrice, targetSuiValue * 2, marginAmount, totalCapital);
  }

  /**
   * [戦略B] 指値レンジ戦略 (Range Order)
   */
  private async executeRangeOrderStrategy(currentPrice: number) {
    this.notify(`🎯 指値レンジ戦略サイクル開始 (価格: $${currentPrice.toFixed(4)})`);
    Logger.box('Range Order Strategy Start', `Price: $${currentPrice.toFixed(4)} USDC/SUI`);

    // STEP 1: 全決済
    await this.closeAllPositions(currentPrice);

    // STEP 2: 資産状況の確認
    await new Promise(resolve => setTimeout(resolve, 2000));
    let { suiBalance, usdcBalance } = await this.lpManager.checkBalance();
    const GAS_RESERVE_SUI = 1.0;
    const usableSui = Math.max(0, suiBalance - GAS_RESERVE_SUI);
    const suiValue = usableSui * currentPrice;
    
    // 戦略の向きを決定
    let side = this.config.rangeOrderSide;
    
    // 向きが明示的に指定されているのに資産が足りない場合、スワップして補填する
    if (side === 'above' && usdcBalance > 0.5) {
      this.notify(`🔄 売り指値(above)に必要なSUIが不足しているため、USDCからスワップして補充します。`);
      const swapRes = await this.lpManager.swapUsdcToSui(usdcBalance - 0.1); // ほぼ全額をSUIに
      await this.tracker.recordEvent('資産変換', `売り指値準備のため ${usdcBalance.toFixed(2)} USDC を SUI に変換`, currentPrice, swapRes.digest);
      await new Promise(r => setTimeout(r, 3000));
      // 残高再取得
      const updated = await this.lpManager.checkBalance();
      suiBalance = updated.suiBalance;
      usdcBalance = updated.usdcBalance;
    } else if (side === 'below' && usableSui > 0.5) {
      this.notify(`🔄 買い指値(below)に必要なUSDCが不足しているため、SUIからスワップして補充します。`);
      const swapRes = await this.lpManager.swapSuiToUsdc(usableSui - 0.1); // ほぼ全額をUSDCに
      await this.tracker.recordEvent('資産変換', `買い指値準備のため ${usableSui.toFixed(4)} SUI を USDC に変換`, currentPrice, swapRes.digest);
      await new Promise(r => setTimeout(r, 3000));
      // 残高再取得
      const updated = await this.lpManager.checkBalance();
      suiBalance = updated.suiBalance;
      usdcBalance = updated.usdcBalance;
    }

    const usableSuiFinal = Math.max(0, suiBalance - GAS_RESERVE_SUI);
    const suiValueFinal = usableSuiFinal * currentPrice;

    const sideMsg = (side === 'above') 
      ? '価格上昇待ち (Sell SUI / Receive USDC)' 
      : '価格下落待ち (Buy SUI / Spend USDC)';
    
    Logger.info(`🔎 指値戦略選択: ${sideMsg}`);

    // STEP 3: レンジの計算
    const offset = currentPrice * this.config.rangeOrderOffsetPct;
    const width = currentPrice * this.config.rangeOrderWidthPct;
    
    if (side === 'above') {
      // 現在価格より上。投入資産は SUI。
      this.currentLowerBound = currentPrice + offset;
      this.currentUpperBound = this.currentLowerBound + width;
    } else {
      // 現在価格より下。投入資産は USDC。
      this.currentUpperBound = currentPrice - offset;
      this.currentLowerBound = this.currentUpperBound - width;
    }

    Logger.info(`🎯 指値ターゲット: $${this.currentLowerBound.toFixed(4)} 〜 $${this.currentUpperBound.toFixed(4)}`);

    // STEP 4: LP投入 (スワップなし・片側入金)
    this.currentPhase = CyclePhase.ADDING_LP;
    
    // 投入量の決定
    let deployAmount: number;
    let isUsdc: boolean;
    
    if (side === 'above') {
      deployAmount = usableSuiFinal;
      isUsdc = false;
    } else {
      deployAmount = Math.max(0, usdcBalance - 0.1); // 手数料用に少し残す
      isUsdc = true;
    }
    
    if (deployAmount <= 0.001) throw new Error(`${isUsdc ? 'USDC' : 'SUI'} 資産が不足しているため指値を置けません。`);

    const lpRes = await this.lpManager.addLiquidity(this.currentLowerBound, this.currentUpperBound, deployAmount, isUsdc);
    await this.tracker.recordRebalance(currentPrice, 0, 0, lpRes.digest, `指値(${side})設定完了`, this.currentLowerBound, this.currentUpperBound, 'RANGE_ORDER');

    // STEP 5: ヘッジ (オプション)
    if (this.config.rangeOrderHedgeEnabled) {
      this.currentPhase = CyclePhase.OPENING_HEDGE;
      // 必要に応じて実装
    }

    this.finalizeRebalance(currentPrice, isUsdc ? deployAmount : deployAmount * currentPrice, 0, isUsdc ? deployAmount : deployAmount * currentPrice);
  }

  /**
   * ポジションの全クローズ共通処理
   */
  private async closeAllPositions(currentPrice: number) {
    Logger.info('--- ポジションのクローズ ---');
    try {
      const removeRes = await this.lpManager.removeLiquidity();
      if (removeRes.digest) await this.tracker.recordEvent('LP解除', 'リバランスのためLP解除', currentPrice, removeRes.digest);
      
      const hedgeRes = await this.hedgeManager.closeHedge(currentPrice);
      if (hedgeRes.digest) await this.tracker.recordEvent('ヘッジ決済', 'リバランスのためヘッジ決済', currentPrice, hedgeRes.digest);

      await this.hedgeManager.withdrawAllMargin();
    } catch (e) {
      Logger.warn('ポジションクローズ中に一部エラーが発生しました');
    }
  }

  /**
   * リバランス完了の共通処理
   */
  private finalizeRebalance(currentPrice: number, lpValue: number, hedgeValue: number, total: number) {
    this.currentPhase = CyclePhase.MONITORING;
    this.lastRebalanceTime = Date.now();
    
    this.pnlEngine.recordLpEntry(currentPrice, lpValue);
    this.pnlEngine.recordHedgeEntry(currentPrice, hedgeValue);

    const msg = `✅ 戦略構築完了 (${this.config.strategyMode})\nレンジ: $${this.currentLowerBound.toFixed(4)} 〜 $${this.currentUpperBound.toFixed(4)}`;
    Logger.success(msg);
    this.notify(msg);
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
    
    // --- 新規: 履歴データの復元ロジック ---
    try {
      const stats = this.tracker.getStats();
      if (stats.history && stats.history.length > 0) {
        // historyから価格情報を抽出し、古い順に並べて復元
        const priceHistory = [...stats.history]
          .reverse() // getStatsがreverseしているので戻す
          .filter(h => h.price > 0)
          .map(h => ({ time: h.time, price: h.price }));
          
        this.priceMonitor.restoreHistory(priceHistory);
      }
    } catch (e) {
      Logger.warn('価格履歴の復元に失敗しましたが、続行します');
    }

    // 運用初期化: 前回のレンジとクールダウンをリセットして強制的に新規構築プロセスを開始する
    this.currentLowerBound = 0;
    this.currentUpperBound = 0;
    this.lastRebalanceTime = 0; // クールダウンをリセット

    // 起動直後のポジション同期
    await this.hedgeManager.syncPositionWithBluefin();

    // 起動直後に一回実行して最初の価格をチャートに載せる
    const firstPrice = await this.priceMonitor.getCurrentPrice();
    if (firstPrice > 0) {
      this.priceHistoryForAnalysis.push(firstPrice);
      this.tracker.updateCurrentPrice(firstPrice);
      
      const strategyName = this.config.STRATEGY_MODE === 'range_order' ? '指値レンジ戦略 (Range Order)' : 'バランス型戦略 (25/25/50)';
      Logger.box('Strategy Reset Triggered', `Starting ${strategyName} at $${firstPrice.toFixed(4)}`);
      this.tracker.recordEvent('戦略テスト開始', `${this.config.TOTAL_OPERATIONAL_CAPITAL_USDC} USDC での ${strategyName} の構築を開始します。`);
      
      // 非同期でリバランスを開始 (1秒後)
      setTimeout(() => this.runRebalance(firstPrice), 1000);
    }

      // 運用監視フェーズへ移行
      this.currentPhase = CyclePhase.MONITORING;
      this.notify('🚀 ボットの運用監視を開始しました');

      // === 監視ループ開始 ===
      this.intervalId = setInterval(async () => {
      try {
        // ヘッジモードが bluefin の場合、SDKの準備ができるまで最大30秒待機
        let waitCount = 0;
        while (!this.hedgeManager.isReady() && waitCount < 30) {
          if (waitCount === 0) Logger.info('⏳ Bluefin SDK の準備完了を待機しています...');
          await new Promise(resolve => setTimeout(resolve, 1000));
          waitCount++;
        }

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

          // === 追加: ヘッジポジションの自己修復ロジック ===
          const hedgeStatus = this.hedgeManager.getStatus(currentPrice);
          if (!hedgeStatus.active && this.currentPhase === CyclePhase.MONITORING) {
            // 再試行のスパムを防止（10分間に1回まで）
            const nowTime = Date.now();
            if (!this.lastRepairAttemptTime || nowTime - this.lastRepairAttemptTime > 10 * 60 * 1000) {
              this.lastRepairAttemptTime = nowTime;
              Logger.warn('⚠️ [REPAIR] ヘッジポジションの欠損を検知しました。補完執行を開始します...');
              
              const totalSuiInLp = await this.lpManager.getSuiAmountInLp();
              if (totalSuiInLp > 0) {
                const hedgeSuiSize = totalSuiInLp * this.config.hedgeRatio;
                const hedgeUsdcValue = hedgeSuiSize * currentPrice;
                
                // サイズが極端に小さい場合（Bluefinの最小ロット未満の可能性）は警告
                if (hedgeSuiSize < 10) {
                  Logger.warn(`⚠️ [REPAIR] ヘッジ数量 (${hedgeSuiSize.toFixed(2)} SUI) がBluefinの最小注文ロット (通常10 SUI) を下回るため、注文が取引所に弾かれる可能性があります。`);
                }
                
                this.notify(`🔧 ヘッジ補完試行 (サイズ: ${hedgeSuiSize.toFixed(4)} SUI)`);
                
                try {
                  const hedgeOpenRes = await this.hedgeManager.openHedge(hedgeUsdcValue, currentPrice);
                  await this.tracker.recordHedge('SHORT', '【自己修復】欠落していたヘッジショートを補完開設', currentPrice, hedgeSuiSize, hedgeOpenRes.digest);
                  Logger.success('✅ [REPAIR] 注文を送信しました。成立は次回照会で確認されます。');
                } catch (e: any) {
                  Logger.error('[REPAIR] ヘッジ補完でエラーが発生しました', e);
                }
              }
            }
          }

          // === 新規: Bluefin維持証拠金チェック ===
          await this.hedgeManager.checkAndMaintainMargin(currentPrice);

          const pnl = this.pnlEngine.calculateNetPnl(currentPrice);
          Logger.info(`✓ レンジ内 ($${currentPrice.toFixed(4)}) | 純利益: $${pnl.netPnl} | APR: ${pnl.apr}%`);
          
          // 統計データをトラッカーに即時反映（内部のスロットルにより保存は1分ごと）
          await this.tracker.update(currentPrice, Number(pnl.netPnl));

          // 1時間ごとの生存確認ログ
          const now = Date.now();
          if (now - this.lastHeartbeatTime > this.HEARTBEAT_INTERVAL_MS) {
            await this.tracker.recordEvent('監視中', `ボットは正常に稼働しています。現在価格: $${currentPrice.toFixed(4)}, 純利益: $${pnl.netPnl}`, currentPrice);
            this.lastHeartbeatTime = now;
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
      this.tracker.recordEvent('Bot停止', 'ユーザーまたはシステムにより停止').catch(() => {});
    }
  }

  private lastPnlDataSync = 0;

  /**
   * PnL/Delta/Gas情報をAPIに返す
   */
  async getPnlData(currentPrice: number) {
    // 30秒に一度は最新のポジション状態を取引所から強制取得する（API経由のUI更新用）
    if (Date.now() - this.lastPnlDataSync > 30000) {
      await this.hedgeManager.syncPositionWithBluefin().catch(() => {});
      this.lastPnlDataSync = Date.now();
    }

    const balance = await this.lpManager.checkBalance();
    const trackerStats = this.tracker.getStats();
    
    return {
      pnl: {
        ...this.pnlEngine.calculateNetPnl(currentPrice),
        botWalletBalanceSui: balance.suiBalance,
        botWalletBalanceUsdc: balance.usdcBalance,
      },
      delta: this.pnlEngine.calculateDelta(this.config.hedgeRatio),
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
