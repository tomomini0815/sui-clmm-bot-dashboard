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
  GRID_ORDERING = 'グリッド指値配置中',
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

  // 15分逸脱確認用 (往復ビンタ防止のため延長)
  private lastBreachTime: number | null = null;
  private readonly BREACH_CONFIRM_MS = 15 * 60 * 1000; 

  // ゆとりバッファ (0.2%)
  private readonly HYSTERESIS_BUFFER_PCT = 0.002;

  // 再起動クールダウン (20分)
  private readonly MIN_REBALANCE_COOLDOWN_MS = 20 * 60 * 1000;

  // drawdown計算用
  private peakPortfolioValue: number = 0;

  // 二重実行防止ロック
  private isProcessingRebalance: boolean = false;

  // 連続エラーカウンター (20回で即停止に緩和)
  private consecutiveErrors: number = 0;
  private readonly MAX_CONSECUTIVE_ERRORS = 20;

  // LP評価額キャッシュ (Deltaドリフト計算用)
  private currentLpValueUsdc: number = 0;
  private currentHedgeUsd: number = 0;
  public sessionId: string = 'master-bot'; // 追加

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

  // ===== MTF/レジーム最終状態キャッシュ (ダッシュボード表示用) =====
  public lastMtfState: {
    direction: 'LONG' | 'SHORT' | 'NEUTRAL';
    mtfScore: number;
    fundingBias: number;
    totalScore: number;
    details: string;
    fundingArbitrage: boolean;
    currentFundingRate: number;
    regime: 'LOW_VOL' | 'NORMAL_VOL' | 'HIGH_VOL';
    hedgeRatio: number;
    updatedAt: number; // timestamp
  } | null = null;

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
  public calculateVolatility(): number {
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
  public detectTrend(): 'uptrend' | 'downtrend' | 'sideways' {
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

  // ===== MTF + Funding Rate ヘッジシグナル ===== //

  /**
   * マルチタイムフレーム（5分・15分・30分）+ Funding Rate による
   * ヘッジ方向の総合スコアを計算する。
   *
   * 採点方式:
   *   各TF: 短期MA > 長期MA → +1点(上昇), 短期MA < 長期MA → -1点(下落)
   *   Funding Rate > +0.0005/h → -1点(LONG過熱=SHORTバイアス)
   *   Funding Rate < -0.0005/h → +1点(SHORT過熱=LONGバイアス)
   *
   *   合計 >= +2 → LONG推奨
   *   合計 <= -2 → SHORT推奨
   *   それ以外   → NEUTRAL（エントリー見送り）
   *
   * ※ モニタリング間隔 ~3秒を前提としたエントリー数:
   *   5分  = 100エントリー
   *   15分 = 300エントリー
   *   30分 = 600エントリー
   */
  private async getMtfHedgeSignal(): Promise<{
    direction: 'LONG' | 'SHORT' | 'NEUTRAL';
    mtfScore: number;
    fundingBias: number;
    totalScore: number;
    details: string;
    fundingArbitrage: boolean;
    currentFundingRate: number;
  }> {
    const prices = this.priceHistoryForAnalysis;
    const len = prices.length;

    // --- MTFスコア計算 ---
    // MA計算ヘルパー
    const ma = (window: number): number => {
      const slice = prices.slice(-window);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    };

    // 各タイムフレームのトレンド判定
    // TF設定: [短期窓, 長期窓, 必要な最小エントリー数]
    const timeframes: Array<[number, number, number, string]> = [
      [20,  100, 100,  '5分'],
      [60,  300, 300,  '15分'],
      [120, 600, 600,  '30分'],
    ];

    let mtfScore = 0;
    const tfDetails: string[] = [];

    for (const [shortWin, longWin, minLen, label] of timeframes) {
      if (len < minLen) {
        tfDetails.push(`${label}:待機(${len}/${minLen})`);
        continue; // データ不足はスキップ（スコアに加算しない）
      }
      const shortMa = ma(shortWin);
      const longMa  = ma(longWin);
      const bias = shortMa > longMa ? +1 : -1;
      mtfScore += bias;
      tfDetails.push(`${label}:${bias > 0 ? '↑' : '↓'}(${(shortMa).toFixed(4)}/${(longMa).toFixed(4)})`);
    }

    // --- Funding Rate バイアス & アービトラージ判定 ---
    // 市場研究の知見: 高Funding時のSHORTは「コスト」ではなく「収益源」になる
    // SUI Funding Rate > 0.10%/h（年率8.76%相当）の時はダブル収益モード
    let fundingBias = 0;
    let fundingLabel = 'N/A';
    let fundingArbitrage = false; // Funding Rate アービトラージモードフラグ
    let currentFundingRate = 0;
    try {
      currentFundingRate = await this.hedgeManager.getFundingRate();
      // fundingRate は1時間あたりの値（例: 0.0001 = 0.01%/h）

      if (currentFundingRate > 0.0010) {
        // 🔥 アービトラージモード: Funding > 0.10%/h
        // LP手数料 + Funding受取 = ダブル収益 → SHORTを強く推奨
        fundingBias = -2; // 通常の-1より強いバイアス
        fundingArbitrage = true;
        fundingLabel = `${(currentFundingRate * 100).toFixed(4)}%/h(🔥ARB-SHORT)`;
        Logger.info(`[MTF] 🔥 Funding Rate アービトラージ発動: ${(currentFundingRate * 100).toFixed(4)}%/h → SHORT強制推奨`);
      } else if (currentFundingRate > 0.0005) {
        // ロング過熱 → SHORTバイアス
        fundingBias = -1;
        fundingLabel = `${(currentFundingRate * 100).toFixed(4)}%/h(SHORT優勢)`;
      } else if (currentFundingRate < -0.0005) {
        // ショート過熱 → LONGバイアス
        fundingBias = +1;
        fundingLabel = `${(currentFundingRate * 100).toFixed(4)}%/h(LONG優勢)`;
      } else {
        fundingLabel = `${(currentFundingRate * 100).toFixed(4)}%/h(中立)`;
      }
    } catch (e) {
      Logger.warn('[MTF] Funding Rate 取得失敗 — バイアスなしで継続');
    }

    const totalScore = mtfScore + fundingBias;

    // --- 方向決定 ---
    // アービトラージモード時はスコアに関わらずSHORTを強制
    let direction: 'LONG' | 'SHORT' | 'NEUTRAL';
    if (fundingArbitrage) {
      direction = 'SHORT'; // Funding収益目的でSHORT確定
    } else if (totalScore >= 2) {
      direction = 'LONG';
    } else if (totalScore <= -2) {
      direction = 'SHORT';
    } else {
      direction = 'NEUTRAL';
    }

    const details = `[MTF] ${tfDetails.join(' | ')} | Funding:${fundingLabel} | MTF:${mtfScore} Bias:${fundingBias} Total:${totalScore} → ${direction}`;
    Logger.info(details);

    const regime = this.getVolatilityRegime();
    const hedgeRatio = this.calculateOptimalHedgeRatio(regime);
    this.lastMtfState = {
      direction, mtfScore, fundingBias, totalScore, details,
      fundingArbitrage, currentFundingRate,
      regime, hedgeRatio,
      updatedAt: Date.now(),
    };

    return { direction, mtfScore, fundingBias, totalScore, details, fundingArbitrage, currentFundingRate };
  }


  // ===== ボラティリティレジーム & ダイナミックヘッジ比率 ===== //

  /**
   * ボラティリティレジームを判定する
   *
   * 学術研究・DeFiプロトコル（Panoptic, Uniswap v3 実装事例）より:
   *   低ボラ時にヘッジするとFunding Rateコストで赤字になる事例多数。
   *   高ボラ時にヘッジしないとIL（Impermanent Loss）が膨らむ。
   *
   * ATR/price（ボラティリティ率）を基準に判定:
   *   < 1.5%  → LOW_VOL  : LP手数料収集モード（ヘッジ最小化）
   *   >= 1.5% → HIGH_VOL : デルタニュートラル防御モード（ヘッジ強化）
   */
  private getVolatilityRegime(): 'LOW_VOL' | 'NORMAL_VOL' | 'HIGH_VOL' {
    const atr = this.priceMonitor.calculateATR24h();
    const prices = this.priceHistoryForAnalysis;
    const currentPrice = prices.length > 0 ? prices[prices.length - 1] : 0;

    if (currentPrice <= 0) return 'HIGH_VOL';

    const atrRatio = atr / currentPrice;
    
    let regime: 'LOW_VOL' | 'NORMAL_VOL' | 'HIGH_VOL';
    if (atrRatio < 0.010) {
      regime = 'LOW_VOL';
    } else if (atrRatio < 0.030) {
      regime = 'NORMAL_VOL';
    } else {
      regime = 'HIGH_VOL';
    }

    Logger.info(`[REGIME] ATR=$${atr.toFixed(4)} (${(atrRatio * 100).toFixed(2)}%) → ${regime}`);
    return regime;
  }

  /**
   * ボラティリティに応じた最適ヘッジ比率を計算する
   *
   * バックテスト研究の知見:
   *   「50〜70%のパーシャルヘッジが最高シャープレシオ」
   *   100%ヘッジはFunding Rateコストが手数料収入を侵食する
   *
   *   低ボラ  (< 2%/day) : 50% — コスト最小化、手数料収入重視
   *   中ボラ  (2〜5%/day): 65% — リスクとコスト的のバランス
   *   高ボラ  (> 5%/day) : 80% — ILリスク最大化対応、防御優先
   *
   * @returns 最適ヘッジ比率（0.5〜0.8）
   */
  private calculateOptimalHedgeRatio(regime: 'LOW_VOL' | 'NORMAL_VOL' | 'HIGH_VOL'): number {
    const vol = this.calculateVolatility(); // 標準偏差/平均（小数）
    // 年率換算: vol_daily ≈ vol_per_interval × sqrt(intervals_per_day)
    // モニタリング間隔3秒 → 1日28800回 → √28800 ≈ 169.7
    const dailyVol = vol * Math.sqrt(28800) * 100; // パーセント表示

    let optimalRatio: number;
    if (dailyVol < 2.0) {
      optimalRatio = 0.50; // 低ボラ: コスト最小
    } else if (dailyVol < 5.0) {
      optimalRatio = 0.65; // 中ボラ: バランス
    } else {
      optimalRatio = 0.80; // 高ボラ: 防御最大化
    }

    // LOW_VOLレジームでは全体的に10%下げてコスト削減
    if (regime === 'LOW_VOL') {
      optimalRatio = Math.max(0.40, optimalRatio - 0.10);
    }

    Logger.info(`[HEDGE_RATIO] DailyVol≈${dailyVol.toFixed(2)}%, Regime=${regime} → 最適ヘッジ比率: ${(optimalRatio * 100).toFixed(0)}%`);
    return optimalRatio;
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

    if (process.env.HEDGE_TEST_MODE === 'true' || process.env.SKIP_PROFITABILITY_CHECK === 'true') {
      Logger.info(`🧪 [TEST_MODE] 採算性チェックをバイパスします`);
      return true;
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
    
    // セーフティガード: 最小レンジ幅 (±0.2% = 合計0.4%)
    const MIN_RANGE_WIDTH_PCT = 0.002;
    
    // 超低ボラティリティ時はさらに絞り込む (超・極狭レンジロジック)
    // 従来の1.2倍から、状況に応じて0.8倍〜1.0倍に調整し、手数料収益を最大化する
    let multiplier = 1.2;
    if (atrRatio < 0.005) {
      multiplier = 0.8;
      Logger.info(`🔥 超低ボラティリティ検知: 「超・極狭レンジ」モード発動 (Multiplier: ${multiplier})`);
    } else if (atrRatio < 0.010) {
      multiplier = 1.0;
      Logger.info(`⚡ 低ボラティリティ検知: 精密レンジモード (Multiplier: ${multiplier})`);
    }
    
    let halfWidth = Math.max(atrRatio * multiplier, MIN_RANGE_WIDTH_PCT);

    const rawLower = currentPrice * (1 - halfWidth);
    const rawUpper = currentPrice * (1 + halfWidth);

    // Cetus tick_spacingに丸める
    let lower = this.roundToTickSpacing(rawLower, this.TICK_SPACING);
    let upper = this.roundToTickSpacing(rawUpper, this.TICK_SPACING);

    // 丸め処理の結果、同じ値になってしまった場合は最小1ティック分の差を強制する
    if (lower === upper) {
      Logger.warn(`⚠️ レンジが収束したため最小Tick幅を適用します (Price: ${currentPrice})`);
      lower = this.roundToTickSpacing(rawLower * (1 - 0.0005), this.TICK_SPACING);
      upper = this.roundToTickSpacing(rawUpper * (1 + 0.0005), this.TICK_SPACING);
    }

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
      if (netBenefitIfShort > 0 || process.env.SKIP_FUNDING_RATE_CHECK === 'true') {
        Logger.info(`✅ SHORT決定: netBenefit=${(netBenefitIfShort*100).toFixed(4)}%/h${process.env.SKIP_FUNDING_RATE_CHECK === 'true' ? ' (TEST_MODEスキップ)' : ''}`);
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

    // 3. drawdownチェック
    const totalValue = this.config.totalOperationalCapitalUsdc + this.pnlEngine.calculateNetPnl(currentPrice).netPnl;
    if (this.peakPortfolioValue === 0) this.peakPortfolioValue = totalValue;
    if (totalValue > this.peakPortfolioValue) this.peakPortfolioValue = totalValue;
    
    const drawdown = this.peakPortfolioValue > 0
      ? (this.peakPortfolioValue - totalValue) / this.peakPortfolioValue
      : 0;
    
    const DD_LIMIT = process.env.HEDGE_TEST_MODE === 'true' ? 0.30 : 0.05;
    if (drawdown > DD_LIMIT) {
      Logger.error(`🚨 SAFETY: Drawdown ${(drawdown*100).toFixed(2)}% > ${(DD_LIMIT*100).toFixed(0)}% → EMERGENCY`);
      this.notify(`🚨 ドローダウン超過: ${(drawdown*100).toFixed(2)}% → 緊急撤退`);
      return 'EMERGENCY';
    }

    return 'OK';
  }

  /**
   * Deltaドリフト補正（レジーム適応型）
   *
   * 市場研究の知見（バックテスト）:
   *   「閾値ベースのリバランスは定期リバランスより優位」
   *   「高Funding時はリバランスを抑制してポジション維持優先」
   *
   * 動的閾値:
   *   HIGH_VOL レジーム            : ±10%（頻繁補正でIL最小化）
   *   LOW_VOL + 通常Funding        : ±15%（中程度）
   *   LOW_VOL + 高Funding(ARB)     : ±20%（ガス節約、ポジション維持優先）
   */
  private async checkAndAdjustDelta(currentPrice: number): Promise<void> {
    if (this.currentLowerBound <= 0 || this.currentLpValueUsdc <= 0) return;

    // 精密計算用: LP内の実SUI量を取得
    const lpSuiAmount = await this.lpManager.getSuiAmountInLp();

    const { delta, hedgeUsd: newHedgeUsd } = this.hedgeManager.calcHedgeDelta(
      currentPrice, this.currentLowerBound, this.currentUpperBound, this.currentLpValueUsdc, lpSuiAmount
    );

    const currentHedgeUsd = this.currentHedgeUsd || this.hedgeManager.getStatus(currentPrice).size;
    const drift = Math.abs(newHedgeUsd - currentHedgeUsd);
    const driftPct = currentHedgeUsd > 0 ? drift / currentHedgeUsd : 0;

    // 1時間サマリー用deltaエラー記録
    this.hourlyStats.deltaErrors.push(Math.abs(delta - 0.5));

    // --- レジーム適応型ドリフト閾値 ---
    const regime = this.getVolatilityRegime();
    let driftThreshold = 0.10; // デフォルト: HIGH_VOL
    let thresholdReason = 'HIGH_VOL(10%)';

    if (regime === 'LOW_VOL') {
      try {
        const fundingRate = await this.hedgeManager.getFundingRate();
        if (fundingRate > 0.0010) {
          // 高Funding アービトラージ中: リバランスを抑制してガス節約
          driftThreshold = 0.20;
          thresholdReason = `LOW_VOL+ARB(20%, funding=${(fundingRate*100).toFixed(4)}%/h)`;
        } else {
          driftThreshold = 0.15;
          thresholdReason = 'LOW_VOL(15%)';
        }
      } catch {
        driftThreshold = 0.15;
        thresholdReason = 'LOW_VOL(15%, funding取得失敗)';
      }
    }

    if (driftPct > driftThreshold) {
      Logger.warn(`⚡ DeltaDrift: ${(driftPct*100).toFixed(1)}% > ${(driftThreshold*100).toFixed(0)}% [${thresholdReason}] → 調整 ($${currentHedgeUsd.toFixed(2)} → $${newHedgeUsd.toFixed(2)})`);
      this.notify(`⚡ Deltaドリフト補正: $${currentHedgeUsd.toFixed(2)} → $${newHedgeUsd.toFixed(2)}`);
      
      const direction = this.hedgeDirection !== 'NONE' ? this.hedgeDirection : 'SHORT';
      const hedgeStatus = this.hedgeManager.getStatus(currentPrice);
      if (this.config.hedgeEnabled && hedgeStatus.active) {
        await this.hedgeManager.adjustPosition(newHedgeUsd, currentPrice, this.sessionId);
        this.currentHedgeUsd = newHedgeUsd;
        this.hourlyStats.hedgeAdjustCount++;
      } else if (!this.config.hedgeEnabled) {
        Logger.info('ℹ️ [CONFIG] ヘッジが無効化されているため、ドリフト補正をスキップします。');
      }

        const fundingRate = await this.hedgeManager.getFundingRate();
        const logEntry = {
          ts: new Date().toISOString(),
          action: 'HEDGE_ADJUST',
          trigger: 'Δドリフト',
          regime,
          drift_threshold: driftThreshold,
          delta_before: Number((currentHedgeUsd / (this.currentLpValueUsdc || 1)).toFixed(4)),
          delta_after: Number(delta.toFixed(4)),
          hedge_direction: direction,
          hedge_usd: Number(newHedgeUsd.toFixed(2)),
          funding_rate_hourly: Number((fundingRate * 100).toFixed(4)),
        };
        Logger.info(`[ACTION_LOG] ${JSON.stringify(logEntry)}`);
        await this.tracker.recordEvent('DeltaAdjust', JSON.stringify(logEntry), currentPrice);
    } else {
      Logger.info(`✅ DeltaDrift: ${(driftPct*100).toFixed(1)}% < ${(driftThreshold*100).toFixed(0)}% [${thresholdReason}] → OK`);
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

  async runRebalance(currentPrice: number, forceReset: boolean = false) {
    if (this.isProcessingRebalance) {
      Logger.warn('⚠️ リバランス処理が既に実行中です。新規リクエストをスキップします。');
      return;
    }

    try {
      this.isProcessingRebalance = true;

      // セッション上はポジションがあることになっている場合、実際にオンチェーンに存在するか確認
      if (this.currentLowerBound > 0) {
        const hasPos = await this.lpManager.hasExistingPosition();
        if (!hasPos) {
          Logger.warn(`⚠️ ポジションの消失を確認しました。セッション状態をリセットして即座に再構築します。`);
          this.currentLowerBound = 0;
          this.currentUpperBound = 0;
          this.lastRebalanceTime = 0; // クールダウンもリセット
        }
      }

      const timeSinceLastRebalance = Date.now() - this.lastRebalanceTime;
      
      // クールダウン判定（起動直後や新規構築時は無視する）
      if (this.currentLowerBound > 0 && timeSinceLastRebalance < this.config.cooldownPeriodMs && this.lastRebalanceTime !== 0) {
        const remaining = Math.floor((this.config.cooldownPeriodMs - timeSinceLastRebalance) / 1000);
        Logger.warn(`⏳ クールダウン中: あと${remaining}秒`);
        return;
      }

      this.currentPhase = CyclePhase.REBALANCING;
      
      if (this.config.strategyMode === 'range_order') {
        await this.executeRangeOrderStrategy(currentPrice);
      } else if (this.config.strategyMode === 'bluefin_grid' || this.sessionId.includes('bot3')) {
        await this.executeGridStrategy(currentPrice, forceReset);
      } else {
        await this.executeBalancedStrategy(currentPrice, forceReset);
      }

    } catch (e: any) {
      this.currentPhase = CyclePhase.IDLE;
      const errorMsg = e.message || 'Unknown error';
      Logger.error(`戦略実行中に重大なエラーが発生しました: ${errorMsg}`);
      
      if (this.currentLowerBound === 0) {
        this.currentLowerBound = 0;
        this.currentUpperBound = 0;
      }

      await this.tracker.recordEvent('エラー', `リバランス失敗: ${errorMsg}`, currentPrice);
      this.notify(`❌ 戦略エラー: ${errorMsg}`);
    } finally {
      this.isProcessingRebalance = false;
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
  private async executeBalancedStrategy(currentPrice: number, forceReset: boolean = false) {
    if (forceReset) {
      Logger.info('🔄 [FORCE RESET] 設定変更のため、現在のポジションを全決済して再構築します...');
      this.notify('🔄 設定が更新されたため、ボットを再起動（リセット）します...');
      
      // STEP 1: 全決済
      this.currentPhase = CyclePhase.CLOSING_HEDGE;
      await this.hedgeManager.closeHedge(currentPrice);
      
      this.currentPhase = CyclePhase.REMOVING_LP;
      await this.lpManager.forceCloseAllPositions();
      
      // 状態リセット
      this.currentLowerBound = 0;
      this.currentUpperBound = 0;
      this.lastExitDirection = null;
      this.hedgeDirection = 'NONE';
      
      // STEP 2: 新規エントリー
      await this.executeInitialEntry(currentPrice);
      return;
    }

    // レンジ逸脱または接近（オートフォロー）を判定
    if (this.currentLowerBound > 0 && this.currentUpperBound > 0) {
      const rangeWidth = this.currentUpperBound - this.currentLowerBound;
      const proximityThreshold = rangeWidth * 0.15; // 15% 接近でオートフォロー

      if (currentPrice > this.currentUpperBound) {
        this.lastExitDirection = 'upper';
        Logger.info(`📈 上方向レンジ逸脱を検知 (${currentPrice.toFixed(4)} > ${this.currentUpperBound.toFixed(4)})`);
      } else if (currentPrice < this.currentLowerBound) {
        this.lastExitDirection = 'lower';
        Logger.info(`📉 下方向レンジ逸脱を検知 (${currentPrice.toFixed(4)} < ${this.currentLowerBound.toFixed(4)})`);
      } else if (currentPrice > this.currentUpperBound - proximityThreshold) {
        this.lastExitDirection = 'upper';
        Logger.info(`⚡ [AUTO-FOLLOW] 上限接近検知 (${currentPrice.toFixed(4)} > ${this.currentUpperBound.toFixed(4)} - 15%) → 先行リバランスを実行`);
        this.notify(`⚡ オートフォロー: 上限に接近したため先行リバランスを実行します ($${currentPrice.toFixed(4)})`);
      } else if (currentPrice < this.currentLowerBound + proximityThreshold) {
        this.lastExitDirection = 'lower';
        Logger.info(`⚡ [AUTO-FOLLOW] 下限接近検知 (${currentPrice.toFixed(4)} < ${this.currentLowerBound.toFixed(4)} + 15%) → 先行リバランスを実行`);
        this.notify(`⚡ オートフォロー: 下限に接近したため先行リバランスを実行します ($${currentPrice.toFixed(4)})`);
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
        // オンチェーンに実際にポジションがあるか確認（セッション復元時の不整合対策）
        const hasPosition = await this.lpManager.hasActivePosition();
        if (!hasPosition) {
          Logger.warn(`⚠️ セッション上はポジションありですが、オンチェーンで確認できません。新規構築へ移行します。`);
          this.currentLowerBound = 0;
          this.currentUpperBound = 0;
          this.hedgeDirection = 'NONE';
        } else {
          Logger.box('Stable Monitoring', `Price $${currentPrice.toFixed(4)} is within range: $${this.currentLowerBound.toFixed(4)} - $${this.currentUpperBound.toFixed(4)}`);
          this.currentPhase = CyclePhase.MONITORING;
          this.finalizeRebalance(currentPrice, 0, 0, 0); // 状態同期のみ
          return;
        }
      }

      // ポジションがない場合は初回構築 (常にショートから開始)
      await this.executeInitialEntry(currentPrice);
    }
  }

  /**
   * 資金配分テーブル (仕様書 v3.1 準拠)
   */
  private getAllocationTable(totalUsd: number) {
    const isTestMode = process.env.HEDGE_TEST_MODE === 'true';
    
    // テストモード時 (PART 0)
    if (isTestMode) {
      return { bot1: 0.40, bot2: 0.40, hedge: 0.10, bot3: 0.05, gas: 0.05 };
    }

    // 通常モード時
    if (totalUsd < 50) {
      return { bot1: 0.45, bot2: 0.45, hedge: 0.00, bot3: 0.00, gas: 0.10 };
    } else if (totalUsd < 200) {
      return { bot1: 0.40, bot2: 0.40, hedge: 0.00, bot3: 0.16, gas: 0.04 };
    } else if (totalUsd < 1000) {
      return { bot1: 0.375, bot2: 0.375, hedge: 0.10, bot3: 0.10, gas: 0.05 };
    } else if (totalUsd < 10000) {
      return { bot1: 0.35, bot2: 0.35, hedge: 0.15, bot3: 0.13, gas: 0.02 };
    } else {
      return { bot1: 0.35, bot2: 0.30, hedge: 0.15, bot3: 0.17, gas: 0.03 };
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
    isHedgeEnabled: boolean;
  }> {
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.hedgeManager.syncPositionWithBluefin().catch(() => {});

    const { suiBalance, usdcBalance } = await this.lpManager.checkBalance();
    const GAS_RESERVE_SUI = 1.0;
    const usableSui = Math.max(0, suiBalance - GAS_RESERVE_SUI);
    
    // PythからSUIの米ドル価格を取得（換算用）
    const suiUsdPrice = await this.priceMonitor.getPythPrice();
    
    let totalEquityUsd = 0;
    const bluefinMarginTotal = this.hedgeManager.lastMarginBalance;
    // マルチボット共有アカウント対応: 自身の運用額に応じた割合の証拠金のみを評価対象にする
    const marginShareRatio = this.config.lpAmountUsdc / (this.config.totalOperationalCapitalUsdc || (this.config.lpAmountUsdc * 2));
    const bluefinMargin = bluefinMarginTotal * marginShareRatio;

    const coinTypeA = await this.priceMonitor.getCoinTypeA();
    const isCoinAUsdc = coinTypeA.toLowerCase().includes('usdc') || coinTypeA.toLowerCase().includes('coin_a');

    let coinAValueUsd = 0;
    const suiValueUsd = usableSui * suiUsdPrice;

    if (isCoinAUsdc) {
      // SUI/USDC プールの場合: totalEquity = USDC + (SUI * SUI/USDC) + Margin
      coinAValueUsd = usdcBalance;
      totalEquityUsd = coinAValueUsd + (usableSui * currentPrice) + bluefinMargin;
    } else {
      // DEEP/SUI 等の非USDペアの場合:
      // 簡易的に: CoinAのUSD価値 = (CoinA残高 * (1 / currentPrice) * SUI_USD)
      coinAValueUsd = usdcBalance * (1 / currentPrice) * suiUsdPrice;
      totalEquityUsd = coinAValueUsd + suiValueUsd + bluefinMargin;
    }

    // --- v3.1 資金配分テーブルに基づくターゲット計算 ---
    const allocation = this.getAllocationTable(totalEquityUsd);
    const botName = process.env.BOT_NAME || 'bot1';
    
    let myAllocationPct = 0;
    if (botName.includes('bot1')) myAllocationPct = allocation.bot1;
    else if (botName.includes('bot2')) myAllocationPct = allocation.bot2;
    else if (botName.includes('bot3')) myAllocationPct = allocation.bot3;

    const totalCapital = totalEquityUsd * 0.99;
    
    // 自身のボットのLPターゲット
    const targetLpUsdValue = totalEquityUsd * myAllocationPct;
    
    // ヘッジはBot1またはBot2のいずれかが代表して管理するか、全体で合算して管理する。
    // ここではBot1がヘッジも兼務する仕様とする。
    const isHedgeEnabled = (this.config.hedgeEnabled !== false) && (botName.includes('bot1') || process.env.HEDGE_TEST_MODE === 'true');
    const targetHedgeNotional = isHedgeEnabled ? (totalEquityUsd * allocation.hedge) : 0;

    // ヘッジ無効時にBluefinにポジションまたは資金が残っている場合はクリーンアップ
    if (!isHedgeEnabled) {
      const hedgeStatus = this.hedgeManager.getStatus(currentPrice);
      if (hedgeStatus.active) {
        Logger.info(`🛡️ ヘッジ無効設定: 既存のヘッジポジション ($${hedgeStatus.size}) を決済します...`);
        await this.hedgeManager.closeHedge(currentPrice).catch(e => {
          Logger.error(`Failed to close hedge during cleanup: ${e.message}`);
        });
        await new Promise(resolve => setTimeout(resolve, 3000)); // 同期待機
      }
      
      if (bluefinMargin > 1.0) {
        Logger.info(`💰 ヘッジ無効設定: Bluefinから証拠金 ($${bluefinMargin.toFixed(2)}) を回収してLPに回します...`);
        await this.hedgeManager.withdrawAllMargin().catch(() => {});
      }
    }
    
    // CoinA(DEEP等)のターゲット残高 (LP構成比を50:50に)
    const targetCoinAUsdValue = targetLpUsdValue * 0.50;
    const targetSuiValue = targetCoinAUsdValue; // SUI側の価値
    
    this.currentPhase = CyclePhase.SWAPPING;

    const currentSuiValue = usableSui * suiUsdPrice;
    const currentCoinAValue = coinAValueUsd;

    if (currentSuiValue > targetSuiValue + 0.1) {
      // SUIが多すぎる → SUI売却
      const suiToSell = Math.max(0, (currentSuiValue - targetSuiValue) / suiUsdPrice);
      if (suiToSell > 0.1) {
        Logger.info(`🔄 資産バランス調整: ${suiToSell.toFixed(4)} SUIを売却 (約 $${(currentSuiValue - targetSuiValue).toFixed(2)})`);
        const sellRes = await this.lpManager.swapSuiToUsdc(suiToSell);
        this.pnlEngine.recordGas(sellRes.gasCostUsdc); 
        await this.tracker.recordEvent('資産調整', `${suiToSell.toFixed(2)} SUIを売却して${isCoinAUsdc ? 'USDC' : 'CoinA'}に変換`, currentPrice, sellRes.digest);
      }
    } else if (currentSuiValue < targetSuiValue - 0.1) {
      // SUIが少なすぎる → CoinAを売ってSUI購入
      const usdcToSpendUsd = targetSuiValue - currentSuiValue;
      // CoinAでの支払額 = usdcToSpendUsd / (CoinA_USD_Price)
      // CoinA_USD_Price = (1 / currentPrice) * suiUsdPrice
      const coinAPriceUsd = (1 / currentPrice) * suiUsdPrice;
      const amountToSpend = usdcToSpendUsd / coinAPriceUsd;

      if (amountToSpend > 0.1) {
        Logger.info(`🔄 資産バランス調整: ${amountToSpend.toFixed(2)} ${isCoinAUsdc ? 'USDC' : 'CoinA'}でSUIを購入`);
        const buyRes = await this.lpManager.swapUsdcToSui(amountToSpend);
        this.pnlEngine.recordGas(buyRes.gasCostUsdc); 
        await this.tracker.recordEvent('資産調整', `${amountToSpend.toFixed(2)} ${isCoinAUsdc ? 'USDC' : 'CoinA'}でSUIを購入`, currentPrice, buyRes.digest);
      }
    }

    // スワップ後の実際の残高を再取得
    await new Promise(resolve => setTimeout(resolve, 2000)); 
    const postSwapBalance = await this.lpManager.checkBalance();
    const finalUsableSui = Math.max(0, postSwapBalance.suiBalance - GAS_RESERVE_SUI);
    const finalSuiValueUsd = finalUsableSui * suiUsdPrice;
    
    // CoinAのUSD価値
    const finalCoinAValueUsd = postSwapBalance.usdcBalance * (isCoinAUsdc ? 1 : (1 / currentPrice) * suiUsdPrice);

    // 実際に投入可能なLP価値 (USD)
    const lpValue = Math.min(finalSuiValueUsd, finalCoinAValueUsd) * 2 * 0.97;

    // ヘッジ必要額 = LP価値の半分 (SUI相当分) * hedgeRatio
    const hedgeNotional = isHedgeEnabled ? (lpValue * 0.5 * this.config.hedgeRatio) : 0;
    
    // 必要証拠金の算出（ヘッジ額の約40% = レバレッジ2.5倍相当で安定運用）
    const requiredMargin = hedgeNotional * 0.40;
    const currentMargin = this.hedgeManager.lastMarginBalance;

    if (isHedgeEnabled) {
      if (currentMargin < requiredMargin * 0.9) {
        // 不足している場合のみ入金
        Logger.info(`🛡️ 証拠金不足: 現在 $${currentMargin.toFixed(2)} < 必要 $${requiredMargin.toFixed(2)} → 補充します`);
        await this.hedgeManager.depositMargin(requiredMargin, this.lpManager);
      } else if (currentMargin > requiredMargin * 1.5 && currentMargin > 2.0) {
        // 過剰な場合は回収してLPに回す (2.0ドル以上の余裕がある場合)
        const excess = currentMargin - requiredMargin;
        Logger.info(`💰 証拠金過剰: 現在 $${currentMargin.toFixed(2)} > 必要 $${requiredMargin.toFixed(2)} → $${excess.toFixed(2)} を回収してLPに回します`);
        await this.hedgeManager.withdrawMargin(excess);
      }
    }

    return { totalCapital, lpValue, hedgeNotional, isHedgeEnabled };
  }

  /**
   * [初回構築] ショートヘッジで開始
   * 資本の50%をSUIに → USDC+SUIでLP → Bluefinでショート
   */
  private async executeInitialEntry(currentPrice: number) {
    this.notify(`🚀 デルタニュートラル戦略: 初期構築開始 価格: $${currentPrice.toFixed(4)}`);
    Logger.box('Delta-Neutral Flip: Initial Entry', `Price: $${currentPrice.toFixed(4)}`);

    // STEP 0: 取引所との同期を先に行う
    await this.hedgeManager.syncPositionWithBluefin().catch(e => {
      Logger.warn(`Bluefin: 初期同期エラー: ${e.message}`);
    });

    // STEP 1: 既存ポジションのクリーンアップ
    await this.closeAllPositions(currentPrice);

    // STEP 2: 資産評価とリバランス調整
    const { totalCapital, lpValue, hedgeNotional, isHedgeEnabled } = await this.evaluateAndBalance(currentPrice);

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

    if (isHedgeEnabled) {
      // STEP 4: レジーム判定 + MTF シグナルでヘッジ比率・方向を決定
      const regime = this.getVolatilityRegime();
      const optimalRatio = this.calculateOptimalHedgeRatio(regime);
      // 動的ヘッジ比率をconfigに一時適用（evaluateAndBalanceの計算後なので再計算）
      const adjustedHedgeNotional = hedgeNotional * (optimalRatio / this.config.hedgeRatio);

      const mtfSignal = await this.getMtfHedgeSignal();

      // アービトラージモード通知
      if (mtfSignal.fundingArbitrage) {
        this.notify(`🔥 Funding Rate ARBモード発動! ${(mtfSignal.currentFundingRate * 100).toFixed(4)}%/h → LP手数料+Funding受取のダブル収益を狙います`);
      }

      // データ不足（30分未満稼働）の場合はSHORTをデフォルトとして使用
      const hedgeDir = mtfSignal.direction === 'NEUTRAL'
        ? 'SHORT' // 初回はSHORTで安全側を優先
        : mtfSignal.direction;

      if (mtfSignal.direction === 'NEUTRAL') {
        Logger.warn(`[MTF] 初回エントリー: シグナル中立 → デフォルトSHORTで開始 (score: ${mtfSignal.totalScore}, regime: ${regime}, ratio: ${(optimalRatio*100).toFixed(0)}%)`);
        this.notify(`📊 MTF: 初回はデフォルトSHORT (スコア: ${mtfSignal.totalScore}, ヘッジ比率: ${(optimalRatio*100).toFixed(0)}%)`);
      } else {
        Logger.info(`[MTF] 初回エントリー: ${hedgeDir}を採用 (score: ${mtfSignal.totalScore}, regime: ${regime}, ratio: ${(optimalRatio*100).toFixed(0)}%)`);
        this.notify(`📊 MTF確認 → ${hedgeDir} (スコア: ${mtfSignal.totalScore}, ヘッジ比率: ${(optimalRatio*100).toFixed(0)}%)`);
      }

      await this.buildHedgePosition(currentPrice, adjustedHedgeNotional, hedgeDir);
      this.finalizeRebalance(currentPrice, lpValue, adjustedHedgeNotional, totalCapital, this.hedgeDirection as any);
    } else {
      Logger.info('🛡️ ヘッジ無効モード: LP構築のみで運用を開始します');
      this.finalizeRebalance(currentPrice, lpValue, 0, totalCapital, 'NONE' as any);
    }
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

    // STEP 2: 資産をリバランス
    const { totalCapital, lpValue, hedgeNotional, isHedgeEnabled } = await this.evaluateAndBalance(currentPrice);

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

    // STEP 4: ヘッジ構築
    if (isHedgeEnabled) {
      const mtfSignalLong = await this.getMtfHedgeSignal();
      if (mtfSignalLong.direction === 'LONG' || mtfSignalLong.direction === 'NEUTRAL') {
        Logger.info(`[MTF] LONG反転: スコア=${mtfSignalLong.totalScore} → LONGヘッジを開設`);
        this.notify(`📈 MTF確認済みLONG反転 (スコア: ${mtfSignalLong.totalScore})`);
        await this.buildHedgePosition(currentPrice, hedgeNotional, 'LONG');
        this.finalizeRebalance(currentPrice, lpValue, hedgeNotional, totalCapital, this.hedgeDirection as any);
      } else {
        Logger.warn(`[MTF] LONG反転キャンセル: MTFスコア=${mtfSignalLong.totalScore} がSHORTを示唆 → ヘッジなしでLP維持`);
        this.notify(`⚠️ MTF: 上抜けだがSHORTシグナル → ヘッジ見送り (スコア: ${mtfSignalLong.totalScore})\n${mtfSignalLong.details}`);
        this.hedgeDirection = 'NONE';
        this.finalizeRebalance(currentPrice, lpValue, 0, totalCapital, 'NONE' as any);
      }
    } else {
      this.finalizeRebalance(currentPrice, lpValue, 0, totalCapital, 'NONE' as any);
    }
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

    // STEP 2: 資産をリバランス
    const { totalCapital, lpValue, hedgeNotional, isHedgeEnabled } = await this.evaluateAndBalance(currentPrice);

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

    // STEP 4: ヘッジ構築
    if (isHedgeEnabled) {
      const mtfSignalShort = await this.getMtfHedgeSignal();
      if (mtfSignalShort.direction === 'SHORT' || mtfSignalShort.direction === 'NEUTRAL') {
        Logger.info(`[MTF] SHORT反転: スコア=${mtfSignalShort.totalScore} → SHORTヘッジを開設`);
        this.notify(`📉 MTF確認済みSHORT反転 (スコア: ${mtfSignalShort.totalScore})`);
        await this.buildHedgePosition(currentPrice, hedgeNotional, 'SHORT');
        this.finalizeRebalance(currentPrice, lpValue, hedgeNotional, totalCapital, this.hedgeDirection as any);
      } else {
        Logger.warn(`[MTF] SHORT反転キャンセル: MTFスコア=${mtfSignalShort.totalScore} がLONGを示唆 → ヘッジなしでLP維持`);
        this.notify(`⚠️ MTF: 下抜けだがLONGシグナル → ヘッジ見送り (スコア: ${mtfSignalShort.totalScore})\n${mtfSignalShort.details}`);
        this.hedgeDirection = 'NONE';
        this.finalizeRebalance(currentPrice, lpValue, 0, totalCapital, 'NONE' as any);
      }
    } else {
      this.finalizeRebalance(currentPrice, lpValue, 0, totalCapital, 'NONE' as any);
    }
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
    usdcAmountUsd: number
  ): Promise<void> {
    const coinTypeA = await this.priceMonitor.getCoinTypeA();
    const isCoinAUsdc = coinTypeA.toLowerCase().includes('usdc') || coinTypeA.toLowerCase().includes('coin_a');
    let amountInCoinA = usdcAmountUsd;

    if (!isCoinAUsdc) {
      // CoinA(DEEP等)の量に変換
      const suiUsdPrice = await this.priceMonitor.getPythPrice();
      const coinAPriceUsd = (1 / currentPrice) * suiUsdPrice;
      amountInCoinA = usdcAmountUsd / coinAPriceUsd;
    }

    Logger.info(`🎯 LP構築: ${lowerBound.toFixed(4)} 〜 ${upperBound.toFixed(4)} (${isCoinAUsdc ? '$' : ''}${amountInCoinA.toFixed(isCoinAUsdc ? 2 : 4)} ${isCoinAUsdc ? 'USDC' : 'CoinA'})`);
    this.currentPhase = CyclePhase.ADDING_LP;

    const lpRes = await this.lpManager.addLiquidity(lowerBound, upperBound, amountInCoinA, true);
    this.pnlEngine.recordGas(lpRes.gasCostUsdc); // ガス代を記録

    // 成功時のみ状態更新
    this.currentLowerBound = lowerBound;
    this.currentUpperBound = upperBound;

    await this.tracker.recordRebalance(
      currentPrice, 0, 0, lpRes.digest, // 手数料ではなく0を記録
      `LP構築完了 [${lowerBound.toFixed(4)}, ${upperBound.toFixed(4)}]`,
      this.currentLowerBound, this.currentUpperBound, 'DELTA_NEUTRAL_FLIP'
    );
  }

  /**
   * ヘッジポジション構築の共通処理
   */
  private async buildHedgePosition(
    currentPrice: number,
    hedgeNotionalUsd: number,
    direction: 'SHORT' | 'LONG'
  ): Promise<boolean> {
    if (!this.config.hedgeEnabled) {
      Logger.info('ℹ️ [CONFIG] ヘッジが無効化されています。スキップします。');
      this.hedgeDirection = 'NONE';
      return false;
    }
    const dirLabel = direction === 'SHORT' ? 'ショート' : 'ロング';
    Logger.info(`⏳ Indexer同期待機 (5秒)...`);
    await new Promise(resolve => setTimeout(resolve, 5000));

    this.currentPhase = CyclePhase.OPENING_HEDGE;

    if (hedgeNotionalUsd > 0.1 && !isNaN(hedgeNotionalUsd)) {
      Logger.info(`🎯 Bluefin: ${dirLabel}ヘッジ構築 ($${hedgeNotionalUsd.toFixed(2)})`);

      // 証拠金が足りない場合は追加入金
      const marginNeeded = hedgeNotionalUsd * 0.55; // 3倍レバレッジでの必要証拠金
      await this.hedgeManager.depositMargin(marginNeeded, this.lpManager);

      const hedgeRes = await this.hedgeManager.openHedge(hedgeNotionalUsd, currentPrice, direction, this.sessionId);
      this.pnlEngine.recordGas(hedgeRes.gasCostUsdc); // ガス代を記録

      const suiUsdPrice = await this.priceMonitor.getPythPrice();
      let actualSize = Math.round(hedgeNotionalUsd / suiUsdPrice);
      if (actualSize < 1) actualSize = 1;
      
      await this.tracker.recordHedge(
        direction, `${dirLabel}ヘッジ構築`,
        currentPrice, actualSize, hedgeRes.digest
      );
      this.hedgeDirection = direction;
      return true;
    } else {
      Logger.warn(`Bluefin: ヘッジ額が少なすぎるためスキップ ($${hedgeNotionalUsd.toFixed(2)})`);
      this.hedgeDirection = 'NONE';
      return false;
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
      Logger.warn(`⚠️ ポジション(ヘッジ)がまだ残っています (試行 ${retryCount}/${maxRetries})。再確認します...`);
    }

    Logger.error("⚠️ ポジションのクローズに時間がかかっています。無視して続行します。");
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
          // オンチェーンに実際にポジションがあるか確認
          const hasPos = await this.lpManager.hasExistingPosition();
          if (hasPos) {
            Logger.info('🔄 [PERSISTENCE] 既存のレンジ情報を検出しました。全決済をスキップし、直接監視に移行します。');
            
            const pnlState = this.pnlEngine.serialize();
            if (!pnlState.lpEntryPrice || pnlState.lpEntryPrice <= 0) {
              Logger.info('📊 [PNL FIX] lpEntryPriceが未設定 → 現在の価格で初期化します');
              const estimatedLpValue = this.config.totalOperationalCapitalUsdc * 0.5;
              const estimatedHedgeValue = estimatedLpValue * this.config.hedgeRatio;
              this.pnlEngine.recordLpEntry(firstPrice, estimatedLpValue);
              this.pnlEngine.recordHedgeEntry(
                firstPrice,
                estimatedHedgeValue,
                this.hedgeDirection !== 'NONE' ? this.hedgeDirection as 'SHORT' | 'LONG' : 'SHORT'
              );
            } else {
              Logger.info(`📊 [PNL OK] 前回のエントリー価格を維持: $${pnlState.lpEntryPrice.toFixed(4)}`);
            }
            
            this.currentPhase = CyclePhase.MONITORING;
            return;
          }
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

        // ===== レンジ逸脱検知 (ゆとりバッファ + 15分継続確認) =====
        const hasLpPos = await this.lpManager.hasExistingPosition();
        
        // バッファを含めた逸脱判定
        const buffer = this.HYSTERESIS_BUFFER_PCT;
        const isActuallyOutOfRange = this.currentLowerBound > 0 && (
          currentPrice < this.currentLowerBound * (1 - buffer) || 
          currentPrice > this.currentUpperBound * (1 + buffer)
        );

        // クールダウン中かチェック
        const isCooldown = (Date.now() - this.lastRebalanceTime) < this.MIN_REBALANCE_COOLDOWN_MS;
        
        if (this.currentLowerBound === 0 || !hasLpPos) {
          // LPがない → 初回構築
          this.lastBreachTime = null;
          await this.runRebalance(currentPrice);
        } else if (isActuallyOutOfRange) {
          if (isCooldown) {
            Logger.info(`⌛ クールダウン中につきリバランス保留 (前回から ${((Date.now() - this.lastRebalanceTime)/60000).toFixed(1)}分経過)`);
            return;
          }
          // 逸脱検知
          const now = Date.now();
          if (this.lastBreachTime === null) {
            this.lastBreachTime = now;
            Logger.warn(`⚠️ レンジ逸脱検知(バッファ込): $${currentPrice.toFixed(4)} (逸脱開始時刻記録)`);
          } else if ((now - this.lastBreachTime) > this.BREACH_CONFIRM_MS) {
            // 15分継続確認
            const twapWindow = this.BREACH_CONFIRM_MS;
            const twapVal = this.priceMonitor.fetchTWAP(twapWindow);
            const twapAlsoOutOfRange = twapVal < this.currentLowerBound || twapVal > this.currentUpperBound;

            if (twapAlsoOutOfRange) {
              Logger.error(`🚨 15分逸脱確認 + TWAP逸脱 → リバランス実行`);
              this.lastBreachTime = null;
              if (currentPrice > this.currentUpperBound) {
                this.lastExitDirection = 'upper';
              } else {
                this.lastExitDirection = 'lower';
              }
              await this.runRebalance(currentPrice);
            } else {
              Logger.info(`⏸️ TWAPがレンジ内 ($${twapVal.toFixed(4)}) → リバランス保留`);
            }
          } else {
            const elapsed = (now - this.lastBreachTime) / 1000;
            Logger.warn(`⏱️ 逸脱継続中: ${elapsed.toFixed(0)}/${this.BREACH_CONFIRM_MS/1000}秒 レンジ: [$${this.currentLowerBound.toFixed(4)}, $${this.currentUpperBound.toFixed(4)}]`);
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

    // ===== PnLエンジン自動復旧ガード =====
    // lpEntryPrice が 0 のままで、かつレンジまたはヘッジが存在する場合は強制初期化。
    // これによりセッション再起動後やセッションファイル未保存時でも損益計算が機能する。
    const pnlState = this.pnlEngine.serialize();
    if (!pnlState.lpEntryPrice || pnlState.lpEntryPrice <= 0) {
      const hedgeStatus = this.hedgeManager.getStatus(currentPrice);
      const hasPosition = this.currentLowerBound > 0 || hedgeStatus.active;
      
      if (hasPosition && currentPrice > 0) {
        // ヘッジのエントリー価格を優先、なければ現在価格で代用
        const recoveryEntryPrice = (hedgeStatus.active && hedgeStatus.entryPrice > 0)
          ? hedgeStatus.entryPrice
          : currentPrice;

        // LP価値: 総運用資本の50%と推定
        const estimatedLpValue = this.config.totalOperationalCapitalUsdc * 0.5;
        // ヘッジサイズ: 実際のサイズがあればそれを使用、なければ推定値
        const estimatedHedgeValue = (hedgeStatus.active && hedgeStatus.size > 0)
          ? hedgeStatus.size
          : estimatedLpValue * this.config.hedgeRatio;

        const hedgeDir = (this.hedgeDirection !== 'NONE' && this.hedgeDirection)
          ? this.hedgeDirection as 'SHORT' | 'LONG'
          : (hedgeStatus.direction === 'LONG' ? 'LONG' : 'SHORT');

        Logger.warn(`[PNL_RECOVERY] lpEntryPrice=0を検知。自動復旧: entry=$${recoveryEntryPrice.toFixed(4)}, LP=$${estimatedLpValue.toFixed(2)}, hedge=$${estimatedHedgeValue.toFixed(2)}, dir=${hedgeDir}`);
        this.pnlEngine.recordLpEntry(recoveryEntryPrice, estimatedLpValue);
        this.pnlEngine.recordHedgeEntry(recoveryEntryPrice, estimatedHedgeValue, hedgeDir);
      }
    }

    const balance = await this.lpManager.checkBalance();
    const trackerStats = this.tracker.getStats();
    
    const pnlResult = this.pnlEngine.calculateNetPnl(currentPrice);
    
    // AI推薦を生成
    const advisor = await this.generateRecommendation(currentPrice);

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
      mtf: this.lastMtfState,
      advisor, // AIアドバイザーの提案を追加
      ...trackerStats,
    };
  }

  /**
   * 市場環境に基づいたAI戦略推薦を生成
   */
  async generateRecommendation(currentPrice: number) {
    const regime = this.priceMonitor.getMarketRegime();
    if (!regime) return null;
    
    Logger.info(`[AI_ADVISOR] 市場環境分析中... Vol: ${regime.volatility}, Trend: ${regime.trend}`);

    const fundingRate = await this.hedgeManager.getFundingRate();
    const fundingAnnualized = fundingRate * 24 * 365 * 100;

    let strategy: 'DELTA_NEUTRAL' | 'LP_ONLY' | 'RANGE_ORDER' = 'DELTA_NEUTRAL';
    let reason = '';
    let action = 'STAY'; // STAY or CHANGE
    let targetConfig: any = {};

    // 戦略ロジック判定
    if (regime.volatility === 'LOW' && regime.trend === 'sideways') {
      strategy = 'LP_ONLY';
      reason = 'ボラティリティが低く、レンジ内推移が続いています。ヘッジコストを削り、LP手数料収入を最大化する「ヘッジなしモード」が最適です。';
      if (this.config.hedgeEnabled) {
        action = 'CHANGE';
        targetConfig = { hedgeEnabled: false };
      }
    } else if (regime.volatility === 'HIGH' || regime.volatility === 'EXTREME') {
      strategy = 'DELTA_NEUTRAL';
      reason = 'ボラティリティが高まっています。急激な価格変動から資産を守るため、デルタニュートラル（ヘッジあり）での運用を推奨します。';
      if (!this.config.hedgeEnabled) {
        action = 'CHANGE';
        targetConfig = { hedgeEnabled: true };
      }
    } else if (regime.trend !== 'sideways') {
      strategy = 'DELTA_NEUTRAL';
      reason = `${regime.trend === 'uptrend' ? '上昇' : '下落'}トレンドが形成されています。トレンドに合わせたヘッジを行うことで、リスクを抑制した運用を推奨します。`;
      if (!this.config.hedgeEnabled) {
        action = 'CHANGE';
        targetConfig = { hedgeEnabled: true };
      }
    } else {
      strategy = 'DELTA_NEUTRAL';
      reason = '現在の相場はニュートラルです。標準的なデルタニュートラル戦略を継続し、安定した収益を狙うのが適切です。';
    }

    // 金利ボーナス判定
    if (Math.abs(fundingAnnualized) > 15) {
      reason += `\n現在、Bluefinの金利（年率${fundingAnnualized.toFixed(2)}%）が魅力的な水準です。ヘッジによる金利収入も大きな収益源となります。`;
    }

    Logger.info(`[AI_ADVISOR] 分析完了: ${strategy} (${action})`);

    return {
      regime: { ...regime, fundingAnnualized },
      recommendation: {
        strategy,
        reason,
        action,
        targetConfig,
        confidence: regime.volatility === 'NORMAL' ? 85 : 70
      }
    };
  }

  /**
   * [Bot3] Bluefin 指値グリッド戦略
   */
  private async executeGridStrategy(currentPrice: number, forceReset: boolean = false) {
    if (!this.hedgeManager.bluefinClient) {
      Logger.error('Bot3: Bluefin client not initialized');
      return;
    }

    // ヘッジ無効設定時は全決済して停止
    if (!this.config.hedgeEnabled) {
      Logger.info('Bot3: [CONFIG] ヘッジが無効化されました。全ポジションと注文をクリーンアップします...');
      await this.closeAllPositions(currentPrice);
      this.currentPhase = CyclePhase.IDLE;
      return;
    }

    if (forceReset) {
      Logger.info('Bot3: [FORCE RESET] 設定変更のため、現在のポジションを全決済してグリッドを再構築します...');
      await this.closeAllPositions(currentPrice);
    }

    this.currentPhase = CyclePhase.GRID_ORDERING;
    Logger.box('Bot3: Bluefin Grid Strategy', `Price: $${currentPrice.toFixed(4)}`);

    try {
      const client = this.hedgeManager.bluefinClient;
      const market = process.env.HEDGE_MARKET || 'SUI-PERP';
      const buyLevels = 5;
      const sellLevels = 2;
      const gridSpacingPct = 0.004; // 0.4%
      const gridSizeUsdc = 0.15; // $0.15 per order

      // STEP 1: 全キャンセル
      Logger.info(`Bot3: Cancelling all open orders on ${market}...`);
      if ((client as any).cancelOrders) {
        await (client as any).cancelOrders(market);
      } else if ((client as any).cancelAllOpenOrders) {
        await (client as any).cancelAllOpenOrders(market);
      }

      // STEP 2: 安全確認（証拠金比率）
      const marginRatio = await this.hedgeManager.getMarginRatio();
      if (marginRatio < 10) { 
        Logger.warn(`Bot3: Margin ratio too low (${marginRatio.toFixed(1)}%). Standing by.`);
        return;
      }

      // STEP 3: グリッド配置 (LONGバイアス)
      
      // BUY Levels (5 levels to accumulate)
      for (let i = 1; i <= buyLevels; i++) {
        const buyPrice = currentPrice * (1 - gridSpacingPct * i);
        const qty = gridSizeUsdc / currentPrice;
        await client.createOrder({
          symbol: market as any,
          side: 'BUY' as any,
          type: 'LIMIT' as any,
          priceE9: new BigNumber(buyPrice).times(1e9).integerValue().toString(),
          quantityE9: new BigNumber(qty).times(1e9).integerValue().toString(),
          leverageE9: new BigNumber(2).times(1e9).toString(),
          isIsolated: true,
          expiresAtMillis: Date.now() + 3600000,
          clientOrderId: `grid_buy_${i}_${Date.now()}`
        }).catch(e => Logger.warn(`Grid Buy ${i} failed: ${e.message}`));
      }

      // SELL Levels (2 levels to take profit)
      for (let i = 1; i <= sellLevels; i++) {
        const sellPrice = currentPrice * (1 + gridSpacingPct * i);
        const qty = gridSizeUsdc / currentPrice;
        await client.createOrder({
          symbol: market as any,
          side: 'SELL' as any,
          type: 'LIMIT' as any,
          priceE9: new BigNumber(sellPrice).times(1e9).integerValue().toString(),
          quantityE9: new BigNumber(qty).times(1e9).integerValue().toString(),
          leverageE9: new BigNumber(2).times(1e9).toString(),
          isIsolated: true,
          expiresAtMillis: Date.now() + 3600000,
          clientOrderId: `grid_sell_${i}_${Date.now()}`
        }).catch(e => Logger.warn(`Grid Sell ${i} failed: ${e.message}`));
      }

      Logger.success(`Bot3: ✅ Long-biased grid orders placed (Buy: ${buyLevels}, Sell: ${sellLevels}) around $${currentPrice.toFixed(4)}`);
      this.currentPhase = CyclePhase.MONITORING;

    } catch (e: any) {
      Logger.error(`Bot3 Grid Error: ${e.message}`);
      this.currentPhase = CyclePhase.IDLE;
    }
  }

}
