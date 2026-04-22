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
  SWAPPING = 'スワップ中',
  ADDING_LP = 'LP投入中',
  OPENING_HEDGE = 'ヘッジ注文中',
  CLOSING_HEDGE = 'ヘッジ決済中',
  REMOVING_LP = 'LP解除中',
  HEDGE_FLIPPING = 'ヘッジ方向反転中',
  MONITORING = '運用中 (監視)',
  REBALANCING = 'リバランス中',
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
  
  // === デルタニュートラル方向反転戦略の状態 ===
  public hedgeDirection: 'SHORT' | 'LONG' | 'NONE' = 'NONE';
  public lastExitDirection: 'upper' | 'lower' | null = null;

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
  private readonly HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;
  private lastRepairAttemptTime: number = 0;

  // 戦略パラメータ
  private readonly VOLATILITY_WINDOW = 20;
  private readonly TREND_WINDOW = 50;
  private readonly RSI_PERIOD = 14;

  // ===== 仕様書準拠: 安全ゲート & 常時監視ループ状態 =====

  // 5分逸脱確認用
  private lastBreachTime: number | null = null;
  private readonly BREACH_CONFIRM_MS = 5 * 60 * 1000; // 5分

  // drawdown計算用
  private peakPortfolioValue: number = 0;

  // 連続エラーカウンター (20回で即停止に緩和)
  private consecutiveErrors: number = 0;
  private readonly MAX_CONSECUTIVE_ERRORS = 20;

  // LP評価額キャッシュ (Deltaドリフト計算用)
  private currentLpValueUsdc: number = 0;
  private currentHedgeUsd: number = 0;

  // 1時間サマリー集計
  private hourlyStats = {
    startTime: Date.now(),
    lpFeeEarned: 0,
    hedgePnl: 0,
    fundingPaid: 0,
    gasSpent: 0,
    rebalanceCount: 0,
    hedgeAdjustCount: 0,
    deltaErrors: [] as number[],
  };

  // Cetus tick_spacing (SUI/USDC標準プール)
  private readonly TICK_SPACING = 2;

  constructor(
    public priceMonitor: PriceMonitor,
    public lpManager: LpManager,
    public hedgeManager: HedgeManager,
    public gasTracker: GasTracker,
    public pnlEngine: PnlEngine,
    public tracker: Tracker,
    public config: BotConfig,
    private onStateChange?: () => void
  ) {
    this.refreshConfig();
  }

  // セッション対応メソッド
  private sessionPrivateKey: string | null = null;
  private sessionWalletAddress: string | null = null;

  /**
   * 現在の状態をシリアライズ (保存用)
   */
  public serialize() {
    return {
      currentLowerBound: this.currentLowerBound,
      currentUpperBound: this.currentUpperBound,
      hedgeDirection: this.hedgeDirection,
      lastExitDirection: this.lastExitDirection,
      lastRebalanceTime: this.lastRebalanceTime,
      highestPriceSurge: this.highestPriceSurge,
      isEmergencyStopped: this.isEmergencyStopped,
      lastHeartbeatTime: this.lastHeartbeatTime
    };
  }

  /**
   * 保存された状態から復元
   */
  public restore(state: any) {
    if (!state) return;
    this.currentLowerBound = state.currentLowerBound || 0;
    this.currentUpperBound = state.currentUpperBound || 0;
    this.hedgeDirection = state.hedgeDirection || 'NONE';
    this.lastExitDirection = state.lastExitDirection || null;
    this.lastRebalanceTime = state.lastRebalanceTime || 0;
    this.highestPriceSurge = state.highestPriceSurge || 0;
    this.isEmergencyStopped = state.isEmergencyStopped || false;
    this.lastHeartbeatTime = state.lastHeartbeatTime || 0;
    
    if (this.currentLowerBound > 0) {
      Logger.success(`[PERSISTENCE] Range restored: $${this.currentLowerBound.toFixed(4)} - $${this.currentUpperBound.toFixed(4)}`);
    }
  }

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

    if (priceChangePercent < 1.0) {
      Logger.info(`⏸️ 価格変化 ${priceChangePercent.toFixed(2)}% — リバランス不要`);
      return false;
    }

    if (!this.gasTracker.isRebalanceProfitable(this.config.minProfitForRebalance, 2)) {
      return false;
    }

    return true;
  }

  // ===== 仕様書準拠: ATRレンジ計算 =====

  /**
   * ATR24hベースのレンジ計算 (仕様書 STEP A-2)
   * lower = price × (1 - ATR/price × 2.0)
   * upper = price × (1 + ATR/price × 2.0)
   * tick_spacingで丸める
   */
  private calculateATRRange(currentPrice: number): { lower: number; upper: number } {
    const atr = this.priceMonitor.calculateATR24h();
    const atrRatio = atr / currentPrice;
    const halfWidth = atrRatio * 2.0;

    const rawLower = currentPrice * (1 - halfWidth);
    const rawUpper = currentPrice * (1 + halfWidth);

    // Cetus tick_spacingに丸める
    const lower = this.roundToTickSpacing(rawLower, this.TICK_SPACING);
    const upper = this.roundToTickSpacing(rawUpper, this.TICK_SPACING);

    Logger.info(`📐 ATRRange: ATR=$${atr.toFixed(4)} (${(atrRatio*100).toFixed(2)}%) → [$${lower.toFixed(4)}, $${upper.toFixed(4)}]`);
    return { lower, upper };
  }

  private roundToTickSpacing(price: number, tickSpacing: number): number {
    // 価格→tick変換は近似。CLMMのtick = log(price) / log(1.0001)
    const tick = Math.log(price) / Math.log(1.0001);
    const roundedTick = Math.round(tick / tickSpacing) * tickSpacing;
    return Math.pow(1.0001, roundedTick);
  }

  // ===== 仕様書準拠: ヘッジ方向決定 =====

  /**
   * ファンディングレート・LP手数料率・トレンドを総合してヘッジ方向を決定
   * 仕様書 decide_hedge_direction()
   */
  private async decideHedgeDirection(
    trend: 'uptrend' | 'downtrend' | 'sideways',
    fundingRateHourly: number
  ): Promise<'SHORT' | 'LONG' | 'NO_HEDGE'> {
    // LP手数料率推定 (1時間あたり)
    const lpFeeRateHourly = 0.0025 / 24; // 0.25%/日 ÷ 24
    const netBenefitIfShort = lpFeeRateHourly - Math.max(0, fundingRateHourly);
    const netBenefitIfLong  = lpFeeRateHourly + Math.min(0, fundingRateHourly); // ロングはfundingを受け取る方向

    Logger.info(`📊 HedgeDecision: trend=${trend}, funding=${(fundingRateHourly*100).toFixed(4)}%/h, lpFee=${(lpFeeRateHourly*100).toFixed(4)}%/h`);

    // Phase B (上方逸脱) → ロング検討
    if (trend === 'uptrend') {
      // EMA20 > EMA50 の確認が必要 (evaluateTrendで既に確認済み)
      if (netBenefitIfLong > 0) {
        Logger.info(`✅ LONG決定: netBenefit=${(netBenefitIfLong*100).toFixed(4)}%/h`);
        return 'LONG';
      }
      Logger.info(`⏸️ 上昇トレンドだがLONG採算NG → NO_HEDGE`);
      return 'NO_HEDGE';
    }

    // Phase C (下方逸脱) → ショート検討
    if (trend === 'downtrend') {
      // EMA20 < EMA50 の確認が必要 (evaluateTrendで既に確認済み)
      if (netBenefitIfShort > 0) {
        Logger.info(`✅ SHORT決定: netBenefit=${(netBenefitIfShort*100).toFixed(4)}%/h`);
        return 'SHORT';
      }
      Logger.info(`⏸️ 下落トレンドだがSHORT採算NG (funding高) → NO_HEDGE`);
      return 'NO_HEDGE';
    }

    // sideways: 初回はSHORTから開始
    if (netBenefitIfShort > 0) return 'SHORT';
    return 'NO_HEDGE';
  }

  // ===== 仕様書準拠: 安全ゲート =====

  /**
   * PREFLIGHT_CHECK: 全条件OK確認
   * 仕様書 STEP A-1
   */
  private async preflightCheck(currentPrice: number): Promise<boolean> {
    // 1. 価格データ鮮度チェック
    const priceAge = this.priceMonitor.getPriceDataAge();
    if (priceAge > 60) {
      Logger.warn(`⚠️ PREFLIGHT FAIL: 価格データが${priceAge.toFixed(0)}秒古い (上限60秒)`);
      this.notify(`⏸️ 価格データが古いため一時停止 (${priceAge.toFixed(0)}秒)`);
      return false;
    }
    // 2. 価格が有効か
    if (currentPrice <= 0) {
      Logger.warn('⚠️ PREFLIGHT FAIL: 有効な価格を取得できません');
      return false;
    }
    Logger.info(`✅ PREFLIGHT OK: price=$${currentPrice.toFixed(4)}, age=${priceAge.toFixed(0)}s`);
    return true;
  }

  /**
   * 常時監視の安全ゲート群
   * 仕様書の「安全ゲート（最優先）」
   */
  private async checkSafetyGates(currentPrice: number): Promise<'EMERGENCY' | 'PAUSE' | 'OK'> {
    // 1. 価格データ古さチェック (300秒まで緩和)
    const priceAge = this.priceMonitor.getPriceDataAge();
    if (priceAge > 300) {
      Logger.warn(`🚨 SAFETY: 価格データが${priceAge.toFixed(0)}秒古い → PAUSE`);
      this.notify(`⏸️ 価格データ異常 (${priceAge.toFixed(0)}秒) → 一時停止`);
      return 'PAUSE';
    }

    // 2. 証拠金比率チェック (20%未満で緊急停止に緩和)
    const marginRatio = await this.hedgeManager.getMarginRatio();
    if (marginRatio < 20) {
      Logger.error(`🚨 SAFETY: 証拠金比率${marginRatio.toFixed(1)}% < 20% → EMERGENCY`);
      this.notify(`🚨 証拠金比率危険: ${marginRatio.toFixed(1)}% → 緊急撤退`);
      return 'EMERGENCY';
    }

    // 3. drawdownチェック (80%超で緊急停止に緩和)
    const totalValue = this.config.totalOperationalCapitalUsdc + this.pnlEngine.calculateNetPnl(currentPrice).netPnl;
    if (this.peakPortfolioValue === 0) this.peakPortfolioValue = totalValue;
    if (totalValue > this.peakPortfolioValue) this.peakPortfolioValue = totalValue;
    
    const drawdown = this.peakPortfolioValue > 0
      ? (this.peakPortfolioValue - totalValue) / this.peakPortfolioValue
      : 0;
    
    if (drawdown > 0.80) {
      Logger.error(`🚨 SAFETY: Drawdown ${(drawdown*100).toFixed(2)}% > 80% → EMERGENCY`);
      this.notify(`🚨 ドローダウン超過: ${(drawdown*100).toFixed(2)}% → 緊急撤退`);
      return 'EMERGENCY';
    }

    return 'OK';
  }

  /**
   * Deltaドリフト補正
   * 仕様書: 10%以上ズレたら adjust_bluefin_position
   */
  private async checkAndAdjustDelta(currentPrice: number): Promise<void> {
    if (this.currentLowerBound <= 0 || this.currentLpValueUsdc <= 0) return;

    const { delta, hedgeUsd: newHedgeUsd } = this.hedgeManager.calcHedgeDelta(
      currentPrice, this.currentLowerBound, this.currentUpperBound, this.currentLpValueUsdc
    );

    const currentHedgeUsd = this.currentHedgeUsd || this.hedgeManager.getStatus(currentPrice).size;
    const drift = Math.abs(newHedgeUsd - currentHedgeUsd);
    const driftPct = currentHedgeUsd > 0 ? drift / currentHedgeUsd : 0;

    // 1時間サマリー用deltaエラー記録
    this.hourlyStats.deltaErrors.push(Math.abs(delta - 0.5));

    if (driftPct > 0.10) {
      Logger.warn(`⚡ DeltaDrift: ${(driftPct*100).toFixed(1)}% > 10% → 調整 ($${currentHedgeUsd.toFixed(2)} → $${newHedgeUsd.toFixed(2)})`);
      this.notify(`⚡ Deltaドリフト補正: $${currentHedgeUsd.toFixed(2)} → $${newHedgeUsd.toFixed(2)}`);
      
      const direction = this.hedgeDirection !== 'NONE' ? this.hedgeDirection : 'SHORT';
      const hedgeStatus = this.hedgeManager.getStatus(currentPrice);
      if (hedgeStatus.active) {
        await this.hedgeManager.adjustPosition(newHedgeUsd, currentPrice);
        this.currentHedgeUsd = newHedgeUsd;
        this.hourlyStats.hedgeAdjustCount++;

        const fundingRate = await this.hedgeManager.getFundingRate();
        const logEntry = {
          ts: new Date().toISOString(),
          action: 'HEDGE_ADJUST',
          trigger: 'Δドリフト',
          delta_before: Number((currentHedgeUsd / (this.currentLpValueUsdc || 1)).toFixed(4)),
          delta_after: Number(delta.toFixed(4)),
          hedge_direction: direction,
          hedge_usd: Number(newHedgeUsd.toFixed(2)),
          funding_rate_hourly: Number((fundingRate * 100).toFixed(4)),
        };
        Logger.info(`[ACTION_LOG] ${JSON.stringify(logEntry)}`);
        await this.tracker.recordEvent('DeltaAdjust', JSON.stringify(logEntry), currentPrice);
      }
    } else {
      Logger.info(`✅ DeltaDrift: ${(driftPct*100).toFixed(1)}% < 10% → OK`);
    }
  }

  /**
   * 1時間サマリーを生成してログ出力
   */
  private async generateHourlySummary(currentPrice: number): Promise<any> {
    const elapsed = (Date.now() - this.hourlyStats.startTime) / 3600000;
    const avgDeltaError = this.hourlyStats.deltaErrors.length > 0
      ? this.hourlyStats.deltaErrors.reduce((a, b) => a + b, 0) / this.hourlyStats.deltaErrors.length
      : 0;

    const pnl = this.pnlEngine.calculateNetPnl(currentPrice);
    const summary = {
      period: '1h',
      lp_fee_earned: Number(this.hourlyStats.lpFeeEarned.toFixed(4)),
      hedge_pnl: Number(this.hourlyStats.hedgePnl.toFixed(4)),
      funding_paid: Number(this.hourlyStats.fundingPaid.toFixed(4)),
      gas_spent: Number(this.hourlyStats.gasSpent.toFixed(4)),
      net_pnl: Number((this.hourlyStats.lpFeeEarned + this.hourlyStats.hedgePnl - this.hourlyStats.fundingPaid - this.hourlyStats.gasSpent).toFixed(4)),
      rebalance_count: this.hourlyStats.rebalanceCount,
      hedge_adjust_count: this.hourlyStats.hedgeAdjustCount,
      avg_delta_error: Number(avgDeltaError.toFixed(4)),
    };

    Logger.info(`[HOURLY_SUMMARY] ${JSON.stringify(summary)}`);
    this.notify(`📊 1時間サマリー\nLP手数料: $${summary.lp_fee_earned}\nヘッジPnL: $${summary.hedge_pnl}\n純利益: $${summary.net_pnl}`);
    await this.tracker.recordEvent('1hサマリー', JSON.stringify(summary), currentPrice);

    // リセット
    this.hourlyStats = {
      startTime: Date.now(),
      lpFeeEarned: 0,
      hedgePnl: 0,
      fundingPaid: 0,
      gasSpent: 0,
      rebalanceCount: 0,
      hedgeAdjustCount: 0,
      deltaErrors: [],
    };

    return summary;
  }

  // 最新の1時間サマリー (APIから参照)
  public lastHourlySummary: any = null;

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
      const errorMsg = e.message || 'Unknown error';
      Logger.error(`戦略実行中に重大なエラーが発生しました: ${errorMsg}`);
      
      // 注意: LPが既に作成されている場合(currentLowerBound > 0)、
      // ここで0にリセットしてしまうと、次回ループでまたLPを解体して作り直す「無限ループ」に陥る。
      // LPが既にあるなら0にせず、監視フェーズからの「自己修復」に任せる。
      if (this.currentLowerBound === 0) {
        this.currentLowerBound = 0;
        this.currentUpperBound = 0;
      }

      await this.tracker.recordEvent('エラー', `リバランス失敗: ${errorMsg}`, currentPrice);
      this.notify(`❌ 戦略エラー: ${errorMsg}`);
      this.lastRebalanceTime = Date.now();
    }
  }

  /**
   * [戦略A] デルタニュートラル方向反転型戦略 (Delta-Neutral Flip)
   * 
   * レンジ逸脱方向に応じてヘッジ方向を自動反転:
   *  - 初回 or 下方向逸脱 → ショート (下落ヘッジ)
   *  - 上方向逸脱 → ロング (トレンドフォロー)
   */
  private async executeBalancedStrategy(currentPrice: number) {
    // レンジ逸脱方向を判定
    if (this.currentLowerBound > 0 && this.currentUpperBound > 0) {
      if (currentPrice > this.currentUpperBound) {
        this.lastExitDirection = 'upper';
        Logger.info(`📈 上方向レンジ逸脱を検知 (${currentPrice.toFixed(4)} > ${this.currentUpperBound.toFixed(4)})`);
      } else if (currentPrice < this.currentLowerBound) {
        this.lastExitDirection = 'lower';
        Logger.info(`📉 下方向レンジ逸脱を検知 (${currentPrice.toFixed(4)} < ${this.currentLowerBound.toFixed(4)})`);
      }
    }

    // ディスパッチ: 逸脱方向に応じたサブフローを実行
    if (this.lastExitDirection === 'upper') {
      await this.executeFlipToLong(currentPrice);
    } else if (this.lastExitDirection === 'lower') {
      await this.executeFlipToShort(currentPrice);
    } else {
      // 逸脱していない場合（lastExitDirection === null）
      // すでにポジションがある場合は、何もしない（監視継続）
      if (this.currentLowerBound > 0 && this.currentUpperBound > 0) {
        Logger.box('Stable Monitoring', `Price $${currentPrice.toFixed(4)} is within range: $${this.currentLowerBound.toFixed(4)} - $${this.currentUpperBound.toFixed(4)}`);
        this.currentPhase = CyclePhase.MONITORING;
        this.finalizeRebalance(currentPrice, 0, 0, 0); // 状態同期のみ
        return;
      }

      // ポジションがない場合は初回構築 (常にショートから開始)
      await this.executeInitialEntry(currentPrice);
    }
  }

  // ========================================
  // 方向反転型戦略のサブフロー
  // ========================================

  /**
   * 共通: 資産評価と50:50バランス調整
   * 全フローの前段処理として使用
   */
  private async evaluateAndBalance(currentPrice: number): Promise<{
    totalCapital: number;
    lpValue: number;
    hedgeNotional: number;
  }> {
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.hedgeManager.syncPositionWithBluefin().catch(() => {});

    const { suiBalance, usdcBalance } = await this.lpManager.checkBalance();
    const GAS_RESERVE_SUI = 1.0;
    const usableSui = Math.max(0, suiBalance - GAS_RESERVE_SUI);
    const bluefinMargin = this.hedgeManager.lastMarginBalance;
    const totalEquity = usdcBalance + (usableSui * currentPrice) + bluefinMargin;
    const totalCapital = totalEquity * 0.99;

    if (totalCapital < 1.0) throw new Error('運用可能資金が不足しています');

    // LP全力投入のため、50:50にバランス調整
    const targetSuiValue = totalCapital * 0.50; // 50%をSUIに
    const currentSuiValue = usableSui * currentPrice;

    this.currentPhase = CyclePhase.SWAPPING;

    if (currentSuiValue > targetSuiValue + 0.1) {
      // SUIが多すぎる → SUI売却
      const suiToSell = Math.max(0, (currentSuiValue - targetSuiValue) / currentPrice);
      if (suiToSell > 0.1) {
        Logger.info(`🔄 資産バランス調整: ${suiToSell.toFixed(4)} SUIを売却`);
        const sellRes = await this.lpManager.swapSuiToUsdc(suiToSell);
        this.pnlEngine.recordGas(sellRes.gasCostUsdc); // ガス代を記録
        await this.tracker.recordEvent('資産調整', `${suiToSell.toFixed(2)} SUIを売却してUSDCに変換`, currentPrice, sellRes.digest);
      }
    } else if (currentSuiValue < targetSuiValue - 0.1) {
      // USDCが多すぎる → SUI購入
      const usdcToSpend = targetSuiValue - currentSuiValue;
      if (usdcToSpend > 0.1) {
        Logger.info(`🔄 資産バランス調整: ${usdcToSpend.toFixed(2)} USDCでSUIを購入`);
        const buyRes = await this.lpManager.swapUsdcToSui(usdcToSpend);
        this.pnlEngine.recordGas(buyRes.gasCostUsdc); // ガス代を記録
        await this.tracker.recordEvent('資産調整', `${usdcToSpend.toFixed(2)} USDCでSUIを購入`, currentPrice, buyRes.digest);
      }
    }

    // スワップ後の実際の残高を再取得（正確なLP投入額にするため）
    await new Promise(resolve => setTimeout(resolve, 2000)); // RPC同期待ち
    const postSwapBalance = await this.lpManager.checkBalance();
    const finalUsableSui = Math.max(0, postSwapBalance.suiBalance - GAS_RESERVE_SUI);
    const finalSuiValue = finalUsableSui * currentPrice;
    const finalUsdc = postSwapBalance.usdcBalance;

    // 実際に投入可能なLP価値（少ない方に合わせた金額の2倍に0.97のバッファをかける。スリッページ対応のため3%温存）
    const lpValue = Math.min(finalSuiValue, finalUsdc) * 2 * 0.97;

    // ヘッジ額 = LP価値の (hedgeRatio)% 相当。
    // hedgeRatio 1.0 (100%) の場合、LPのSUI評価額(lpValue*0.5)とヘッジ額が一致しデルタニュートラルになる。
    let targetHedgeQuantity = Math.round((lpValue * 0.5 * this.config.hedgeRatio) / currentPrice);
    if (targetHedgeQuantity < 1) targetHedgeQuantity = 1; // 最小1 SUI
    const hedgeNotional = targetHedgeQuantity * currentPrice;

    return { totalCapital, lpValue, hedgeNotional };
  }

  /**
   * [初回構築] ショートヘッジで開始
   * 資本の50%をSUIに → USDC+SUIでLP → Bluefinでショート
   */
  private async executeInitialEntry(currentPrice: number) {
    this.notify(`🚀 デルタニュートラル戦略: 初期構築開始 (ショート) 価格: $${currentPrice.toFixed(4)}`);
    Logger.box('Delta-Neutral Flip: Initial Entry (SHORT)', `Price: $${currentPrice.toFixed(4)}`);

    // STEP 0: 取引所との同期を先に行う
    await this.hedgeManager.syncPositionWithBluefin().catch(e => {
      Logger.warn(`Bluefin: 初期同期エラー: ${e.message}`);
    });

    // STEP 1: 既存ポジションのクリーンアップ
    await this.closeAllPositions(currentPrice);

    // STEP 2: 資産評価と50:50バランス調整
    const { totalCapital, lpValue, hedgeNotional } = await this.evaluateAndBalance(currentPrice);

    // STEP 3: LP構築
    let lowerBound: number, upperBound: number;
    if (this.config.configMode === 'auto') {
      const range = this.calculateATRRange(currentPrice);
      lowerBound = range.lower;
      upperBound = range.upper;
    } else {
      lowerBound = currentPrice * (1 - this.config.rangeWidth);
      upperBound = currentPrice * (1 + this.config.rangeWidth);
    }
    await this.buildLpPosition(currentPrice, lowerBound, upperBound, lpValue * 0.50);

    // STEP 4: Bluefinショートヘッジ
    await this.buildHedgePosition(currentPrice, hedgeNotional, 'SHORT');

    this.hedgeDirection = 'SHORT';
    this.finalizeRebalance(currentPrice, lpValue, hedgeNotional, totalCapital, 'SHORT');
  }

  /**
   * [上方向逸脱 → ロング反転]
   * LP解除(SUIが戻る) → SUI半分売却 → 新LP構築 → Bluefinロング
   */
  private async executeFlipToLong(currentPrice: number) {
    this.notify(`📈 デルタニュートラル戦略: ロング反転 (上方向逸脱) 価格: $${currentPrice.toFixed(4)}`);
    Logger.box('Delta-Neutral Flip: → LONG', `Price: $${currentPrice.toFixed(4)} (Exited Upper)`);

    // STEP 1: ショートヘッジをクローズ → LP解除
    this.currentPhase = CyclePhase.CLOSING_HEDGE;
    const hedgeRes = await this.hedgeManager.closeHedge(currentPrice);
    if (hedgeRes.digest) {
      await this.tracker.recordEvent('ヘッジ決済', `ショートクローズ (PnL: $${hedgeRes.pnl.toFixed(4)})`, currentPrice, hedgeRes.digest);
    }

    this.currentPhase = CyclePhase.REMOVING_LP;
    const removeRes = await this.lpManager.removeLiquidity();
    if (removeRes.digest) {
      await this.tracker.recordEvent('LP解除', '上方向逸脱のためLP解除 → SUIが返却', currentPrice, removeRes.digest);
    }

    // STEP 2: 資産を50:50にリバランス (SUI過多→USDC)
    const { totalCapital, lpValue, hedgeNotional } = await this.evaluateAndBalance(currentPrice);

    // STEP 3: 新しいLP構築 (より高い価格帯)
    let lowerBound: number, upperBound: number;
    if (this.config.configMode === 'auto') {
      const range = this.calculateATRRange(currentPrice);
      lowerBound = range.lower;
      upperBound = range.upper;
    } else {
      lowerBound = currentPrice * (1 - this.config.rangeWidth);
      upperBound = currentPrice * (1 + this.config.rangeWidth);
    }
    await this.buildLpPosition(currentPrice, lowerBound, upperBound, lpValue * 0.50);

    // STEP 4: Bluefinロングヘッジ (上昇トレンドフォロー)
    await this.buildHedgePosition(currentPrice, hedgeNotional, 'LONG');

    this.hedgeDirection = 'LONG';
    this.finalizeRebalance(currentPrice, lpValue, hedgeNotional, totalCapital, 'LONG');
  }

  /**
   * [下方向逸脱 → ショート反転]
   * LP解除(USDCが戻る) → USDC半分でSUI購入 → 新LP構築 → Bluefinショート
   */
  private async executeFlipToShort(currentPrice: number) {
    this.notify(`📉 デルタニュートラル戦略: ショート反転 (下方向逸脱) 価格: $${currentPrice.toFixed(4)}`);
    Logger.box('Delta-Neutral Flip: → SHORT', `Price: $${currentPrice.toFixed(4)} (Exited Lower)`);

    // STEP 1: ロングヘッジをクローズ → LP解除
    this.currentPhase = CyclePhase.CLOSING_HEDGE;
    const hedgeRes = await this.hedgeManager.closeHedge(currentPrice);
    if (hedgeRes.digest) {
      await this.tracker.recordEvent('ヘッジ決済', `ロングクローズ (PnL: $${hedgeRes.pnl.toFixed(4)})`, currentPrice, hedgeRes.digest);
    }

    this.currentPhase = CyclePhase.REMOVING_LP;
    const removeRes = await this.lpManager.removeLiquidity();
    if (removeRes.digest) {
      await this.tracker.recordEvent('LP解除', '下方向逸脱のためLP解除 → USDCが返却', currentPrice, removeRes.digest);
    }

    // STEP 2: 資産を50:50にリバランス (USDC過多→SUI)
    const { totalCapital, lpValue, hedgeNotional } = await this.evaluateAndBalance(currentPrice);

    // STEP 3: 新しいLP構築 (より低い価格帯)
    let lowerBound: number, upperBound: number;
    if (this.config.configMode === 'auto') {
      const range = this.calculateATRRange(currentPrice);
      lowerBound = range.lower;
      upperBound = range.upper;
    } else {
      lowerBound = currentPrice * (1 - this.config.rangeWidth);
      upperBound = currentPrice * (1 + this.config.rangeWidth);
    }
    await this.buildLpPosition(currentPrice, lowerBound, upperBound, lpValue * 0.50);

    // STEP 4: Bluefinショートヘッジ (下落トレンドフォロー)
    await this.buildHedgePosition(currentPrice, hedgeNotional, 'SHORT');

    this.hedgeDirection = 'SHORT';
    this.finalizeRebalance(currentPrice, lpValue, hedgeNotional, totalCapital, 'SHORT');
  }

  // ========================================
  // LP/ヘッジ構築の共通ヘルパー
  // ========================================

  /**
   * LP ポジション構築の共通処理
   */
  private async buildLpPosition(
    currentPrice: number,
    lowerBound: number,
    upperBound: number,
    usdcAmount: number
  ): Promise<void> {
    Logger.info(`🎯 LP構築: $${lowerBound.toFixed(4)} 〜 $${upperBound.toFixed(4)} (USDC: $${usdcAmount.toFixed(2)})`);
    this.currentPhase = CyclePhase.ADDING_LP;

    const lpRes = await this.lpManager.addLiquidity(lowerBound, upperBound, usdcAmount, true);
    this.pnlEngine.recordGas(lpRes.gasCostUsdc); // ガス代を記録

    // 成功時のみ状態更新
    this.currentLowerBound = lowerBound;
    this.currentUpperBound = upperBound;

    await this.tracker.recordRebalance(
      currentPrice, 0, 0, lpRes.digest, // 手数料ではなく0を記録
      `LP構築完了 [$${lowerBound.toFixed(4)}, $${upperBound.toFixed(4)}]`,
      this.currentLowerBound, this.currentUpperBound, 'DELTA_NEUTRAL_FLIP'
    );
  }

  /**
   * ヘッジポジション構築の共通処理
   */
  private async buildHedgePosition(
    currentPrice: number,
    hedgeNotional: number,
    direction: 'SHORT' | 'LONG'
  ): Promise<void> {
    const dirLabel = direction === 'SHORT' ? 'ショート' : 'ロング';
    Logger.info(`⏳ Indexer同期待機 (5秒)...`);
    await new Promise(resolve => setTimeout(resolve, 5000));

    this.currentPhase = CyclePhase.OPENING_HEDGE;

    if (hedgeNotional > 0.1 && !isNaN(hedgeNotional)) {
      Logger.info(`🎯 Bluefin: ${dirLabel}ヘッジ構築 ($${hedgeNotional.toFixed(2)})`);

      // 証拠金が足りない場合は追加入金
      const marginNeeded = hedgeNotional * 0.55; // 3倍レバレッジでの必要証拠金
      await this.hedgeManager.depositMargin(marginNeeded);

      const hedgeRes = await this.hedgeManager.openHedge(hedgeNotional, currentPrice, direction);
      this.pnlEngine.recordGas(hedgeRes.gasCostUsdc); // ガス代を記録

      let actualSize = Math.round(hedgeNotional / currentPrice);
      if (actualSize < 1) actualSize = 1;
      
      await this.tracker.recordHedge(
        direction, `${dirLabel}ヘッジ構築`,
        currentPrice, actualSize, hedgeRes.digest
      );
    } else {
      Logger.warn(`Bluefin: ヘッジ額が少なすぎるためスキップ ($${hedgeNotional.toFixed(2)})`);
    }
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
    Logger.info('--- ポジションの全クローズ ---');
    // ヘッジを先にクローズ（LP解除前にリスクを解消）
    const hedgeRes = await this.hedgeManager.closeHedge(currentPrice);
    if (hedgeRes.digest && hedgeRes.digest !== 'none') {
      const dir = this.hedgeDirection !== 'NONE' ? this.hedgeDirection : 'HEDGE';
      await this.tracker.recordEvent('ヘッジ決済', `${dir}クローズ (PnL: $${hedgeRes.pnl.toFixed(4)})`, currentPrice, hedgeRes.digest);
    }

    const removeRes = await this.lpManager.removeLiquidity();
    if (removeRes.digest) {
      this.pnlEngine.recordGas(removeRes.gasCostUsdc); // ガス代を記録
      await this.tracker.recordEvent('LP解除', 'クリーンアップのためLP解除', currentPrice, removeRes.digest);
    }

    // 最終確認: 取引所にポジションが残っていないことを同期して確認
    let retryCount = 0;
    const maxRetries = 5;
    while (retryCount < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // 取引所の反映待ち
      await this.hedgeManager.syncPositionWithBluefin();
      
      const status = this.hedgeManager.getStatus(currentPrice);
      if (!status.active) {
        Logger.info('✅ 全ポジションのクローズを確認しました。');
        return;
      }
      
      retryCount++;
      Logger.warn(`⚠️ ポジションがまだ残っています (試行 ${retryCount}/${maxRetries})。再確認します...`);
    }

    throw new Error("Critical: ポジションのクローズに失敗しました。取引所に残高が残っているか、インデクサーの更新が遅れています。");
  }

  /**
   * リバランス完了の共通処理
   */
  private finalizeRebalance(currentPrice: number, lpValue: number, hedgeValue: number, total: number, direction: 'SHORT' | 'LONG' = 'SHORT') {
    this.lastExitDirection = null; // リバランス完了時に方向フラグをリセット 
    this.currentPhase = CyclePhase.MONITORING;
    this.lastRebalanceTime = Date.now();
    
    this.pnlEngine.recordLpEntry(currentPrice, lpValue);
    this.pnlEngine.recordHedgeEntry(currentPrice, hedgeValue, direction);

    const dirLabel = direction === 'SHORT' ? 'ショート' : 'ロング';
    const msg = `✅ 戦略構築完了 (${dirLabel}ヘッジ)\nレンジ: $${this.currentLowerBound.toFixed(4)} 〜 $${this.currentUpperBound.toFixed(4)}`;
    Logger.success(msg);
    this.notify(msg);

    // 状態変更を通知（永続化をトリガー）
    if (this.onStateChange) {
      this.onStateChange();
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

    // 運用初期化: 既存ポジションがない場合のみリセット
    if (this.currentLowerBound === 0) {
      Logger.info('🚀 新規セッションとして初期化します');
      this.currentLowerBound = 0;
      this.currentUpperBound = 0;
      this.lastRebalanceTime = 0;
      this.lastExitDirection = null;
      this.hedgeDirection = 'NONE';
      this.lpManager.currentPositionNft = null; 
      this.isEmergencyStopped = false;
    } else {
      Logger.info(`🔄 既存セッションを継続します (Range: ${this.currentLowerBound} - ${this.currentUpperBound})`);
    }

    // 起動直後のポジション同期
    await this.hedgeManager.syncPositionWithBluefin();

    // 起動直後に一回実行して最初の価格をチャートに載せる
    const firstPrice = await this.priceMonitor.getCurrentPrice();
    if (firstPrice > 0) {
      this.priceHistoryForAnalysis.push(firstPrice);
      this.tracker.updateCurrentPrice(firstPrice);
      
      const strategyName = this.config.strategyMode === 'range_order' ? '指値レンジ戦略 (Range Order)' : 'デルタニュートラル方向反転戦略 (Delta-Neutral Flip)';
      Logger.box('Strategy Reset Triggered', `Starting ${strategyName} at $${firstPrice.toFixed(4)}`);
      this.tracker.recordEvent('戦略開始', `${this.config.totalOperationalCapitalUsdc} USDC での ${strategyName} を開始します。`);
      
      // 非同期でリバランスを開始 (1秒後)
      setTimeout(async () => {
        // すでにレンジが復旧されている場合(restart)はInitialEntryを回避
        if (this.currentLowerBound > 0 && this.currentUpperBound > 0) {
          Logger.info('🔄 [PERSISTENCE] 既存のレンジ情報を検出しました。全決済をスキップし、直接監視に移行します。');
          
          // PnLエンジンのエントリー価格が未設定（0）の場合、現在の価格をエントリー点として記録
          const pnl = this.pnlEngine.calculateNetPnl(firstPrice);
          if (pnl.netPnl === 0) {
            Logger.info('📊 [PNL FIX] 既存ポジションのエントリー情報を現在の価格で初期化します');
            this.pnlEngine.recordLpEntry(firstPrice, this.config.lpAmountUsdc);
            this.pnlEngine.recordHedgeEntry(firstPrice, this.config.lpAmountUsdc * this.config.hedgeRatio, this.hedgeDirection !== 'NONE' ? this.hedgeDirection as 'SHORT' | 'LONG' : 'SHORT');
          }
          
          this.currentPhase = CyclePhase.MONITORING;
          return;
        }
        await this.runRebalance(firstPrice);
      }, 1000);

      // 初回残高スナップショット
      this.lpManager.checkBalance().then(balance => {
        const pnl = this.pnlEngine.calculateNetPnl(firstPrice);
        const totalValue = this.config.lpAmountUsdc + pnl.netPnl;
        this.tracker.recordBalance(balance.suiBalance, balance.usdcBalance, this.hedgeManager.lastMarginBalance, totalValue, firstPrice);
      }).catch(() => {});
    }

      // 運用監視フェーズへ移行
      this.currentPhase = CyclePhase.MONITORING;
      this.notify('🚀 ボットの運用監視を開始しました');

      // === 監視ループ開始 (30秒ごと) ===
      this.intervalId = setInterval(async () => {
      try {
        // Bluefin SDK準備待機
        let waitCount = 0;
        while (!this.hedgeManager.isReady() && waitCount < 30) {
          if (waitCount === 0) Logger.info('⏳ Bluefin SDK の準備完了を待機しています...');
          await new Promise(resolve => setTimeout(resolve, 1000));
          waitCount++;
        }

        const currentPrice = await this.priceMonitor.getCurrentPrice();

        if (currentPrice <= 0) {
          Logger.warn('価格取得失敗 - スキップ');
          this.consecutiveErrors++;
          if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
            Logger.error(`🚨 連続エラー${this.MAX_CONSECUTIVE_ERRORS}回 → 即停止`);
            this.notify(`🚨 価格取得エラーが連続${this.MAX_CONSECUTIVE_ERRORS}回 → ボット停止`);
            this.stop();
          }
          return;
        }

        this.tracker.updateCurrentPrice(currentPrice);
        this.priceHistoryForAnalysis.push(currentPrice);
        if (this.priceHistoryForAnalysis.length > 200) {
          this.priceHistoryForAnalysis.shift();
        }

        // 推定手数料を累積
        if (this.currentLowerBound > 0 && this.currentUpperBound > 0) {
          const feeRate = 0.0025;
          const estimatedIntervalFee = this.config.lpAmountUsdc * feeRate * (this.config.monitorIntervalMs / (24 * 60 * 60 * 1000));
          this.accumulatedEstimatedFees += estimatedIntervalFee;
          this.hourlyStats.lpFeeEarned += estimatedIntervalFee;
        }

        // 緊急停止中
        if (this.isEmergencyStopped) {
          Logger.info(`⏹️ 緊急停止中 - 現在価格: $${currentPrice.toFixed(4)}`);
          return;
        }

        // ===== 安全ゲート （最優先） =====
        const gateResult = await this.checkSafetyGates(currentPrice);
        if (gateResult === 'EMERGENCY') {
          await this.executeEmergencyStop();
          return;
        }
        if (gateResult === 'PAUSE') {
          return; // 次のチックまで待機
        }

        // 正常処理でエラーカウンターリセット
        this.consecutiveErrors = 0;

        // ===== Deltaドリフト補正 (ヘッジリバランス) =====
        if (this.currentLowerBound > 0 && this.hedgeManager.getStatus(currentPrice).active) {
          await this.checkAndAdjustDelta(currentPrice);
        }

        // ===== レンジ逸脱検知 (5分継続確認) =====
        const hasLpPos = await this.lpManager.hasExistingPosition();
        const isOutOfRange = this.currentLowerBound > 0 &&
          this.priceMonitor.isOutOfRange(currentPrice, this.currentLowerBound, this.currentUpperBound);

        if (this.currentLowerBound === 0 || !hasLpPos) {
          // LPがない → 初回構築
          this.lastBreachTime = null;
          await this.runRebalance(currentPrice);
        } else if (isOutOfRange) {
          // 逸脱検知
          const now = Date.now();
          if (this.lastBreachTime === null) {
            this.lastBreachTime = now;
            Logger.warn(`⚠️ レンジ逸脱検知: $${currentPrice.toFixed(4)} (逸脱開始時刻記録)`);
          } else if ((now - this.lastBreachTime) > this.BREACH_CONFIRM_MS) {
            // 5分継続確認
            const twap5min = this.priceMonitor.fetchTWAP(5 * 60 * 1000);
            const twapAlsoOutOfRange = this.priceMonitor.isOutOfRange(twap5min, this.currentLowerBound, this.currentUpperBound);

            if (twapAlsoOutOfRange) {
              Logger.error(`🚨 5分逸脱確認 + TWAP逸脱 → リバランス実行 (${currentPrice > this.currentUpperBound ? 'Phase B' : 'Phase C'})`);
              this.lastBreachTime = null;
              if (currentPrice > this.currentUpperBound) {
                this.lastExitDirection = 'upper';
              } else {
                this.lastExitDirection = 'lower';
              }
              await this.runRebalance(currentPrice);
            } else {
              Logger.info(`⏸️ TWAPがレンジ内 ($${twap5min.toFixed(4)}) → リバランス保留`);
            }
          } else {
            const elapsed = (now - this.lastBreachTime) / 1000;
            Logger.warn(`⏱️ 逸脱継続中: ${elapsed.toFixed(0)}/300秒 レンジ: [$${this.currentLowerBound.toFixed(4)}, $${this.currentUpperBound.toFixed(4)}]`);
          }
        } else {
          // レンジ内
          this.lastBreachTime = null;

          // 手数料回収
          if (this.shouldCollectFees()) {
            Logger.info(`💰 手数料回収実行 (${((Date.now() - this.lastFeeCollectTime) / 60000).toFixed(1)}分経過)...`);
            const feeRes = await this.lpManager.collectFees();
            this.lastFeeCollectTime = Date.now();
            this.accumulatedEstimatedFees = 0;

            if (feeRes.amount > 0) {
              this.pnlEngine.recordFee(feeRes.amount);
              this.pnlEngine.recordGas(feeRes.gasCostUsdc);
              this.hourlyStats.lpFeeEarned += feeRes.amount;
              this.hourlyStats.gasSpent += feeRes.gasCostUsdc;
              await this.tracker.recordFee(feeRes.amount);
              Logger.info(`💰 手数料回収: +$${feeRes.amount.toFixed(4)} (ガス: $${feeRes.gasCostUsdc.toFixed(4)})`);
            }
          }

          // ヘッジ状態自動修復 (LPがあるのにヘッジがない場合)
          try {
            const hedgeStatus = this.hedgeManager.getStatus(currentPrice);
            if (hasLpPos && !hedgeStatus.active && (this.currentPhase === CyclePhase.MONITORING || this.currentPhase === CyclePhase.IDLE)) {
              Logger.warn('🚨 LP有りヘッジなし検知 → 修復試行');
              this.notify(`🔧 ヘッジ欠落を検知: 補完開設を試行します`);
              const totalSuiInLp = await this.lpManager.getSuiAmountInLp();
              if (totalSuiInLp > 0) {
                const hedgeSuiSize = totalSuiInLp * this.config.hedgeRatio;
                const targetNotional = hedgeSuiSize * currentPrice;
                const repairDirection = this.hedgeDirection !== 'NONE' ? this.hedgeDirection : 'SHORT';
                Logger.info(`🔧 [REPAIR] ${repairDirection} ${hedgeSuiSize.toFixed(4)} SUI ($${targetNotional.toFixed(2)})`);
                const hedgeOpenRes = await this.hedgeManager.openHedge(targetNotional, currentPrice, repairDirection as 'SHORT' | 'LONG');
                await this.tracker.recordHedge(repairDirection, `【自己修復】${repairDirection}ヘッジを補完`, currentPrice, hedgeSuiSize, hedgeOpenRes.digest);
              }
            }
          } catch (e: any) {
            Logger.error('[REPAIR] 自己修復中にエラーが発生しました', e);
          }

          // 証拠金維持チェック
          await this.hedgeManager.checkAndMaintainMargin(currentPrice);

          // 資産残高スナップショット
          try {
            const balance = await this.lpManager.checkBalance();
            const bluefinMargin = this.hedgeManager.lastMarginBalance;
            const pnl = this.pnlEngine.calculateNetPnl(currentPrice);
            const totalValue = this.config.totalOperationalCapitalUsdc + pnl.netPnl;
            await this.tracker.recordBalance(balance.suiBalance, balance.usdcBalance, bluefinMargin, totalValue, currentPrice);
          } catch (e) {
            Logger.warn('資産スナップショットの記録に失敗しました');
          }

          const pnl = this.pnlEngine.calculateNetPnl(currentPrice);
          Logger.info(`✓ レンジ内 ($${currentPrice.toFixed(4)}) | 純利益: $${pnl.netPnl} | APR: ${pnl.apr}%`);
          await this.tracker.update(currentPrice, Number(pnl.netPnl));

          // 1時間サマリー生成
          const now = Date.now();
          if (now - this.lastHeartbeatTime > this.HEARTBEAT_INTERVAL_MS) {
            this.lastHourlySummary = await this.generateHourlySummary(currentPrice);
            this.lastHeartbeatTime = now;
          }
        }

      } catch (e: any) {
        this.consecutiveErrors++;
        Logger.error(`モニタリングループでエラー (${this.consecutiveErrors}/${this.MAX_CONSECUTIVE_ERRORS})`, e);
        if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
          Logger.error(`🚨 連続エラーが${this.MAX_CONSECUTIVE_ERRORS}回達した → 即停止・通知`);
          this.notify(`🚨 連続エラー${this.MAX_CONSECUTIVE_ERRORS}回: ボットを安全に停止します`);
          this.stop();
        }
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
    
    const pnlResult = this.pnlEngine.calculateNetPnl(currentPrice);
    return {
      pnl: {
        ...pnlResult,
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
