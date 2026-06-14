import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { BotConfig, BOT1_CONFIG, BOT2_CONFIG } from './config.js';
import { Logger } from './modules/logger.js';
import { PriceMonitor } from './modules/priceMonitor.js';
import { LpManager } from './modules/lpManager.js';
import { SwapManager } from './modules/swapManager.js';
import { HedgeManager } from './modules/hedgeManager.js';
import { RiskGuard } from './modules/riskGuard.js';
import { StateManager, BotState } from './modules/stateManager.js';
import { RebalanceEngine } from './modules/rebalanceEngine.js';
import { GasTracker } from './gasTracker.js';
import { Tracker } from './tracker.js';

export enum CyclePhase {
  IDLE = '待機中',
  A = 'フェーズA: 初期セットアップ中',
  B = 'フェーズB: 運用中 (監視)',
  C = 'フェーズC: 下抜けリバランス中',
  D = 'フェーズD: 上抜けリバランス中',
  EMERGENCY = '緊急停止中',
}

interface BotInstance {
  name: string;
  priceMonitor: PriceMonitor;
  lpManager: LpManager;
  swapManager: SwapManager;
  stateManager: StateManager;
  state: BotState;
  currentPhase: CyclePhase;
}

function isTemporaryRpcError(error: unknown): boolean {
  const message = String((error as any)?.message || error);
  return message.includes('429') ||
    message.includes('Too Many Requests') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('fetch failed') ||
    /\b50[234]\b/.test(message);
}

export class Strategy {
  public isRunning: boolean = false;
  public currentPhase: CyclePhase = CyclePhase.IDLE;
  public isEmergencyStopped: boolean = false;
  private keypair?: Ed25519Keypair;
  
  public bot1!: BotInstance;
  public bot2!: BotInstance;
  private riskGuard: RiskGuard;
  private timer: NodeJS.Timeout | null = null;
  private isCycleRunning: boolean = false;
  private isPhaseARunning: boolean = false; // 統合フェーズAの二重起動防止フラグ
  private isRolling: { [key: string]: boolean } = {}; // 各ボットのスライドローリング重複起動防止フラグ
  private lastSurgeRebuildAt: number = 0;
  private rpcBackoffUntil: number = 0;
  private lastRpcErrorEventAt: number = 0;

  // PnL データのキャッシュ機構（429 Too Many Requestsの防止）
  private lastPnlData: any = null;
  private lastPnlDataTime: number = 0;
  private pnlDataInFlight: Promise<any> | null = null;
  private pnlDataInFlightWallet?: string;
  
  constructor(
    private priceMonitor: PriceMonitor, // Bot1 priceMonitor
    private lpManager: LpManager,       // Bot1 lpManager
    private hedgeManager: HedgeManager,
    private gasTracker: GasTracker,
    private tracker: Tracker,
    public config: BotConfig,
    private saveStateCallback: Function,
    private sessionId: string
  ) {
    // Bot1 インスタンスの構築
    const bot1SwapManager = new SwapManager(this.priceMonitor, this.gasTracker, this.config);
    const bot1StateManager = new StateManager(this.sessionId, 'Bot1');
    const bot1Saved = bot1StateManager.loadState();
    const bot1State: BotState = bot1Saved || {
      phase: 'A',
      lpPositionId: null,
      lpPositionIdBelow: null,
      lpPositionIdAbove: null,
      lpPositionIdBelow1: null,
      lpPositionIdBelow2: null,
      lpPositionIdAbove1: null,
      lpPositionIdAbove2: null,
      bluefinOrderId: null,
      bluefinSide: 'none',
      basePrice: 0,
      rangeLower: 0,
      rangeUpper: 0,
      rangeLowerBelow: 0,
      rangeUpperBelow: 0,
      rangeLowerAbove: 0,
      rangeUpperAbove: 0,
      rangeLowerBelow1: 0,
      rangeUpperBelow1: 0,
      rangeLowerBelow2: 0,
      rangeUpperBelow2: 0,
      rangeLowerAbove1: 0,
      rangeUpperAbove1: 0,
      rangeLowerAbove2: 0,
      rangeUpperAbove2: 0,
      rangeWidth: 0.10, // デフォルト±10%
      totalCapital: 0,
      rebalanceCount24h: 0,
      lastRebalanceAt: 0,
      rebalanceHistory: [],
      isRebuilding: false
    };
    if (bot1State.isRebuilding) {
      Logger.warn('[STATE_MANAGER][Bot1] 前回の再構築中フラグが残っていたため、起動時に解除します。');
    }
    bot1State.isRebuilding = false;

    this.bot1 = {
      name: 'Bot1 (SUI-USDC)',
      priceMonitor: this.priceMonitor,
      lpManager: this.lpManager,
      swapManager: bot1SwapManager,
      stateManager: bot1StateManager,
      state: bot1State,
      currentPhase: this.mapPhaseToCyclePhase(bot1State.phase)
    };

    // Bot2 インスタンスの構築
    const bot2Config: BotConfig = { 
      ...this.config, 
      poolObjectId: BOT2_CONFIG.poolObjectId 
    };
    const bot2PriceMonitor = new PriceMonitor(bot2Config);
    const bot2LpManager = new LpManager(bot2PriceMonitor, this.gasTracker, bot2Config);
    const bot2SwapManager = new SwapManager(bot2PriceMonitor, this.gasTracker, bot2Config);
    const bot2StateManager = new StateManager(this.sessionId, 'Bot2');
    const bot2Saved = bot2StateManager.loadState();
    const bot2State: BotState = bot2Saved || {
      phase: 'A',
      lpPositionId: null,
      lpPositionIdBelow: null,
      lpPositionIdAbove: null,
      lpPositionIdBelow1: null,
      lpPositionIdBelow2: null,
      lpPositionIdAbove1: null,
      lpPositionIdAbove2: null,
      bluefinOrderId: null,
      bluefinSide: 'none',
      basePrice: 0,
      rangeLower: 0,
      rangeUpper: 0,
      rangeLowerBelow: 0,
      rangeUpperBelow: 0,
      rangeLowerAbove: 0,
      rangeUpperAbove: 0,
      rangeLowerBelow1: 0,
      rangeUpperBelow1: 0,
      rangeLowerBelow2: 0,
      rangeUpperBelow2: 0,
      rangeLowerAbove1: 0,
      rangeUpperAbove1: 0,
      rangeLowerAbove2: 0,
      rangeUpperAbove2: 0,
      rangeWidth: 0.10, // デフォルト±10%
      totalCapital: 0,
      rebalanceCount24h: 0,
      lastRebalanceAt: 0,
      rebalanceHistory: [],
      isRebuilding: false
    };
    if (bot2State.isRebuilding) {
      Logger.warn('[STATE_MANAGER][Bot2] 前回の再構築中フラグが残っていたため、起動時に解除します。');
    }
    bot2State.isRebuilding = false;

    this.bot2 = {
      name: 'Bot2 (DEEP-SUI)',
      priceMonitor: bot2PriceMonitor,
      lpManager: bot2LpManager,
      swapManager: bot2SwapManager,
      stateManager: bot2StateManager,
      state: bot2State,
      currentPhase: this.mapPhaseToCyclePhase(bot2State.phase)
    };

    // RiskGuard は Bot1 / Bot2 を監視
    this.riskGuard = new RiskGuard(this.lpManager, this.hedgeManager);

    if (this.bot1.currentPhase === CyclePhase.EMERGENCY || this.bot2.currentPhase === CyclePhase.EMERGENCY) {
      this.isEmergencyStopped = true;
      this.currentPhase = CyclePhase.EMERGENCY;
    } else {
      this.currentPhase = this.bot1.currentPhase;
    }
  }

  private mapPhaseToCyclePhase(p: 'A' | 'B' | 'C' | 'D'): CyclePhase {
    switch (p) {
      case 'A': return CyclePhase.A;
      case 'B': return CyclePhase.B;
      case 'C': return CyclePhase.C;
      case 'D': return CyclePhase.D;
      default: return CyclePhase.IDLE;
    }
  }

  public get currentLowerBound() {
    return this.bot1.state.rangeLower;
  }

  public get currentUpperBound() {
    return this.bot1.state.rangeUpper;
  }

  public get rangeWidth() {
    return this.bot1.state.rangeWidth;
  }

  public getWalletAddress() {
    return this.keypair ? this.keypair.getPublicKey().toSuiAddress() : '';
  }

  public async setPrivateKey(secretKey: any) {
    this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
    
    // Bot1 / Bot2 の双方にキーペアを注入
    this.bot1.lpManager.setKeypair(this.keypair);
    this.bot1.swapManager.setKeypair(this.keypair);
    this.bot2.lpManager.setKeypair(this.keypair);
    this.bot2.swapManager.setKeypair(this.keypair);
    
    const rpcUrl = this.config.rpcUrl;
    const network = rpcUrl.includes('testnet') ? 'testnet' : 'mainnet';
    if (this.config.hedgeEnabled && this.config.hedgeMode === 'bluefin') {
      await this.hedgeManager.setupBluefin(this.keypair, rpcUrl, network as any);
    } else {
      Logger.info('[HEDGE] ヘッジ無効のためBluefin接続をスキップします。');
    }
  }

  public refreshConfig(newConfig: BotConfig) {
    this.config = newConfig;
    this.bot1.lpManager.refreshConfig(newConfig);
    this.bot1.swapManager.refreshConfig(newConfig);
    
    const bot2Config: BotConfig = { ...newConfig, poolObjectId: BOT2_CONFIG.poolObjectId };
    this.bot2.priceMonitor.refreshConfig(bot2Config);
    this.bot2.lpManager.refreshConfig(bot2Config);
    this.bot2.swapManager.refreshConfig(bot2Config);

    // 設定変更時はキャッシュを即座に無効化し、次のリクエストで再計算されるようにする
    this.lastPnlData = null;
    this.lastPnlDataTime = 0;
  }

  public async start() {
    // 起動する際は緊急停止状態を自動で解除（リセット）
    this.isEmergencyStopped = false;
    if (this.bot1.state.isRebuilding || this.bot2.state.isRebuilding) {
      Logger.warn('[STRATEGY] 起動時に残っていた再構築中フラグを解除して保存します。');
      this.bot1.state.isRebuilding = false;
      this.bot2.state.isRebuilding = false;
      this.bot1.stateManager.saveState(this.bot1.state);
      this.bot2.stateManager.saveState(this.bot2.state);
    }

    if (this.isRunning) return;
    this.isRunning = true;
    Logger.info("Sui Dual Delta-Neutral LP Bot (SUI/USDC & DEEP/SUI) を起動します...");
    
    if (this.keypair && this.config.hedgeEnabled && this.config.hedgeMode === 'bluefin') {
      await this.hedgeManager.syncPositionWithBluefin().catch(() => {});
    }

    await this.cycle();

    const monitorIntervalMs = Math.max(this.config.monitorIntervalMs || 0, 5 * 60 * 1000);
    Logger.info(`[STRATEGY] Cetus監視間隔を${Math.round(monitorIntervalMs / 1000)}秒に設定しました。`);
    this.timer = setInterval(async () => {
      await this.cycle();
    }, monitorIntervalMs);
  }

  public stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.currentPhase = CyclePhase.IDLE;
    Logger.info("Sui Dual Delta-Neutral LP Bot を停止しました。");
  }

  public async waitForIdle(timeoutMs = 120000): Promise<void> {
    const startedAt = Date.now();
    while (this.isCycleRunning || this.isPhaseARunning || this.isAnyBotRebuilding()) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error('通常監視サイクルの停止待ちがタイムアウトしました。少し待ってから再配置を再実行してください。');
      }
      await this.sleep(250);
    }
  }

  /**
   * メインサイクル
   */
  private async cycle() {
    if (!this.isRunning) return;
    if (Date.now() < this.rpcBackoffUntil) {
      Logger.warn(`[RPC_BACKOFF] RPC一時障害のため監視をあと${Math.ceil((this.rpcBackoffUntil - Date.now()) / 1000)}秒待機します。`);
      return;
    }
    if (this.isCycleRunning) {
      Logger.warn('[STRATEGY] 前回サイクルが実行中のため、この監視サイクルをスキップします。');
      return;
    }
    this.isCycleRunning = true;
    try {
      // 1. 各ボットの現在価格を取得
      const price1 = await this.bot1.priceMonitor.getCurrentPrice();
      const price2 = await this.bot2.priceMonitor.getCurrentPrice();
      if (!price1 || price1 <= 0 || !price2 || price2 <= 0) {
        this.riskGuard.recordError();
        return;
      }
      this.riskGuard.resetErrors();

      // 残高取得
      const balance = await this.bot1.lpManager.checkBalance();
      const lpDetails1 = this.bot1.state.lpPositionId 
        ? await this.bot1.lpManager.getPositionDetails(this.bot1.state.lpPositionId)
        : null;
      const lpDetails2 = this.bot2.state.lpPositionId
        ? await this.bot2.lpManager.getPositionDetails(this.bot2.state.lpPositionId)
        : null;

      const lpValue1 = lpDetails1?.usdValue || 0;
      const lpValue2 = lpDetails2?.usdValue || 0;
      const hedgeStatus = this.hedgeManager.getStatus(price1);
      const totalCapital = lpValue1 + lpValue2 + hedgeStatus.marginBalance + balance.usdcBalance;

      if (this.bot1.state.totalCapital === 0 || this.bot1.state.totalCapital > totalCapital * 1.5) {
        // 設定された目標運用資金または過去の初期資本が現在の実残高（ウォレット内資金）よりも極端に大きい場合、
        // 誤った緊急停止（RiskGuardのドローダウン検知）を防ぐため、実残高を初期資本としてセットします。
        const targetCapital = this.config.totalOperationalCapitalUsdc || totalCapital;
        if (targetCapital > totalCapital * 1.5) {
          Logger.warn(`[STRATEGY] 設定運用資金 ($${targetCapital.toFixed(2)}) または過去の初期資本 ($${this.bot1.state.totalCapital.toFixed(2)}) が現在の実残高 ($${totalCapital.toFixed(2)}) より極端に大きいため、初期資本を実残高に合わせてリセットします。`);
          this.bot1.state.totalCapital = totalCapital || 10.0;
        } else {
          this.bot1.state.totalCapital = targetCapital || 10.0;
        }
        this.bot2.state.totalCapital = this.bot1.state.totalCapital;
      }

      // ── 安全性監視 (RiskGuard) ──
      const safety = await this.riskGuard.checkSafety(
        this.bot1.state.totalCapital,
        totalCapital,
        balance.suiBalance
      );

      if (safety.isEmergency) {
        await this.emergencyStop(safety.reason || 'Risk Guard triggered');
        return;
      }

      if (this.isAnyBotRebuilding()) {
        Logger.warn('[SURGE_REBUILD] 再構築中のため、監視ループとヘッジ計算をスキップします。');
        this.bot1.stateManager.saveState(this.bot1.state);
        this.bot2.stateManager.saveState(this.bot2.state);
        return;
      }

      // ── Bot1 / Bot2 サイクル ──
      // どちらかがフェーズAにいる場合、全資金をバランス配分して両ボットを同時セットアップ
      if (this.bot1.state.phase === 'A' || this.bot2.state.phase === 'A') {
        await this.executeCombinedPhaseA(price1, price2);
      } else {
        const surgeRebuildVersion = this.lastSurgeRebuildAt;
        await this.runSingleBotCycle(this.bot1, price1, balance.usdcBalance);
        if (this.lastSurgeRebuildAt !== surgeRebuildVersion) {
          Logger.info('[SURGE_REBUILD] 再構築直後のため、残りの監視とヘッジ計算は次サイクルに回します。');
          this.bot1.stateManager.saveState(this.bot1.state);
          this.bot2.stateManager.saveState(this.bot2.state);
          return;
        }
        await this.runSingleBotCycle(this.bot2, price2, balance.usdcBalance);
        if (this.lastSurgeRebuildAt !== surgeRebuildVersion) {
          Logger.info('[SURGE_REBUILD] 再構築直後のため、ヘッジ計算は次サイクルに回します。');
          this.bot1.stateManager.saveState(this.bot1.state);
          this.bot2.stateManager.saveState(this.bot2.state);
          return;
        }
      }

      // ── 統合ヘッジ管理 ──
      if (this.isAnyBotRebuilding()) {
        Logger.warn('[SURGE_REBUILD] 再構築中のため、ヘッジ計算をスキップします。');
      } else {
        await this.maintainHedge(price1);
      }

      // 状態の保存
      this.bot1.stateManager.saveState(this.bot1.state);
      this.bot2.stateManager.saveState(this.bot2.state);
      
      this.currentPhase = this.bot1.currentPhase; // UI用

      if (this.saveStateCallback) {
        this.saveStateCallback();
      }

    } catch (e: any) {
      if (isTemporaryRpcError(e)) {
        this.rpcBackoffUntil = Date.now() + 60000;
        Logger.warn(`[RPC_BACKOFF] RPC一時障害を検出しました。60秒間、新規監視・再構築を停止します: ${e.message}`);
        if (Date.now() - this.lastRpcErrorEventAt >= 300000) {
          this.lastRpcErrorEventAt = Date.now();
          this.tracker.recordEvent('RPC一時障害', `60秒バックオフ: ${e.message}`, this.bot1.state.basePrice).catch(() => {});
        }
      } else {
        Logger.error(`[CYCLE_ERROR] ${e.message}`, e);
        this.riskGuard.recordError();
        this.tracker.recordEvent('システムエラー', `サイクル実行エラー: ${e.message}`, this.bot1.state.basePrice).catch(() => {});
      }
    } finally {
      this.isCycleRunning = false;
    }
  }

  /**
   * 単一ボットの実行判定
   */
  private async runSingleBotCycle(bot: BotInstance, price: number, usdcBalance: number) {
    switch (bot.state.phase) {
      case 'A':
        // フェーズAは cycle() 内の executeCombinedPhaseA で両ボットまとめて処理するため、
        // ここには到達しない（到達した場合は何もしない）
        Logger.info(`[${bot.name}] フェーズAはスキップ（統合フェーズAで処理済み）`);
        break;
      case 'B':
        await this.executePhaseB(bot, price);
        break;
      case 'C':
        await this.executePhaseC(bot, price);
        break;
      case 'D':
        await this.executePhaseD(bot, price);
        break;
    }
  }

  private isAnyBotRebuilding(): boolean {
    return !!(this.bot1?.state?.isRebuilding || this.bot2?.state?.isRebuilding);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async waitForBalanceIncrease(
    label: string,
    before: number,
    readBalance: () => Promise<number>
  ): Promise<number> {
    let latest = before;
    for (let attempt = 1; attempt <= 8; attempt++) {
      latest = await readBalance();
      if (latest > before + 0.000001) {
        return latest - before;
      }
      Logger.info(`[${label}] クローズ資金の残高反映待ち (${attempt}/8)...`);
      await this.sleep(1000);
    }
    return Math.max(0, latest - before);
  }

  private async addLiquidityWithRpcRetry(
    bot: BotInstance,
    lower: number,
    upper: number,
    amount: number,
    isCoinA: boolean,
    customLowerTick?: number,
    customUpperTick?: number
  ) {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const beforeIds = await bot.lpManager.getActivePositionIds();
      if (beforeIds.length >= 4) {
        throw new Error(`[POSITION_CAP] ${bot.name} already has ${beforeIds.length} active positions; refusing to create another.`);
      }

      try {
        return await bot.lpManager.addLiquidity(lower, upper, amount, isCoinA, customLowerTick, customUpperTick);
      } catch (e: any) {
        const retryable = String(e?.message || e).includes('429');
        if (!retryable || attempt === maxAttempts) {
          throw e;
        }

        const afterIds = await bot.lpManager.getActivePositionIds().catch(() => beforeIds);
        const createdId = afterIds.find(id => !beforeIds.includes(id));
        if (createdId) {
          Logger.warn(`[${bot.name}] LP作成後の応答で429が発生しましたが、新規ポジション ${createdId} を確認したため再送しません。`);
          return { digest: '', gasCostUsdc: 0, positionId: createdId };
        }

        const delayMs = attempt * 15000;
        Logger.warn(`[${bot.name}] RPC 429のためLP作成を${delayMs / 1000}秒後に再試行します (${attempt}/${maxAttempts})。`);
        await this.sleep(delayMs);
      }
    }
    throw new Error('LP作成の再試行回数を超えました。');
  }

  private getRangeOrderPositionSnapshot(bot: BotInstance) {
    return [
      { slot: 'Below2', id: bot.state.lpPositionIdBelow2, lower: bot.state.rangeLowerBelow2, upper: bot.state.rangeUpperBelow2 },
      { slot: 'Below1', id: bot.state.lpPositionIdBelow1, lower: bot.state.rangeLowerBelow1, upper: bot.state.rangeUpperBelow1 },
      { slot: 'Above1', id: bot.state.lpPositionIdAbove1, lower: bot.state.rangeLowerAbove1, upper: bot.state.rangeUpperAbove1 },
      { slot: 'Above2', id: bot.state.lpPositionIdAbove2, lower: bot.state.rangeLowerAbove2, upper: bot.state.rangeUpperAbove2 },
    ];
  }

  private formatPositionSnapshot(bot: BotInstance): string {
    return this.getRangeOrderPositionSnapshot(bot)
      .map(p => `${p.slot}: id=${p.id || 'null'}, range=${p.lower?.toFixed?.(6) || '0.000000'}-${p.upper?.toFixed?.(6) || '0.000000'}`)
      .join(' | ');
  }

  private resetRangeOrderState(bot: BotInstance) {
    bot.state.lpPositionId = null;
    bot.state.lpPositionIdBelow = null;
    bot.state.lpPositionIdAbove = null;
    bot.state.lpPositionIdBelow1 = null;
    bot.state.lpPositionIdBelow2 = null;
    bot.state.lpPositionIdAbove1 = null;
    bot.state.lpPositionIdAbove2 = null;
    bot.state.rangeLowerBelow1 = 0;
    bot.state.rangeUpperBelow1 = 0;
    bot.state.rangeLowerBelow2 = 0;
    bot.state.rangeUpperBelow2 = 0;
    bot.state.rangeLowerAbove1 = 0;
    bot.state.rangeUpperAbove1 = 0;
    bot.state.rangeLowerAbove2 = 0;
    bot.state.rangeUpperAbove2 = 0;
    bot.state.breachStartAt = undefined;
    bot.state.missingPositionsStartAt = undefined;
    bot.state.lastSlideDirection = null;
    bot.state.phase = 'A';
    bot.currentPhase = CyclePhase.A;
  }

  private calculateSurgeStepDrift(bot: BotInstance, price: number): { steps: number; centerPrice: number; stepWidth: number } {
    const centerFromRanges = bot.state.rangeUpperBelow1 > 0 && bot.state.rangeLowerAbove1 > 0
      ? (bot.state.rangeUpperBelow1 + bot.state.rangeLowerAbove1) / 2
      : bot.state.basePrice;
    const centerPrice = centerFromRanges > 0 ? centerFromRanges : price;
    const widthPct = this.config.rangeOrderWidthPct || 0.01;
    const measuredWidths = [
      bot.state.rangeUpperBelow2 - bot.state.rangeLowerBelow2,
      bot.state.rangeUpperBelow1 - bot.state.rangeLowerBelow1,
      bot.state.rangeUpperAbove1 - bot.state.rangeLowerAbove1,
      bot.state.rangeUpperAbove2 - bot.state.rangeLowerAbove2,
    ].filter(v => Number.isFinite(v) && v > 0);
    const stepWidth = measuredWidths.length > 0
      ? measuredWidths.reduce((sum, v) => sum + v, 0) / measuredWidths.length
      : centerPrice * widthPct;
    const steps = stepWidth > 0 ? Math.round((price - centerPrice) / stepWidth) : 0;
    return { steps, centerPrice, stepWidth };
  }

  private validateRangeOrderState(bot: BotInstance): boolean {
    const slots = this.getRangeOrderPositionSnapshot(bot);
    const allPresent = slots.every(p => !!p.id && p.lower > 0 && p.upper > p.lower);
    const noOverlap = slots.every((p, idx) => idx === 0 || p.lower >= slots[idx - 1].upper);
    return allPresent && noOverlap;
  }

  private async getRangeOrderPositionStatus(bot: BotInstance) {
    const activeIds = await bot.lpManager.getActivePositionIds();
    const trackedIds = this.getRangeOrderPositionSnapshot(bot)
      .map(p => p.id)
      .filter(Boolean) as string[];
    const activeIdSet = new Set(activeIds);
    const uniqueTrackedIds = new Set(trackedIds);
    const trackedLiveCount = trackedIds.filter(id => activeIdSet.has(id)).length;
    const extraIds = activeIds.filter(id => !uniqueTrackedIds.has(id));

    return {
      activeIds,
      trackedIds,
      trackedLiveCount,
      extraIds,
      isExact: trackedIds.length === 4 &&
        uniqueTrackedIds.size === 4 &&
        trackedLiveCount === 4 &&
        activeIds.length === 4 &&
        extraIds.length === 0,
    };
  }

  private async validateRangeOrderStateOnChain(bot: BotInstance): Promise<boolean> {
    if (!this.validateRangeOrderState(bot)) {
      return false;
    }

    try {
      const status = await this.getRangeOrderPositionStatus(bot);
      if (!status.isExact) {
        Logger.warn(`[PHASE_A][${bot.name}] 指値ポジションが4件ちょうどではありません。trackedLive=${status.trackedLiveCount}/4 totalActive=${status.activeIds.length}/4 state=${status.trackedIds.join(', ')} extra=${status.extraIds.join(', ') || 'none'} active=${status.activeIds.join(', ')}`);
      }
      return status.isExact;
    } catch (e: any) {
      Logger.warn(`[PHASE_A][${bot.name}] チェーン上ポジション確認に失敗したため再構築します: ${e.message}`);
      return false;
    }
  }

  private markBothBotsForRangeOrderRebuild() {
    this.bot1.state.phase = 'A';
    this.bot1.currentPhase = CyclePhase.A;
    this.bot2.state.phase = 'A';
    this.bot2.currentPhase = CyclePhase.A;
    this.bot1.state.missingPositionsStartAt = undefined;
    this.bot2.state.missingPositionsStartAt = undefined;
    this.bot1.state.breachStartAt = undefined;
    this.bot2.state.breachStartAt = undefined;
    this.bot1.state.lastSlideDirection = null;
    this.bot2.state.lastSlideDirection = null;
    this.bot1.stateManager.saveState(this.bot1.state);
    this.bot2.stateManager.saveState(this.bot2.state);
  }

  private async rebuildAllRangeOrderPositionsForSurge(detectedPrice: number, driftSteps: number): Promise<void> {
    if (this.isAnyBotRebuilding() || this.isPhaseARunning) {
      Logger.warn('[SURGE_REBUILD] 再構築またはフェーズAが既に実行中のため、急騰対応をスキップします。');
      return;
    }

    const startedAt = Date.now();
    const detectedAt = new Date(startedAt).toISOString();
    const beforeBot1 = this.formatPositionSnapshot(this.bot1);
    const beforeBot2 = this.formatPositionSnapshot(this.bot2);
    const maxRetries = Math.max(1, this.config.surgeMaxRetries || 3);

    this.bot1.state.isRebuilding = true;
    this.bot2.state.isRebuilding = true;
    this.isRolling[this.bot1.name] = true;
    this.isRolling[this.bot2.name] = true;
    this.bot1.stateManager.saveState(this.bot1.state);
    this.bot2.stateManager.saveState(this.bot2.state);

    Logger.warn(`[SURGE_REBUILD] ===== 急騰・急落対応を開始 =====`);
    Logger.warn(`[SURGE_REBUILD] 検出時刻=${detectedAt}, 検出価格=$${detectedPrice.toFixed(6)}, ずれ段数=${driftSteps}`);
    Logger.warn(`[SURGE_REBUILD] 再構築前 Bot1: ${beforeBot1}`);
    Logger.warn(`[SURGE_REBUILD] 再構築前 Bot2: ${beforeBot2}`);
    await this.tracker.recordEvent(
      '急騰・急落検出',
      `検出時刻=${detectedAt}, 価格=$${detectedPrice.toFixed(6)}, ずれ段数=${driftSteps}. 再構築前 Bot1=[${beforeBot1}] Bot2=[${beforeBot2}]`,
      detectedPrice
    ).catch(() => {});

    try {
      await this.sleep(this.config.surgeRebuildDelayMs || 3000);

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          Logger.info(`[SURGE_REBUILD] 再構築試行 ${attempt}/${maxRetries} を開始します。`);

          await this.bot1.lpManager.forceCloseAllPositions();
          await this.bot2.lpManager.forceCloseAllPositions();

          this.resetRangeOrderState(this.bot1);
          this.resetRangeOrderState(this.bot2);
          this.bot1.stateManager.saveState(this.bot1.state);
          this.bot2.stateManager.saveState(this.bot2.state);

          const latestPrice1 = await this.bot1.priceMonitor.getCurrentPrice();
          const latestPrice2 = await this.bot2.priceMonitor.getCurrentPrice();
          Logger.info(`[SURGE_REBUILD] 待機後の最新価格でレンジを再計算します。Bot1=$${latestPrice1.toFixed(6)}, Bot2=${latestPrice2.toFixed(6)}`);

          await this.executeCombinedPhaseA(latestPrice1, latestPrice2);

          const bot1Valid = await this.validateRangeOrderStateOnChain(this.bot1);
          const bot2Valid = await this.validateRangeOrderStateOnChain(this.bot2);
          if (!bot1Valid || !bot2Valid) {
            throw new Error('再構築後の8ポジション状態が不完全、レンジが重複、またはチェーン上で有効ではありません。');
          }

          const elapsedMs = Date.now() - startedAt;
          const afterBot1 = this.formatPositionSnapshot(this.bot1);
          const afterBot2 = this.formatPositionSnapshot(this.bot2);
          Logger.success(`[SURGE_REBUILD] ===== 急騰・急落対応 完了 (${elapsedMs}ms) =====`);
          Logger.success(`[SURGE_REBUILD] 再構築後 Bot1: ${afterBot1}`);
          Logger.success(`[SURGE_REBUILD] 再構築後 Bot2: ${afterBot2}`);
          this.lastSurgeRebuildAt = Date.now();
          await this.tracker.recordEvent(
            '急騰・急落再構築完了',
            `所要時間=${elapsedMs}ms, ずれ段数=${driftSteps}. 再構築後 Bot1=[${afterBot1}] Bot2=[${afterBot2}]`,
            latestPrice1
          ).catch(() => {});
          return;
        } catch (e: any) {
          Logger.error(`[SURGE_REBUILD] 再構築試行 ${attempt}/${maxRetries} に失敗しました: ${e.message}`, e);
          await this.tracker.recordEvent('急騰・急落再構築失敗', `試行 ${attempt}/${maxRetries}: ${e.message}`, detectedPrice).catch(() => {});
          if (attempt < maxRetries) {
            const errorText = String(e?.message || e);
            const isRpcThrottle = errorText.includes('429') || errorText.includes('Too Many Requests');
            const baseDelay = isRpcThrottle ? 15000 : (this.config.surgeRebuildDelayMs || 3000);
            const retryDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), 60000);
            Logger.warn(`[SURGE_REBUILD] ${retryDelay / 1000}秒待機して再試行します。`);
            await this.sleep(retryDelay);
          }
        }
      }

      Logger.error('[SURGE_REBUILD] 最大リトライ回数に到達しました。フェーズAからの再実行にフォールバックします。');
      this.resetRangeOrderState(this.bot1);
      this.resetRangeOrderState(this.bot2);
      this.bot1.stateManager.saveState(this.bot1.state);
      this.bot2.stateManager.saveState(this.bot2.state);
      this.lastSurgeRebuildAt = Date.now();
      await this.tracker.recordEvent('急騰・急落フォールバック', '再構築に失敗したため、フェーズAからの再実行へフォールバックしました。', detectedPrice).catch(() => {});
    } finally {
      this.bot1.state.isRebuilding = false;
      this.bot2.state.isRebuilding = false;
      this.isRolling[this.bot1.name] = false;
      this.isRolling[this.bot2.name] = false;
      this.bot1.stateManager.saveState(this.bot1.state);
      this.bot2.stateManager.saveState(this.bot2.state);
    }
  }

  /**
   * 両ボット統合フェーズ A:
   * ウォレット内の全資金（USDC + DEEP + SUI）を把握し、50:50で自動配分。
   * Bot1（SUI/USDC）→ Bot2（DEEP/SUI）の順番でLP構築（WalletTxQueue経由で競合防止）。
   */
  private async executeCombinedPhaseA(price1: number, price2: number) {
    if (this.isPhaseARunning) {
      Logger.warn('[PHASE_A] フェーズAが既に実行中のためスキップします。');
      return;
    }
    this.isPhaseARunning = true;

    try {
      Logger.info('[PHASE_A] ===== 両ボット統合フェーズA 開始 =====');

      // ── Step 0: 既存ポジションの確認および古いポジションのクリア ──
      if (this.config.strategyMode === 'range_order') {
        const hasBot1Positions = await this.validateRangeOrderStateOnChain(this.bot1);
        const hasBot2Positions = await this.validateRangeOrderStateOnChain(this.bot2);

        if (hasBot1Positions && hasBot2Positions) {
          Logger.info(`[PHASE_A] ✅ 指値レンジ戦略の既存ポジションがすべて存在するため再構築をスキップ → フェーズBに移行します。`);
          this.bot1.state.phase = 'B';
          this.bot1.currentPhase = CyclePhase.B;
          this.bot2.state.phase = 'B';
          this.bot2.currentPhase = CyclePhase.B;
          this.bot1.stateManager.saveState(this.bot1.state);
          this.bot2.stateManager.saveState(this.bot2.state);
          return;
        }

        // ポジションが揃っていない場合、残高確認前にすべての古いポジションをクローズして資金を回収する
        Logger.info('[PHASE_A] ⚠️ ポジションが未構築または一部欠落しているため、既存ポジションを全てクローズして初期化します。');
        
        this.bot1.currentPhase = CyclePhase.A;
        await this.bot1.lpManager.forceCloseAllPositions();
        this.resetRangeOrderState(this.bot1);

        this.bot2.currentPhase = CyclePhase.A;
        await this.bot2.lpManager.forceCloseAllPositions();
        this.resetRangeOrderState(this.bot2);

        this.bot1.stateManager.saveState(this.bot1.state);
        this.bot2.stateManager.saveState(this.bot2.state);
      }

      // ── Step 1: 残高を直接SuiClientから取得（クローズ後の最新残高） ──
      const walletAddress = this.bot1.lpManager.getWalletAddress();
      const usdcCoinType  = this.bot1.lpManager.coinTypeA || '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
      const suiCoinType   = '0x2::sui::SUI';

      const [usdcBalObj, suiBalObj] = await Promise.all([
        this.bot1.lpManager.suiClient.getBalance({ owner: walletAddress, coinType: usdcCoinType }),
        this.bot1.lpManager.suiClient.getBalance({ owner: walletAddress, coinType: suiCoinType })
      ]);
      const usdcBalance = Number(usdcBalObj.totalBalance) / 1e6;  // USDC decimals=6
      const suiBalance  = Number(suiBalObj.totalBalance)  / 1e9;  // SUI decimals=9

      const GAS_RESERVE = 0.3; // ガス代確保分 (SUI)
      const safeSuiTotal = Math.max(0, suiBalance - GAS_RESERVE);

      // DEEP残高取得（Bot2プールのcoinTypeAがDEEPのはず）
      let deepBalance = 0;
      const deepCoinType = this.bot2.lpManager.coinTypeA;
      if (deepCoinType) {
        try {
          const deepBal = await this.bot1.lpManager.suiClient.getBalance({
            owner: walletAddress,
            coinType: deepCoinType
          });
          deepBalance = Number(deepBal.totalBalance) / 1e6; // DEEP decimals = 6
        } catch (e) {
          Logger.warn('[PHASE_A] DEEP残高取得失敗。0として処理します。');
        }
      }

      // ── Step 2: 全資産をUSDC建てで合算 ──
      const suiValueUsdc  = safeSuiTotal * price1;
      const deepValueUsdc = deepBalance  * price2 * price1; // DEEP→SUI→USDC換算
      const totalAssetsUsdc = usdcBalance + suiValueUsdc + deepValueUsdc;

      Logger.info(`[PHASE_A] 全資産 (ガス代 ${GAS_RESERVE} SUI確保後):`);
      Logger.info(`  USDC:  $${usdcBalance.toFixed(2)}`);
      Logger.info(`  SUI:   ${safeSuiTotal.toFixed(4)} SUI (≈ $${suiValueUsdc.toFixed(2)})`);
      Logger.info(`  DEEP:  ${deepBalance.toFixed(2)} DEEP (≈ $${deepValueUsdc.toFixed(2)})`);
      Logger.info(`  合計:  ≈ $${totalAssetsUsdc.toFixed(2)} USDC`);

      if (totalAssetsUsdc < 1.0) {
        Logger.warn('[PHASE_A] 総資産が $1.00 未満のため待機します。');
        return;
      }

      // ── Step 3: Bot1 / Bot2 に 50:50 配分 ──
      const bot1AllocUsdc = totalAssetsUsdc * 0.50;
      const bot2AllocUsdc = totalAssetsUsdc * 0.50;
      Logger.info(`[PHASE_A] 資金配分: Bot1 ≈$${bot1AllocUsdc.toFixed(2)}, Bot2 ≈$${bot2AllocUsdc.toFixed(2)}`);

      // ── Step 3.5: SUI不足を自動補充（USDC → SUI スワップ）──
      const bot2SuiNeededEst = (bot2AllocUsdc * 0.50) / price1; // Bot2が必要なSUI（概算）
      const totalSuiNeeded   = GAS_RESERVE + bot2SuiNeededEst;
      const suiShortfall     = totalSuiNeeded - suiBalance;

      if (suiShortfall > 0.05 && usdcBalance > 1.0) {
        const suiShortfallUsdc = suiShortfall * price1 * 1.10;
        const swapUsdcForSui   = Math.min(suiShortfallUsdc, usdcBalance * 0.30);

        if (swapUsdcForSui > 0.3) {
          Logger.info(`[PHASE_A] ⚠️ SUI不足を検知 (残高: ${suiBalance.toFixed(4)} SUI, 必要: ${totalSuiNeeded.toFixed(4)} SUI)`);
          Logger.info(`[PHASE_A] 🔄 USDC $${swapUsdcForSui.toFixed(2)} → SUI を自動スワップして補充します...`);
          const autoSuiSwap = await this.bot1.swapManager.swapUsdcToSui(swapUsdcForSui);
          Logger.success(`[PHASE_A] ✅ SUI自動補充完了: ${autoSuiSwap.amountOut.toFixed(4)} SUI を獲得`);
          await this.tracker.recordEvent(
            'SUI自動補充',
            `SUI残高不足のため USDC $${swapUsdcForSui.toFixed(2)} → ${autoSuiSwap.amountOut.toFixed(4)} SUI に自動スワップしました`,
            price1, autoSuiSwap.digest
          ).catch(() => {});
        }
      }

      if (this.config.strategyMode === 'range_order') {
        Logger.info('[PHASE_A] === 指値レンジ戦略 (Range Order - 4ポジション隣接配置) で再配分を実行します ===');
        Logger.info('[PHASE_A] レイアウト: [Below2|Below1|現在価格|Above1|Above2] 各1%幅');

        // width のみで現在価格をセンターに隣接配置（offsetなし）
        const width = this.config.rangeOrderWidthPct || 0.01;

        // 目標残高の算出（全体の資金を8等分 = 各ボットの 25% ずつ 4ポジション）
        const bot1UsdcNeeded = bot1AllocUsdc * 0.25;
        const bot2DeepNeeded = (bot2AllocUsdc * 0.25) / (price2 * price1);

        Logger.info(`[PHASE_A] 資産別目標: Bot1 USDC=$${(bot1UsdcNeeded * 2).toFixed(2)} | Bot2 DEEP=${(bot2DeepNeeded * 2).toFixed(2)} | 残りをSUIへ配分`);

        // 1. DEEP残高の調整 (目標の 50% = 2倍が必要)
        const totalDeepNeeded = bot2DeepNeeded * 2.0;
        let didSwap = false;
        if (deepBalance > totalDeepNeeded + 1.0) {
          const deepToSell = deepBalance - totalDeepNeeded;
          Logger.info(`[PHASE_A] 余剰DEEPを売却します: ${deepToSell.toFixed(2)} DEEP -> SUI`);
          await this.bot2.swapManager.swapDeepToSui(deepToSell);
          didSwap = true;
        } else if (deepBalance < totalDeepNeeded - 1.0) {
          const deepToBuy = totalDeepNeeded - deepBalance;
          const preBal = await this.bot1.lpManager.checkBalance();
          const suiToSwap = Math.min(deepToBuy * price2, Math.max(0, preBal.suiBalance - 1.0));
          if (suiToSwap > 0.05) {
            Logger.info(`[PHASE_A] 不足DEEPを補うため SUIをスワップします: ${suiToSwap.toFixed(4)} SUI -> DEEP`);
            await this.bot2.swapManager.swapSuiToDeep(suiToSwap);
            didSwap = true;
          }
        }

        // 最新残高を更新
        let currentBal = await this.bot1.lpManager.checkBalance();

        // 2. USDC残高の調整 (目標の 50% = 2倍が必要)
        const totalUsdcNeeded = bot1UsdcNeeded * 2.0;
        if (currentBal.usdcBalance > totalUsdcNeeded + 0.1) {
          const usdcToSell = currentBal.usdcBalance - totalUsdcNeeded;
          if (usdcToSell > 0.1) {
            Logger.info(`[PHASE_A] 余剰USDCを売却します: ${usdcToSell.toFixed(2)} USDC -> SUI`);
            await this.bot1.swapManager.swapUsdcToSui(usdcToSell);
            didSwap = true;
          }
        } else if (currentBal.usdcBalance < totalUsdcNeeded - 0.1) {
          const usdcToBuy = totalUsdcNeeded - currentBal.usdcBalance;
          const suiToSell = Math.min(usdcToBuy / price1, Math.max(0, currentBal.suiBalance - 1.0));
          if (suiToSell > 0.05) {
            Logger.info(`[PHASE_A] 不足USDCを補うため SUIを売却します: ${suiToSell.toFixed(4)} SUI -> USDC`);
            await this.bot1.swapManager.swapSuiToUsdc(suiToSell);
            didSwap = true;
          }
        }

        if (didSwap) {
          Logger.info(`[PHASE_A] ⏳ スワップ後の残高反映を待機します (3秒)...`);
          await this.sleep(3000);
        }

        // 最新の残高でLPを構築
        const finalBal = await this.bot1.lpManager.checkBalance();
        const finalDeepObj = await this.bot1.lpManager.suiClient.getBalance({
          owner: this.bot1.lpManager.getWalletAddress(),
          coinType: deepCoinType || ''
        });
        const finalDeep = Number(finalDeepObj.totalBalance) / 1e6;

        const allocatedIds1: string[] = [];

        // 構築直前の価格と残高から、8ポジション共通のUSD予算を一度だけ確定する。
        // LpManagerは最大投入額に3%の余裕を持たせるため、4%の残高バッファを先に確保する。
        price1 = await this.bot1.priceMonitor.getCurrentPrice();
        price2 = await this.bot2.priceMonitor.getCurrentPrice();
        const LP_BALANCE_BUFFER = 1.04;
        const safeSuiForLp = Math.max(0, finalBal.suiBalance - GAS_RESERVE);
        const deepPriceUsdc = price2 * price1;
        const poolUsdcBalance = this.bot1.lpManager.coinTypeA.toLowerCase().includes('usdc')
          ? finalBal.coinABalance
          : finalBal.coinBBalance;
        const finalAssetsUsdc =
          poolUsdcBalance +
          safeSuiForLp * price1 +
          finalDeep * deepPriceUsdc;

        const equalPositionUsd = Math.min(
          finalAssetsUsdc / 8,
          poolUsdcBalance / (2 * LP_BALANCE_BUFFER),
          safeSuiForLp * price1 / (4 * LP_BALANCE_BUFFER),
          finalDeep * deepPriceUsdc / (2 * LP_BALANCE_BUFFER)
        );

        if (!Number.isFinite(equalPositionUsd) || equalPositionUsd <= 0.05) {
          throw new Error(`[PHASE_A] 8ポジションを均等構築できる残高がありません (1ポジション予算: $${equalPositionUsd.toFixed(4)})`);
        }

        const equalUsdcAmount = equalPositionUsd;
        const equalSuiAmount = equalPositionUsd / price1;
        const equalDeepAmount = equalPositionUsd / deepPriceUsdc;

        Logger.info(`[PHASE_A] 8ポジション均等配分: 1ポジション=$${equalPositionUsd.toFixed(4)}`);
        Logger.info(`[PHASE_A] 固定投入量: USDC=${equalUsdcAmount.toFixed(4)} x2, SUI=${equalSuiAmount.toFixed(6)} x4, DEEP=${equalDeepAmount.toFixed(4)} x2`);
        Logger.info(`[PHASE_A] 最新価格: SUI/USDC=$${price1.toFixed(4)}, DEEP/SUI=${price2.toFixed(6)}`);

        // ══ Bot1: 現在価格中心に1%幅4ポジション隣接配置 ══
        const offset = 0.0005; // 0.05% 安全マージン
        
        // lpManagerから被らない安全なtickとそれに対応する価格を取得
        const tickRes1Below1 = await this.bot1.lpManager.getRangeOrderTicks('below', 1, width, offset);
        const tickRes1Below2 = await this.bot1.lpManager.getRangeOrderTicks('below', 2, width, offset);
        const tickRes1Above1 = await this.bot1.lpManager.getRangeOrderTicks('above', 1, width, offset);
        const tickRes1Above2 = await this.bot1.lpManager.getRangeOrderTicks('above', 2, width, offset);

        const bot1LowerBelow1 = tickRes1Below1.lowerPrice;
        const bot1UpperBelow1 = tickRes1Below1.upperPrice;
        const bot1LowerBelow2 = tickRes1Below2.lowerPrice;
        const bot1UpperBelow2 = tickRes1Below2.upperPrice;
        const bot1LowerAbove1 = tickRes1Above1.lowerPrice;
        const bot1UpperAbove1 = tickRes1Above1.upperPrice;
        const bot1LowerAbove2 = tickRes1Above2.lowerPrice;
        const bot1UpperAbove2 = tickRes1Above2.upperPrice;

        Logger.info(`[Bot1] レンジ構成 (Tick指定配置):`);
        Logger.info(`  Below2: $${bot1LowerBelow2.toFixed(4)} - $${bot1UpperBelow2.toFixed(4)} (Ticks: [${tickRes1Below2.lowerTick}, ${tickRes1Below2.upperTick}])`);
        Logger.info(`  Below1: $${bot1LowerBelow1.toFixed(4)} - $${bot1UpperBelow1.toFixed(4)} (Ticks: [${tickRes1Below1.lowerTick}, ${tickRes1Below1.upperTick}])`);
        Logger.info(`  現在価格: $${price1.toFixed(4)}`);
        Logger.info(`  Above1: $${bot1LowerAbove1.toFixed(4)} - $${bot1UpperAbove1.toFixed(4)} (Ticks: [${tickRes1Above1.lowerTick}, ${tickRes1Above1.upperTick}])`);
        Logger.info(`  Above2: $${bot1LowerAbove2.toFixed(4)} - $${bot1UpperAbove2.toFixed(4)} (Ticks: [${tickRes1Above2.lowerTick}, ${tickRes1Above2.upperTick}])`);

        // ── Bot1 Below1: 均等額のUSDCを投入（買い指値）──
        const bot1LpUsdc1 = equalUsdcAmount;
        Logger.info(`[Bot1] Below1 LP構築 (レンジ: $${bot1LowerBelow1.toFixed(4)}-$${bot1UpperBelow1.toFixed(4)}, USDC: $${bot1LpUsdc1.toFixed(2)})...`);
        const lpRes1Below1 = await this.addLiquidityWithRpcRetry(this.bot1, bot1LowerBelow1, bot1UpperBelow1, bot1LpUsdc1, true, tickRes1Below1.lowerTick, tickRes1Below1.upperTick);
        const pos1Below1 = lpRes1Below1.positionId || (await this.bot1.lpManager.getActivePositionIds()).find(id => !allocatedIds1.includes(id));
        if (pos1Below1) {
          allocatedIds1.push(pos1Below1);
          this.bot1.state.lpPositionIdBelow1 = pos1Below1;
          this.bot1.state.rangeLowerBelow1 = bot1LowerBelow1;
          this.bot1.state.rangeUpperBelow1 = bot1UpperBelow1;
          Logger.success(`[Bot1] ✅ Below1指値LP構築完了: ${pos1Below1}`);
        }

        // ── Bot1 Below2: Below1と同額のUSDCを投入 ──
        const bot1LpUsdc2 = equalUsdcAmount;
        Logger.info(`[Bot1] Below2 LP構築 (レンジ: $${bot1LowerBelow2.toFixed(4)}-$${bot1UpperBelow2.toFixed(4)}, USDC: $${bot1LpUsdc2.toFixed(2)})...`);
        const lpRes1Below2 = await this.addLiquidityWithRpcRetry(this.bot1, bot1LowerBelow2, bot1UpperBelow2, bot1LpUsdc2, true, tickRes1Below2.lowerTick, tickRes1Below2.upperTick);
        const pos1Below2 = lpRes1Below2.positionId || (await this.bot1.lpManager.getActivePositionIds()).find(id => !allocatedIds1.includes(id));
        if (pos1Below2) {
          allocatedIds1.push(pos1Below2);
          this.bot1.state.lpPositionIdBelow2 = pos1Below2;
          this.bot1.state.rangeLowerBelow2 = bot1LowerBelow2;
          this.bot1.state.rangeUpperBelow2 = bot1UpperBelow2;
          Logger.success(`[Bot1] ✅ Below2指値LP構築完了: ${pos1Below2}`);
        }

        // ── Bot1 Above1: 均等額のSUIを投入（売り指値）──
        const bot1LpSui1 = equalSuiAmount;
        Logger.info(`[Bot1] Above1 LP構築 (レンジ: $${bot1LowerAbove1.toFixed(4)}-$${bot1UpperAbove1.toFixed(4)}, SUI: ${bot1LpSui1.toFixed(4)})...`);
        const lpRes1Above1 = await this.addLiquidityWithRpcRetry(this.bot1, bot1LowerAbove1, bot1UpperAbove1, bot1LpSui1, false, tickRes1Above1.lowerTick, tickRes1Above1.upperTick);
        const pos1Above1 = lpRes1Above1.positionId || (await this.bot1.lpManager.getActivePositionIds()).find(id => !allocatedIds1.includes(id));
        if (pos1Above1) {
          allocatedIds1.push(pos1Above1);
          this.bot1.state.lpPositionIdAbove1 = pos1Above1;
          this.bot1.state.rangeLowerAbove1 = bot1LowerAbove1;
          this.bot1.state.rangeUpperAbove1 = bot1UpperAbove1;
          Logger.success(`[Bot1] ✅ Above1指値LP構築完了: ${pos1Above1}`);
        }

        // ── Bot1 Above2: Above1と同額のSUIを投入 ──
        const bot1LpSui2 = equalSuiAmount;
        Logger.info(`[Bot1] Above2 LP構築 (レンジ: $${bot1LowerAbove2.toFixed(4)}-$${bot1UpperAbove2.toFixed(4)}, SUI: ${bot1LpSui2.toFixed(4)})...`);
        const lpRes1Above2 = await this.addLiquidityWithRpcRetry(this.bot1, bot1LowerAbove2, bot1UpperAbove2, bot1LpSui2, false, tickRes1Above2.lowerTick, tickRes1Above2.upperTick);
        const pos1Above2 = lpRes1Above2.positionId || (await this.bot1.lpManager.getActivePositionIds()).find(id => !allocatedIds1.includes(id));
        if (pos1Above2) {
          allocatedIds1.push(pos1Above2);
          this.bot1.state.lpPositionIdAbove2 = pos1Above2;
          this.bot1.state.rangeLowerAbove2 = bot1LowerAbove2;
          this.bot1.state.rangeUpperAbove2 = bot1UpperAbove2;
          Logger.success(`[Bot1] ✅ Above2指値LP構築完了: ${pos1Above2}`);
        }

        // ── Bot2 (SUI / DEEP) LP構築 ──
        const allocatedIds2: string[] = [];

        // ══ Bot2: 現在価格中心に1%幅4ポジション隣接配置 ══
        const tickRes2Below1 = await this.bot2.lpManager.getRangeOrderTicks('below', 1, width, offset);
        const tickRes2Below2 = await this.bot2.lpManager.getRangeOrderTicks('below', 2, width, offset);
        const tickRes2Above1 = await this.bot2.lpManager.getRangeOrderTicks('above', 1, width, offset);
        const tickRes2Above2 = await this.bot2.lpManager.getRangeOrderTicks('above', 2, width, offset);

        const bot2LowerBelow1 = tickRes2Below1.lowerPrice;
        const bot2UpperBelow1 = tickRes2Below1.upperPrice;
        const bot2LowerBelow2 = tickRes2Below2.lowerPrice;
        const bot2UpperBelow2 = tickRes2Below2.upperPrice;
        const bot2LowerAbove1 = tickRes2Above1.lowerPrice;
        const bot2UpperAbove1 = tickRes2Above1.upperPrice;
        const bot2LowerAbove2 = tickRes2Above2.lowerPrice;
        const bot2UpperAbove2 = tickRes2Above2.upperPrice;

        Logger.info(`[Bot2] レンジ構成 (Tick指定配置):`);
        Logger.info(`  Below2: ${bot2LowerBelow2.toFixed(6)} - ${bot2UpperBelow2.toFixed(6)} (Ticks: [${tickRes2Below2.lowerTick}, ${tickRes2Below2.upperTick}])`);
        Logger.info(`  Below1: ${bot2LowerBelow1.toFixed(6)} - ${bot2UpperBelow1.toFixed(6)} (Ticks: [${tickRes2Below1.lowerTick}, ${tickRes2Below1.upperTick}])`);
        Logger.info(`  現在価格: ${price2.toFixed(6)}`);
        Logger.info(`  Above1: ${bot2LowerAbove1.toFixed(6)} - ${bot2UpperAbove1.toFixed(6)} (Ticks: [${tickRes2Above1.lowerTick}, ${tickRes2Above1.upperTick}])`);
        Logger.info(`  Above2: ${bot2LowerAbove2.toFixed(6)} - ${bot2UpperAbove2.toFixed(6)} (Ticks: [${tickRes2Above2.lowerTick}, ${tickRes2Above2.upperTick}])`);

        // ── Bot2 Below1: Bot1のSUIポジションと同額を投入 ──
        const bot2LpSui1 = equalSuiAmount;
        Logger.info(`[Bot2] Below1 LP構築 (レンジ: ${bot2LowerBelow1.toFixed(6)}-${bot2UpperBelow1.toFixed(6)}, SUI: ${bot2LpSui1.toFixed(4)})...`);
        const lpRes2Below1 = await this.addLiquidityWithRpcRetry(this.bot2, bot2LowerBelow1, bot2UpperBelow1, bot2LpSui1, false, tickRes2Below1.lowerTick, tickRes2Below1.upperTick);
        const pos2Below1 = lpRes2Below1.positionId || (await this.bot2.lpManager.getActivePositionIds()).find(id => !allocatedIds1.includes(id) && !allocatedIds2.includes(id));
        if (pos2Below1) {
          allocatedIds2.push(pos2Below1);
          this.bot2.state.lpPositionIdBelow1 = pos2Below1;
          this.bot2.state.rangeLowerBelow1 = bot2LowerBelow1;
          this.bot2.state.rangeUpperBelow1 = bot2UpperBelow1;
          Logger.success(`[Bot2] ✅ Below1指値LP構築完了: ${pos2Below1}`);
        }

        // ── Bot2 Below2: 他のSUIポジションと同額を投入 ──
        const bot2LpSui2 = equalSuiAmount;
        Logger.info(`[Bot2] Below2 LP構築 (レンジ: ${bot2LowerBelow2.toFixed(6)}-${bot2UpperBelow2.toFixed(6)}, SUI: ${bot2LpSui2.toFixed(4)})...`);
        const lpRes2Below2 = await this.addLiquidityWithRpcRetry(this.bot2, bot2LowerBelow2, bot2UpperBelow2, bot2LpSui2, false, tickRes2Below2.lowerTick, tickRes2Below2.upperTick);
        const pos2Below2 = lpRes2Below2.positionId || (await this.bot2.lpManager.getActivePositionIds()).find(id => !allocatedIds1.includes(id) && !allocatedIds2.includes(id));
        if (pos2Below2) {
          allocatedIds2.push(pos2Below2);
          this.bot2.state.lpPositionIdBelow2 = pos2Below2;
          this.bot2.state.rangeLowerBelow2 = bot2LowerBelow2;
          this.bot2.state.rangeUpperBelow2 = bot2UpperBelow2;
          Logger.success(`[Bot2] ✅ Below2指値LP構築完了: ${pos2Below2}`);
        }

        // ── Bot2 Above1: 均等額のDEEPを投入（売り指値）──
        const bot2LpDeep1 = equalDeepAmount;
        Logger.info(`[Bot2] Above1 LP構築 (レンジ: ${bot2LowerAbove1.toFixed(6)}-${bot2UpperAbove1.toFixed(6)}, DEEP: ${bot2LpDeep1.toFixed(2)})...`);
        const lpRes2Above1 = await this.addLiquidityWithRpcRetry(this.bot2, bot2LowerAbove1, bot2UpperAbove1, bot2LpDeep1, true, tickRes2Above1.lowerTick, tickRes2Above1.upperTick);
        const pos2Above1 = lpRes2Above1.positionId || (await this.bot2.lpManager.getActivePositionIds()).find(id => !allocatedIds1.includes(id) && !allocatedIds2.includes(id));
        if (pos2Above1) {
          allocatedIds2.push(pos2Above1);
          this.bot2.state.lpPositionIdAbove1 = pos2Above1;
          this.bot2.state.rangeLowerAbove1 = bot2LowerAbove1;
          this.bot2.state.rangeUpperAbove1 = bot2UpperAbove1;
          Logger.success(`[Bot2] ✅ Above1指値LP構築完了: ${pos2Above1}`);
        }

        // ── Bot2 Above2: Above1と同額のDEEPを投入 ──
        const bot2LpDeep2 = equalDeepAmount;
        Logger.info(`[Bot2] Above2 LP構築 (レンジ: ${bot2LowerAbove2.toFixed(6)}-${bot2UpperAbove2.toFixed(6)}, DEEP: ${bot2LpDeep2.toFixed(2)})...`);
        const lpRes2Above2 = await this.addLiquidityWithRpcRetry(this.bot2, bot2LowerAbove2, bot2UpperAbove2, bot2LpDeep2, true, tickRes2Above2.lowerTick, tickRes2Above2.upperTick);
        const pos2Above2 = lpRes2Above2.positionId || (await this.bot2.lpManager.getActivePositionIds()).find(id => !allocatedIds1.includes(id) && !allocatedIds2.includes(id));
        if (pos2Above2) {
          allocatedIds2.push(pos2Above2);
          this.bot2.state.lpPositionIdAbove2 = pos2Above2;
          this.bot2.state.rangeLowerAbove2 = bot2LowerAbove2;
          this.bot2.state.rangeUpperAbove2 = bot2UpperAbove2;
          Logger.success(`[Bot2] ✅ Above2指値LP構築完了: ${pos2Above2}`);
        }

        if (allocatedIds1.length !== 4 || allocatedIds2.length !== 4) {
          throw new Error(`[PHASE_A] 8ポジションの構築を確認できませんでした (Bot1=${allocatedIds1.length}/4, Bot2=${allocatedIds2.length}/4)`);
        }

        this.bot1.state.basePrice   = price1;
        this.bot1.state.phase       = 'B';
        this.bot1.currentPhase      = CyclePhase.B;

        this.bot2.state.basePrice   = price2;
        this.bot2.state.phase       = 'B';
        this.bot2.currentPhase      = CyclePhase.B;

        this.bot1.stateManager.saveState(this.bot1.state);
        this.bot2.stateManager.saveState(this.bot2.state);
        Logger.success('[PHASE_A] ===== 指値レンジ戦略 統合フェーズA 完了 ===== (状態保存完了)');
      } else {
        // ── Step 0: 状態ファイルにポジションIDが記録済みかつ現在価格がレンジ内の場合はスキップ ──
        if (this.bot1.state.lpPositionId && this.bot2.state.lpPositionId) {
          const bot1RangeValid = price1 >= this.bot1.state.rangeLower && price1 <= this.bot1.state.rangeUpper;
          if (bot1RangeValid) {
            Logger.info(`[PHASE_A] ✅ 既存ポジションが有効かつ価格がレンジ内のため再構築をスキップ → フェーズBに移行します。`);
            this.bot1.state.phase = 'B';
            this.bot1.currentPhase = CyclePhase.B;
            this.bot2.state.phase = 'B';
            this.bot2.currentPhase = CyclePhase.B;
            this.bot1.stateManager.saveState(this.bot1.state);
            this.bot2.stateManager.saveState(this.bot2.state);
            return;
          }
        }

        // ════════════════════════════════════════
        //  Bot1 (SUI/USDC) フェーズA
        // ════════════════════════════════════════
        Logger.info('[Bot1] === フェーズA 開始 (SUI/USDC) ===');
        this.bot1.currentPhase = CyclePhase.A;
        await this.bot1.lpManager.forceCloseAllPositions();
        this.bot1.state.lpPositionId = null;

        // Bot1: 割当の50%をUSDC→SUIにスワップ（LP用SUI確保）
        // ウォレット全体のUSDCの45%を上限にして安全にスワップ
        const bot1SwapUsdc = Math.min(bot1AllocUsdc * 0.50, usdcBalance * 0.45);
        if (bot1SwapUsdc > 0.5) {
          Logger.info(`[Bot1] USDC $${bot1SwapUsdc.toFixed(2)} → SUI スワップ...`);
          const swapRes1 = await this.bot1.swapManager.swapUsdcToSui(bot1SwapUsdc);
          await this.tracker.recordEvent(
            '初期スワップ',
            `[Bot1] USDC $${bot1SwapUsdc.toFixed(2)} を SUI にスワップ。獲得: ${swapRes1.amountOut.toFixed(4)} SUI`,
            price1, swapRes1.digest
          ).catch(() => {});
        }

        // スワップ後の最新残高でLP構築（残っているUSDCを使用）
        const bot1Bal = await this.bot1.lpManager.checkBalance();
        const bot1LpUsdc = Math.min(bot1Bal.usdcBalance, bot1AllocUsdc * 0.52); // 少し余裕を持たせる
        const bot1Lower = price1 * (1 - this.bot1.state.rangeWidth);
        const bot1Upper = price1 * (1 + this.bot1.state.rangeWidth);

        Logger.info(`[Bot1] SUI/USDC LP構築 (レンジ: $${bot1Lower.toFixed(4)}-$${bot1Upper.toFixed(4)}, USDC: $${bot1LpUsdc.toFixed(2)})...`);
        const lpRes1 = await this.bot1.lpManager.addLiquidity(bot1Lower, bot1Upper, bot1LpUsdc, true);
        await this.tracker.recordEvent(
          'LP提供',
          `[Bot1] SUI-USDC LP構築完了。レンジ: $${bot1Lower.toFixed(4)}-$${bot1Upper.toFixed(4)}`,
          price1, lpRes1.digest
        ).catch(() => {});

        const pos1 = lpRes1.positionId || await this.bot1.lpManager.getActivePositionId();
        if (pos1) {
          this.bot1.state.lpPositionId = pos1;
          this.bot1.state.basePrice   = price1;
          this.bot1.state.rangeLower  = bot1Lower;
          this.bot1.state.rangeUpper  = bot1Upper;
          this.bot1.state.phase       = 'B';
          this.bot1.currentPhase      = CyclePhase.B;
          Logger.success(`[Bot1] ✅ フェーズA完了。ポジション: ${pos1}`);
        } else {
          Logger.warn('[Bot1] ⚠️ ポジションIDの取得に失敗。次のサイクルで再試行します。');
        }

        // ════════════════════════════════════════
        //  Bot2 (DEEP/SUI) フェーズA
        // ════════════════════════════════════════
        Logger.info('[Bot2] === フェーズA 開始 (DEEP/SUI) ===');
        this.bot2.currentPhase = CyclePhase.A;
        await this.bot2.lpManager.forceCloseAllPositions();
        this.bot2.state.lpPositionId = null;

        // Bot2: DEEP と SUI を 50:50 で用意する
        // 必要なDEEP量 = bot2割当の半分 ÷ (DEEP/USDCレート)
        const bot2DeepNeeded = (bot2AllocUsdc * 0.50) / (price2 * price1);
        const bot2SuiNeeded  = (bot2AllocUsdc * 0.50) / price1;

        Logger.info(`[Bot2] 目標: DEEP ${bot2DeepNeeded.toFixed(2)} + SUI ${bot2SuiNeeded.toFixed(4)}`);
        Logger.info(`[Bot2] 現在: DEEP ${deepBalance.toFixed(2)} + SUI (safe) ${safeSuiTotal.toFixed(4)}`);

        // DEEPが不足している場合のみ SUI → DEEP スワップ
        const deepShortfall = bot2DeepNeeded - deepBalance;
        if (deepShortfall > 1.0) {
          // 不足DEEPをSUIから調達（現在のSUI残高を再取得）
          const preBal2 = await this.bot1.lpManager.checkBalance();
          const availSuiForDeep = Math.max(0, preBal2.suiBalance - GAS_RESERVE);
          const suiForDeepSwap  = Math.min(
            deepShortfall * price2,     // 不足分のSUI換算
            availSuiForDeep * 0.40      // 利用可能SUIの40%を上限
          );

          if (suiForDeepSwap > 0.05) {
            Logger.info(`[Bot2] DEEPが不足 (${deepShortfall.toFixed(2)} DEEP不足)。SUI ${suiForDeepSwap.toFixed(4)} → DEEP スワップ...`);
            const swapDeepRes = await this.bot2.swapManager.swapSuiToDeep(suiForDeepSwap);
            await this.tracker.recordEvent(
              '初期スワップ',
              `[Bot2] SUI ${suiForDeepSwap.toFixed(4)} を DEEP にスワップ。獲得: ${swapDeepRes.amountOut.toFixed(4)} DEEP`,
              price1, swapDeepRes.digest
            ).catch(() => {});
          }
        }

        // SUIはBot1のLP構築後に残った分を使用（ガス代確保後）
        const bot2FinalBal  = await this.bot1.lpManager.checkBalance();
        const bot2AvailSui  = Math.max(0, bot2FinalBal.suiBalance - GAS_RESERVE);
        const bot2SuiForLp  = Math.min(bot2AvailSui * 0.95, bot2SuiNeeded * 1.10);

        if (bot2SuiForLp > 0.1) {
          const bot2Lower = price2 * (1 - this.bot2.state.rangeWidth);
          const bot2Upper = price2 * (1 + this.bot2.state.rangeWidth);

          Logger.info(`[Bot2] DEEP/SUI LP構築 (レンジ: ${bot2Lower.toFixed(6)}-${bot2Upper.toFixed(6)}, SUI: ${bot2SuiForLp.toFixed(4)})...`);
          const lpRes2 = await this.bot2.lpManager.addLiquidity(bot2Lower, bot2Upper, bot2SuiForLp, false);
          await this.tracker.recordEvent(
            'LP提供',
            `[Bot2] DEEP-SUI LP構築完了。レンジ: ${bot2Lower.toFixed(6)}-${bot2Upper.toFixed(6)}`,
            price1, lpRes2.digest
          ).catch(() => {});

          const pos2 = lpRes2.positionId || await this.bot2.lpManager.getActivePositionId();
          if (pos2) {
            this.bot2.state.lpPositionId = pos2;
            this.bot2.state.basePrice   = price2;
            this.bot2.state.rangeLower  = bot2Lower;
            this.bot2.state.rangeUpper  = bot2Upper;
            this.bot2.state.phase       = 'B';
            this.bot2.currentPhase      = CyclePhase.B;
            Logger.success(`[Bot2] ✅ フェーズA完了。ポジション: ${pos2}`);
          } else {
            Logger.warn('[Bot2] ⚠️ ポジションIDの取得に失敗。次のサイクルで再試行します。');
          }
        } else {
          Logger.warn(`[Bot2] SUI残高不足のためBot2 LP構築をスキップ (利用可能: ${bot2SuiForLp.toFixed(4)} SUI)。SUIを入金後、再度ボットを起動してください。`);
        }

        Logger.success('[PHASE_A] ===== 両ボット統合フェーズA 完了 =====');
      }

    } catch (error: any) {
      Logger.error(`[PHASE_A] フェーズA実行中にエラー: ${error.message}`, error);
      // エラー時はフェーズAのままにして次サイクルで再試行
      if (this.bot1.state.phase !== 'B') this.bot1.state.phase = 'A';
      if (this.bot2.state.phase !== 'B') this.bot2.state.phase = 'A';
      throw error;
    } finally {
      this.isPhaseARunning = false;
    }
  }

  /**
   * フェーズ B: 各ボットの監視ループ
   */
  private async executePhaseB(bot: BotInstance, price: number) {
    bot.currentPhase = CyclePhase.B;

    if (this.isAnyBotRebuilding()) {
      Logger.warn(`[${bot.name}] 急騰対応の再構築中のため、フェーズB監視をスキップします。`);
      return;
    }
    
    if (this.config.strategyMode === 'range_order') {
      // 0. アクティブポジション数のチェックと自己修復（常にチェーン上で4ポジションを維持）
      const trackedPositionsCount = [
        bot.state.lpPositionIdBelow1,
        bot.state.lpPositionIdBelow2,
        bot.state.lpPositionIdAbove1,
        bot.state.lpPositionIdAbove2
      ].filter(Boolean).length;
      let livePositionsCount = 0;
      let totalActivePositionsCount = 0;
      try {
        const status = await this.getRangeOrderPositionStatus(bot);
        livePositionsCount = status.trackedLiveCount;
        totalActivePositionsCount = status.activeIds.length;
        if (status.extraIds.length > 0 || totalActivePositionsCount > 4) {
          Logger.error(`[${bot.name}] 余剰指値ポジションを検知しました (trackedLive=${livePositionsCount}/4, totalActive=${totalActivePositionsCount}/4, extra=${status.extraIds.join(', ') || 'unknown'})。新規作成を停止して両Botを再構築します。`);
          await this.rebuildAllRangeOrderPositionsForSurge(price, 0);
          return;
        }
      } catch (e: any) {
        Logger.warn(`[${bot.name}] チェーン上の指値ポジション確認に失敗しました。安全側として統合フェーズAで再確認します: ${e.message}`);
        this.markBothBotsForRangeOrderRebuild();
        return;
      }

      if (trackedPositionsCount === 0 || livePositionsCount === 0) {
        Logger.error(`[${bot.name}] アクティブな指値ポジションが0個になりました (state=${trackedPositionsCount}/4, live=${livePositionsCount}/4)。即座に両Botを再構築します。`);
        await this.rebuildAllRangeOrderPositionsForSurge(price, 0);
        return;
      }

      if (trackedPositionsCount < 4 || livePositionsCount < 4 || totalActivePositionsCount !== 4) {
        Logger.error(`[${bot.name}] 指値ポジション数の不一致を検知しました (state=${trackedPositionsCount}/4, trackedLive=${livePositionsCount}/4, totalActive=${totalActivePositionsCount}/4)。即座に両Botを再構築します。`);
        await this.rebuildAllRangeOrderPositionsForSurge(price, 0);
        return;
      }

      if (trackedPositionsCount === 4 && livePositionsCount === 4) {
        if (bot.state.missingPositionsStartAt) {
          Logger.info(`[${bot.name}] ポジション数が正常(4/4)に戻りました。欠落タイマーをリセットします。`);
          bot.state.missingPositionsStartAt = undefined;
        }
      }

      // 1. 個別ローリングの確認と実行
      const rolled = await this.checkAndRollPositions(bot, price);
      if (rolled) {
        // ローリングが発生した場合、一時的にポジション数が3になるのは正常なのでタイマーをリセットして次サイクルへ
        bot.state.missingPositionsStartAt = undefined;
        return;
      }

      // 2. 動的なはみ出し基準レンジ（生きているポジションに基づく）の計算
      let rangeLower = 0;
      if (bot.state.lpPositionIdBelow2 && bot.state.rangeLowerBelow2) {
        rangeLower = bot.state.rangeLowerBelow2;
      } else if (bot.state.lpPositionIdBelow1 && bot.state.rangeLowerBelow1) {
        rangeLower = bot.state.rangeLowerBelow1;
      } else {
        // すべてのBelowポジションが約定して存在しない状態。基準価格（basePrice）の 3% 下を下回ったらはみ出しと判定
        rangeLower = bot.state.basePrice * 0.97;
      }

      let rangeUpper = 0;
      if (bot.state.lpPositionIdAbove2 && bot.state.rangeUpperAbove2) {
        rangeUpper = bot.state.rangeUpperAbove2;
      } else if (bot.state.lpPositionIdAbove1 && bot.state.rangeUpperAbove1) {
        rangeUpper = bot.state.rangeUpperAbove1;
      } else {
        // すべてのAboveポジションが約定して存在しない状態。基準価格（basePrice）の 3% 上を上回ったらはみ出しと判定
        rangeUpper = bot.state.basePrice * 1.03;
      }

      Logger.info(`[${bot.name}] 監視中(指値)... 価格=$${price.toFixed(4)}, はみ出し監視レンジ=[$${rangeLower.toFixed(4)} - $${rangeUpper.toFixed(4)}], state=${trackedPositionsCount}/4, trackedLive=${livePositionsCount}/4, totalActive=${totalActivePositionsCount}/4`);

      // 3. レンジはみ出し監視 (はみ出したまま一定時間経過したら緊急リバランス)
      if (price < rangeLower || price > rangeUpper) {
        if (!bot.state.breachStartAt) {
          bot.state.breachStartAt = Date.now();
          Logger.warn(`[${bot.name}] レンジ外にはみ出しました。タイマーを開始します。価格: $${price.toFixed(6)}, 監視レンジ: $${rangeLower.toFixed(6)}-$${rangeUpper.toFixed(6)}`);
        } else {
          const duration = Date.now() - bot.state.breachStartAt;
          const limit = this.config.rangeOrderBreachDurationMs || 60000;
          Logger.warn(`[${bot.name}] レンジ外はみ出し継続中: ${(duration / 1000).toFixed(1)}秒 / ${(limit / 1000).toFixed(0)}秒`);
          if (duration >= limit) {
            const surge = this.calculateSurgeStepDrift(bot, price);
            Logger.error(`[${bot.name}] レンジ外はみ出しが設定時間以上継続したため、全ポジションクローズ後に4本ずつ再配置します。`);
            await this.rebuildAllRangeOrderPositionsForSurge(price, surge.steps);
            return;
          }
        }
      } else {
        if (bot.state.breachStartAt) {
          Logger.info(`[${bot.name}] 価格がレンジ内に戻りました。はみ出しタイマーをリセットします。`);
          bot.state.breachStartAt = undefined;
        }
      }

      // 手数料はポジションのローリングまたはクローズ時にまとめて回収する。
      // 監視ループから単独の回収TXは送らず、ガス代を抑える。
    } else {
      // 既存の1ポジション監視（balancedモード）
      Logger.info(`[${bot.name}] 監視中... 価格=$${price.toFixed(4)}, レンジ=[$${bot.state.rangeLower.toFixed(4)} - $${bot.state.rangeUpper.toFixed(4)}]`);

      // レンジ判定
      if (price < bot.state.rangeLower) {
        if (RebalanceEngine.isCooldown(bot.state.lastRebalanceAt, this.config.cooldownPeriodMs / 60000)) {
          Logger.info(`[${bot.name}] 下抜け検知、クールダウン中のため待機。`);
          return;
        }
        Logger.warn(`[${bot.name}] 下限下抜け検知 ($${price.toFixed(4)} < $${bot.state.rangeLower.toFixed(4)})。フェーズCへ移行。`);
        bot.state.phase = 'C';
        bot.currentPhase = CyclePhase.C;
        await this.executePhaseC(bot, price);
      } 
      else if (price > bot.state.rangeUpper) {
        if (RebalanceEngine.isCooldown(bot.state.lastRebalanceAt, this.config.cooldownPeriodMs / 60000)) {
          Logger.info(`[${bot.name}] 上抜け検知、クールダウン中のため待機。`);
          return;
        }
        Logger.warn(`[${bot.name}] 上限上抜け検知 ($${price.toFixed(4)} > $${bot.state.rangeUpper.toFixed(4)})。フェーズDへ移行。`);
        bot.state.phase = 'D';
        bot.currentPhase = CyclePhase.D;
        await this.executePhaseD(bot, price);
      }
      // レンジ内では監視のみ。手数料はポジションのクローズ時にまとめて回収する。
    }
  }

  private async checkAndRollPositions(bot: BotInstance, price: number): Promise<boolean> {
    if (this.isAnyBotRebuilding()) {
      return false;
    }
    if (this.isRolling[bot.name]) {
      return false;
    }
    const isBot1 = bot.name.includes('Bot1');
    const width = this.config.rangeOrderWidthPct || 0.01;
    const GAS_RESERVE = 0.5;
    const ROLL_COOLDOWN_MS = Math.max(this.config.cooldownPeriodMs || 0, 5 * 60 * 1000);

    const surge = this.calculateSurgeStepDrift(bot, price);
    const surgeStepThreshold = Math.max(3, this.config.surgeTriggerSteps || 3);
    if (Math.abs(surge.steps) >= surgeStepThreshold) {
      Logger.warn(`[${bot.name}] 急な価格変動を検出しましたが、Cetusポジションの即時全再配置は行わず、レンジ外継続タイマーで確認します。価格=$${price.toFixed(6)}, ずれ段数=${surge.steps}`);
    }

    // ─── 0. スライド方向ロック解除（中央エリアへの復帰判定） ───
    // 現在価格が Below1 の上限と Above1 の下限の間（中央の安全地帯）に戻った場合、
    // 逆方向へのスライド抑制を解除する。
    if (bot.state.lastSlideDirection) {
      const upperBelow1 = bot.state.rangeUpperBelow1 || 0;
      const lowerAbove1 = bot.state.rangeLowerAbove1 || Infinity;
      if (price > upperBelow1 && price < lowerAbove1) {
        Logger.info(`[${bot.name}] 価格が中央の安全エリアに戻りました（価格: $${price.toFixed(6)}, Below1上限: $${upperBelow1.toFixed(6)}, Above1下限: $${lowerAbove1.toFixed(6)}）。スライド方向ロックをリセットします。`);
        bot.state.lastSlideDirection = null;
        bot.stateManager.saveState(bot.state);
      }
    }

    // 外側レンジへ入った時点で、次の外側ポジションを先回りして配置する。
    let downRollTrigger = bot.state.rangeLowerBelow2 > 0 && bot.state.rangeUpperBelow2 > 0
      ? bot.state.rangeUpperBelow2
      : bot.state.rangeUpperBelow1 || 0;
    let upRollTrigger = bot.state.rangeLowerAbove2 > 0 && bot.state.rangeUpperAbove2 > 0
      ? bot.state.rangeLowerAbove2
      : bot.state.rangeLowerAbove1 || Infinity;

    // もし直前のスライドが「下落方向（down）」だった場合：
    // 現在価格は新 Above1 (旧 Below1) の中にいるはず。
    // 上昇スライド（逆方向）のトリガーをしきい値の上限（rangeUpperAbove1）に引き上げる。
    // これにより、完全に中央に戻る（または上抜ける）まで上昇スライドを抑制する。
    if (bot.state.lastSlideDirection === 'down') {
      upRollTrigger = bot.state.rangeUpperAbove1 || Infinity;
    }

    // もし直前のスライドが「上昇方向（up）」だった場合：
    // 現在価格は新 Below1 (旧 Above1) の中にいるはず。
    // 下落スライド（逆方向）のトリガーをしきい値の下限（rangeLowerBelow1）に引き下げる。
    // これにより、完全に中央に戻る（または下抜ける）まで下落スライドを抑制する。
    if (bot.state.lastSlideDirection === 'up') {
      downRollTrigger = bot.state.rangeLowerBelow1 || 0;
    }

    // ─── 1. Below2へ入った場合 → 下落方向の先回りローリング ───
    const rollCooldownRemaining = bot.state.lastSlideAt
      ? ROLL_COOLDOWN_MS - (Date.now() - bot.state.lastSlideAt)
      : 0;

    if (bot.state.lpPositionIdBelow2 && price <= downRollTrigger) {
      if (rollCooldownRemaining > 0) {
        Logger.warn(`[${bot.name}] 下方向ローリング条件ですが、連続売買防止のためあと${Math.ceil(rollCooldownRemaining / 1000)}秒待機します。`);
        return false;
      }
      Logger.warn(`[${bot.name}] 🔻 価格が外側Below2へ入りました。レンジ下抜け前に先回りローリングを実行します。`);
      Logger.warn(`[${bot.name}]    価格: $${price.toFixed(6)}, 発動価格: $${downRollTrigger.toFixed(6)}, 外側下限: $${bot.state.rangeLowerBelow2.toFixed(6)}`);
      this.isRolling[bot.name] = true;

      try {
        const beforeCloseBalance = await bot.lpManager.checkBalance();
        let beforeCloseDeepBalance = 0;
        if (!isBot1) {
          const deepCoinType = bot.lpManager.coinTypeA || '';
          const deepBalObj = await bot.lpManager.suiClient.getBalance({
            owner: bot.lpManager.getWalletAddress(),
            coinType: deepCoinType
          });
          beforeCloseDeepBalance = Number(deepBalObj.totalBalance) / 1e6;
        }

        // Step 1: 遠方ポジション Above2 をクローズして資金を回収
        const closePosId = bot.state.lpPositionIdAbove2;
        if (closePosId) {
          Logger.info(`[${bot.name}] Above2 (${closePosId}) をクローズします...`);
          await bot.lpManager.closePosition(closePosId);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }

        // スライド前の Below2 下限をキャプチャ（新 Below2 のレンジ計算に使用）
        const rangeLowerBelow2_prev = bot.state.rangeLowerBelow2;

        // Step 2: ポジション変数を下にスライド
        // Above2 ← Above1, Above1 ← Below1, Below1 ← Below2, Below2 = null（後で新規構築）
        bot.state.lpPositionIdAbove2   = bot.state.lpPositionIdAbove1;
        bot.state.rangeLowerAbove2     = bot.state.rangeLowerAbove1;
        bot.state.rangeUpperAbove2     = bot.state.rangeUpperAbove1;

        bot.state.lpPositionIdAbove1   = bot.state.lpPositionIdBelow1;
        bot.state.rangeLowerAbove1     = bot.state.rangeLowerBelow1;
        bot.state.rangeUpperAbove1     = bot.state.rangeUpperBelow1;

        bot.state.lpPositionIdBelow1   = bot.state.lpPositionIdBelow2;
        bot.state.rangeLowerBelow1     = bot.state.rangeLowerBelow2;
        bot.state.rangeUpperBelow1     = bot.state.rangeUpperBelow2;

        bot.state.lpPositionIdBelow2   = null;
        bot.state.rangeLowerBelow2     = 0;
        bot.state.rangeUpperBelow2     = 0;

        // Step 3: 回収したトークンをスワップ（新 Below2 の資金を準備）
        let rollFundingAmount = 0;
        if (isBot1) {
          // Bot1 (SUI-USDC): Above2クローズで得たSUI → USDC に換えてBelow2資金にする
          const closedSui = await this.waitForBalanceIncrease(
            `${bot.name} Above2`,
            beforeCloseBalance.suiBalance,
            async () => (await this.bot1.lpManager.checkBalance()).suiBalance
          );
          const balance1 = await this.bot1.lpManager.checkBalance();
          const suiToSwap = Math.min(closedSui, Math.max(0, balance1.suiBalance - GAS_RESERVE));
          if (suiToSwap > 0.05) {
            Logger.info(`[${bot.name}] SUI → USDC スワップ（今回クローズ分のみ）: ${suiToSwap.toFixed(4)} SUI`);
            const swapRes = await bot.swapManager.swapSuiToUsdc(suiToSwap);
            rollFundingAmount = swapRes.amountOut;
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        } else {
          // Bot2 (DEEP-SUI): Above2クローズで得たDEEP → SUI に換えてBelow2資金にする
          const deepCoinType = bot.lpManager.coinTypeA || '';
          const closedDeep = await this.waitForBalanceIncrease(
            `${bot.name} Above2`,
            beforeCloseDeepBalance,
            async () => {
              const deepBalObj = await bot.lpManager.suiClient.getBalance({
                owner: bot.lpManager.getWalletAddress(),
                coinType: deepCoinType
              });
              return Number(deepBalObj.totalBalance) / 1e6;
            }
          );
          if (closedDeep > 0.5) {
            Logger.info(`[${bot.name}] DEEP → SUI スワップ（今回クローズ分のみ）: ${closedDeep.toFixed(2)} DEEP`);
            const swapRes = await bot.swapManager.swapDeepToSui(closedDeep);
            rollFundingAmount = swapRes.amountOut;
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }

        // Step 4: 新しい Below2 を構築（旧 Below2 のさらに 1% 下）
        // 隣接する Below1 の端点価格と重複しないよう、0.05%（0.0005）のバッファ（隙間）を空けます
        const baseUpper = rangeLowerBelow2_prev > 0 ? rangeLowerBelow2_prev : price * (1 - width);
        const finalUpper = baseUpper * 0.9995;
        const newLower   = finalUpper * (1 - width);

        let amountToInvest = 0;
        let isCoinA = false;

        if (isBot1) {
          amountToInvest = rollFundingAmount * 0.98;
          isCoinA = true;
        } else {
          amountToInvest = rollFundingAmount * 0.98;
          isCoinA = false;
        }

        if (amountToInvest > 0.05) {
          Logger.info(`[${bot.name}] 新 Below2 構築: ${newLower.toFixed(6)} - ${finalUpper.toFixed(6)}, 投資量: ${amountToInvest.toFixed(4)}`);
          const lpRes = await this.addLiquidityWithRpcRetry(bot, newLower, finalUpper, amountToInvest, isCoinA);
          const activeIds   = await bot.lpManager.getActivePositionIds();
          const allocatedIds = [bot.state.lpPositionIdBelow1, bot.state.lpPositionIdBelow2,
                                bot.state.lpPositionIdAbove1, bot.state.lpPositionIdAbove2].filter(Boolean) as string[];
          const newPosId = lpRes.positionId || activeIds.find(id => !allocatedIds.includes(id));

          if (newPosId) {
            bot.state.lpPositionIdBelow2   = newPosId;
            bot.state.rangeLowerBelow2     = newLower;
            bot.state.rangeUpperBelow2     = finalUpper;
            bot.state.lastSlideDirection   = 'down'; // 方向ロックを設定
            bot.state.lastSlideAt          = Date.now();
            Logger.success(`[${bot.name}] ✅ 新 Below2 構築完了: ${newPosId} (${newLower.toFixed(6)}-${finalUpper.toFixed(6)})`);
            await this.tracker.recordEvent('指値ローリング（下落）',
              `Below2下限突破のためAbove2をクローズし、新Below2(${newLower.toFixed(6)}-${finalUpper.toFixed(6)})を構築。`,
              price, lpRes.digest).catch(() => {});
          } else {
            Logger.error(`[${bot.name}] ⚠️ 新 Below2 の構築（ID取得）に失敗しました。即座に統合フェーズAに移行して再構築します。`);
            this.bot1.state.phase = 'A';
            this.bot1.currentPhase = CyclePhase.A;
            this.bot2.state.phase = 'A';
            this.bot2.currentPhase = CyclePhase.A;
            this.bot1.state.lastSlideDirection = null;
            this.bot2.state.lastSlideDirection = null;
            this.bot1.stateManager.saveState(this.bot1.state);
            this.bot2.stateManager.saveState(this.bot2.state);
            return true;
          }
        } else {
          Logger.error(`[${bot.name}] ⚠️ 新 Below2 構築用資金 (${amountToInvest.toFixed(4)}) が不足しています。即座に統合フェーズAに移行して再構築します。`);
          this.bot1.state.phase = 'A';
          this.bot1.currentPhase = CyclePhase.A;
          this.bot2.state.phase = 'A';
          this.bot2.currentPhase = CyclePhase.A;
          this.bot1.state.lastSlideDirection = null;
          this.bot2.state.lastSlideDirection = null;
          this.bot1.stateManager.saveState(this.bot1.state);
          this.bot2.stateManager.saveState(this.bot2.state);
          return true;
        }
        bot.stateManager.saveState(bot.state);
        return true;
      } catch (e: any) {
        Logger.error(`[${bot.name}] 下落スライドローリング中にエラー: ${e.message}`, e);
        this.markBothBotsForRangeOrderRebuild();
        return true;
      } finally {
        this.isRolling[bot.name] = false;
      }
    }

    // ─── 2. Above2へ入った場合 → 上昇方向の先回りローリング ───
    if (bot.state.lpPositionIdAbove2 && price >= upRollTrigger) {
      if (rollCooldownRemaining > 0) {
        Logger.warn(`[${bot.name}] 上方向ローリング条件ですが、連続売買防止のためあと${Math.ceil(rollCooldownRemaining / 1000)}秒待機します。`);
        return false;
      }
      Logger.warn(`[${bot.name}] 🔺 価格が外側Above2へ入りました。レンジ上抜け前に先回りローリングを実行します。`);
      Logger.warn(`[${bot.name}]    価格: $${price.toFixed(6)}, 発動価格: $${upRollTrigger.toFixed(6)}, 外側上限: $${bot.state.rangeUpperAbove2.toFixed(6)}`);
      this.isRolling[bot.name] = true;

      try {
        const beforeCloseBalance = await bot.lpManager.checkBalance();

        // Step 1: 遠方ポジション Below2 をクローズして資金を回収
        const closePosId = bot.state.lpPositionIdBelow2;
        if (closePosId) {
          Logger.info(`[${bot.name}] Below2 (${closePosId}) をクローズします...`);
          await bot.lpManager.closePosition(closePosId);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }

        // スライド前の Above2 上限をキャプチャ（新 Above2 のレンジ計算に使用）
        const rangeUpperAbove2_prev = bot.state.rangeUpperAbove2;

        // Step 2: ポジション変数を上にスライド
        // Below2 ← Below1, Below1 ← Above1, Above1 ← Above2, Above2 = null（後で新規構築）
        bot.state.lpPositionIdBelow2   = bot.state.lpPositionIdBelow1;
        bot.state.rangeLowerBelow2     = bot.state.rangeLowerBelow1;
        bot.state.rangeUpperBelow2     = bot.state.rangeUpperBelow1;

        bot.state.lpPositionIdBelow1   = bot.state.lpPositionIdAbove1;
        bot.state.rangeLowerBelow1     = bot.state.rangeLowerAbove1;
        bot.state.rangeUpperBelow1     = bot.state.rangeUpperAbove1;

        bot.state.lpPositionIdAbove1   = bot.state.lpPositionIdAbove2;
        bot.state.rangeLowerAbove1     = bot.state.rangeLowerAbove2;
        bot.state.rangeUpperAbove1     = bot.state.rangeUpperAbove2;

        bot.state.lpPositionIdAbove2   = null;
        bot.state.rangeLowerAbove2     = 0;
        bot.state.rangeUpperAbove2     = 0;

        // Step 3: 回収したトークンをスワップ（新 Above2 の資金を準備）
        let rollFundingAmount = 0;
        if (isBot1) {
          // Bot1 (SUI-USDC): Below2クローズで得たUSDC → SUI に換えてAbove2資金にする
          const usdcToSwap = await this.waitForBalanceIncrease(
            `${bot.name} Below2`,
            beforeCloseBalance.usdcBalance,
            async () => (await this.bot1.lpManager.checkBalance()).usdcBalance
          );
          if (usdcToSwap > 0.1) {
            Logger.info(`[${bot.name}] USDC → SUI スワップ（今回クローズ分のみ）: $${usdcToSwap.toFixed(2)} USDC`);
            const swapRes = await bot.swapManager.swapUsdcToSui(usdcToSwap);
            rollFundingAmount = swapRes.amountOut;
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        } else {
          // Bot2 (DEEP-SUI): Below2クローズで得たSUI → DEEP に換えてAbove2資金にする
          const closedSui = await this.waitForBalanceIncrease(
            `${bot.name} Below2`,
            beforeCloseBalance.suiBalance,
            async () => (await bot.lpManager.checkBalance()).suiBalance
          );
          const balance2 = await bot.lpManager.checkBalance();
          const suiToSwap = Math.min(closedSui, Math.max(0, balance2.suiBalance - GAS_RESERVE));
          if (suiToSwap > 0.05) {
            Logger.info(`[${bot.name}] SUI → DEEP スワップ（今回クローズ分のみ）: ${suiToSwap.toFixed(4)} SUI`);
            const swapRes = await bot.swapManager.swapSuiToDeep(suiToSwap);
            rollFundingAmount = swapRes.amountOut;
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }

        // Step 4: 新しい Above2 を構築（旧 Above2 のさらに 1% 上）
        // 隣接する Above1 の端点価格と重複しないよう、0.05%（0.0005）のバッファ（隙間）を空けます
        const baseLower = rangeUpperAbove2_prev > 0 ? rangeUpperAbove2_prev : price * (1 + width);
        const finalLower = baseLower * 1.0005;
        const newUpper   = finalLower * (1 + width);

        let amountToInvest = 0;
        let isCoinA = false;

        if (isBot1) {
          amountToInvest = rollFundingAmount * 0.98;
          isCoinA = false;
        } else {
          amountToInvest = rollFundingAmount * 0.98;
          isCoinA = true;
        }

        if (amountToInvest > 0.05) {
          Logger.info(`[${bot.name}] 新 Above2 構築: ${finalLower.toFixed(6)} - ${newUpper.toFixed(6)}, 投資量: ${amountToInvest.toFixed(4)}`);
          const lpRes = await this.addLiquidityWithRpcRetry(bot, finalLower, newUpper, amountToInvest, isCoinA);
          const activeIds   = await bot.lpManager.getActivePositionIds();
          const allocatedIds = [bot.state.lpPositionIdBelow1, bot.state.lpPositionIdBelow2,
                                bot.state.lpPositionIdAbove1, bot.state.lpPositionIdAbove2].filter(Boolean) as string[];
          const newPosId = lpRes.positionId || activeIds.find(id => !allocatedIds.includes(id));

          if (newPosId) {
            bot.state.lpPositionIdAbove2   = newPosId;
            bot.state.rangeLowerAbove2     = finalLower;
            bot.state.rangeUpperAbove2     = newUpper;
            bot.state.lastSlideDirection   = 'up'; // 方向ロックを設定
            bot.state.lastSlideAt          = Date.now();
            Logger.success(`[${bot.name}] ✅ 新 Above2 構築完了: ${newPosId} (${finalLower.toFixed(6)}-${newUpper.toFixed(6)})`);
            await this.tracker.recordEvent('指値ローリング（上昇）',
              `Above2上限突破のためBelow2をクローズし、新Above2(${finalLower.toFixed(6)}-${newUpper.toFixed(6)})を構築。`,
              price, lpRes.digest).catch(() => {});
          } else {
            Logger.error(`[${bot.name}] ⚠️ 新 Above2 の構築（ID取得）に失敗しました。即座に統合フェーズAに移行して再構築します。`);
            this.bot1.state.phase = 'A';
            this.bot1.currentPhase = CyclePhase.A;
            this.bot2.state.phase = 'A';
            this.bot2.currentPhase = CyclePhase.A;
            this.bot1.state.lastSlideDirection = null;
            this.bot2.state.lastSlideDirection = null;
            this.bot1.stateManager.saveState(this.bot1.state);
            this.bot2.stateManager.saveState(this.bot2.state);
            return true;
          }
        } else {
          Logger.error(`[${bot.name}] ⚠️ 新 Above2 構築用資金 (${amountToInvest.toFixed(4)}) が不足しています。即座に統合フェーズAに移行して再構築します。`);
          this.bot1.state.phase = 'A';
          this.bot1.currentPhase = CyclePhase.A;
          this.bot2.state.phase = 'A';
          this.bot2.currentPhase = CyclePhase.A;
          this.bot1.state.lastSlideDirection = null;
          this.bot2.state.lastSlideDirection = null;
          this.bot1.stateManager.saveState(this.bot1.state);
          this.bot2.stateManager.saveState(this.bot2.state);
          return true;
        }
        bot.stateManager.saveState(bot.state);
        return true;
      } catch (e: any) {
        Logger.error(`[${bot.name}] 上昇スライドローリング中にエラー: ${e.message}`, e);
        this.markBothBotsForRangeOrderRebuild();
        return true;
      } finally {
        this.isRolling[bot.name] = false;
      }
    }

    return false;
  }

  /**
   * フェーズ C: 下抜けリバランス
   */
  private async executePhaseC(bot: BotInstance, price: number) {
    Logger.info(`[${bot.name}] 下抜けリバランス実行。`);
    bot.state.rangeWidth = RebalanceEngine.calculateNewRangeWidth(bot.state);

    // LP解除
    await bot.lpManager.forceCloseAllPositions();
    bot.state.lpPositionId = null;

    // 回収したトークンの半分をスワップしてLP再構成
    let lpRes;
    if (bot.name.includes('Bot1')) {
      const balance = await bot.lpManager.checkBalance();
      const swapAmount = balance.suiBalance * 0.50;
      if (swapAmount > 0.05) {
        const swapRes = await bot.swapManager.swapSuiToUsdc(swapAmount);
        await this.tracker.recordEvent(
          'リバランススワップ',
          `[Bot1] SUI ${swapAmount.toFixed(4)} を USDC にスワップしました。`,
          price,
          swapRes.digest
        ).catch(() => {});
      }
      const newBalances = await bot.lpManager.checkBalance();
      const lower = price * (1 - bot.state.rangeWidth);
      const upper = price * (1 + bot.state.rangeWidth);
      lpRes = await bot.lpManager.addLiquidity(lower, upper, newBalances.usdcBalance, true);

      await this.tracker.recordRebalance(
        price,
        0,
        0,
        lpRes.digest,
        `[Bot1] 下抜けリバランス: LP再構成完了。レンジ: $${lower.toFixed(4)} - $${upper.toFixed(4)}`,
        lower,
        upper,
        '下抜けリバランス'
      ).catch(() => {});
    } else {
      // DEEP/SUIプールでは解除後はほぼSUIに戻るため、SUIの半分（ガス代を除いた分）をDEEPにスワップして再作成
      const balance = await bot.lpManager.checkBalance();
      const usableSui = Math.max(0, balance.suiBalance - 0.10); // ガス代用に0.1 SUI確保
      const swapAmount = usableSui * 0.50;
      if (swapAmount > 0.05) {
        // SUI -> DEEP スワップ
        const swapRes = await bot.swapManager.swapSuiToDeep(swapAmount);
        await this.tracker.recordEvent(
          'リバランススワップ',
          `[Bot2] SUI ${swapAmount.toFixed(4)} を DEEP にスワップしました。`,
          price,
          swapRes.digest
        ).catch(() => {});
      }
      const lower = price * (1 - bot.state.rangeWidth);
      const upper = price * (1 + bot.state.rangeWidth);
      Logger.info(`[${bot.name}] Cetus DEEP/SUI LPを再構築します: レンジ $${lower.toFixed(4)} - $${upper.toFixed(4)}`);
      lpRes = await bot.lpManager.addLiquidity(lower, upper, swapAmount, false);

      await this.tracker.recordRebalance(
        price,
        0,
        0,
        lpRes.digest,
        `[Bot2] 下抜けリバランス: DEEP/SUI LP再構成完了。レンジ: $${lower.toFixed(4)} - $${upper.toFixed(4)}`,
        lower,
        upper,
        '下抜けリバランス'
      ).catch(() => {});
    }

    let positionId: string | null | undefined = lpRes?.positionId;
    if (!positionId) {
      positionId = await bot.lpManager.getActivePositionId();
    }
    if (!positionId) throw new Error("LPポジションIDの特定に失敗。");

    bot.state.lpPositionId = positionId;
    bot.state.basePrice = price;
    bot.state.rangeLower = price * (1 - bot.state.rangeWidth);
    bot.state.rangeUpper = price * (1 + bot.state.rangeWidth);
    bot.state.lastRebalanceAt = Date.now();
    bot.state.rebalanceHistory.push(Date.now());
    bot.state.phase = 'B';
    bot.currentPhase = CyclePhase.B;

    Logger.success(`[${bot.name}] ✅ 下抜けリバランス完了。`);
  }

  /**
   * フェーズ D: 上抜けリバランス
   */
  private async executePhaseD(bot: BotInstance, price: number) {
    Logger.info(`[${bot.name}] 上抜けリバランス実行。`);
    bot.state.rangeWidth = RebalanceEngine.calculateNewRangeWidth(bot.state);

    // LP解除
    await bot.lpManager.forceCloseAllPositions();
    bot.state.lpPositionId = null;

    // 回収したトークンの半分をスワップしてLP再構成
    let lpRes;
    if (bot.name.includes('Bot1')) {
      const balance = await bot.lpManager.checkBalance();
      const swapAmount = balance.usdcBalance * 0.50;
      if (swapAmount > 0.5) {
        const swapRes = await bot.swapManager.swapUsdcToSui(swapAmount);
        await this.tracker.recordEvent(
          'リバランススワップ',
          `[Bot1] USDC $${swapAmount.toFixed(2)} を SUI にスワップしました。`,
          price,
          swapRes.digest
        ).catch(() => {});
      }
      const newBalances = await bot.lpManager.checkBalance();
      const lower = price * (1 - bot.state.rangeWidth);
      const upper = price * (1 + bot.state.rangeWidth);
      lpRes = await bot.lpManager.addLiquidity(lower, upper, newBalances.usdcBalance, true);

      await this.tracker.recordRebalance(
        price,
        0,
        0,
        lpRes.digest,
        `[Bot1] 上抜けリバランス: LP再構成完了。レンジ: $${lower.toFixed(4)} - $${upper.toFixed(4)}`,
        lower,
        upper,
        '上抜けリバランス'
      ).catch(() => {});
    } else {
      // DEEP/SUI LP全解除後はほぼDEEPに戻るため、DEEPの半分をSUIに換えてLP再作成
      const deepCoinType = bot.lpManager.coinTypeA;
      const deepBalanceObj = await bot.lpManager.suiClient.getBalance({ 
        owner: bot.lpManager.getWalletAddress(), 
        coinType: deepCoinType 
      });
      const deepBalance = Number(deepBalanceObj.totalBalance) / 1e6; // DEEP decimals = 6
      const swapAmount = deepBalance * 0.50;
      
      let swapRes = { amountOut: 0, digest: '' };
      if (swapAmount > 0.5) {
        // DEEP -> SUI スワップ
        swapRes = await bot.swapManager.swapDeepToSui(swapAmount);
        await this.tracker.recordEvent(
          'リバランススワップ',
          `[Bot2] DEEP ${swapAmount.toFixed(2)} を SUI にスワップしました。`,
          price,
          swapRes.digest
        ).catch(() => {});
      }
      
      const lower = price * (1 - bot.state.rangeWidth);
      const upper = price * (1 + bot.state.rangeWidth);
      Logger.info(`[${bot.name}] Cetus DEEP/SUI LPを再構築します: レンジ $${lower.toFixed(4)} - $${upper.toFixed(4)}`);
      // スワップで獲得したSUI量をベースに流動性追加
      lpRes = await bot.lpManager.addLiquidity(lower, upper, swapRes.amountOut || (swapAmount * price), false);

      await this.tracker.recordRebalance(
        price,
        0,
        0,
        lpRes.digest,
        `[Bot2] 上抜けリバランス: DEEP/SUI LP再構成完了。レンジ: $${lower.toFixed(4)} - $${upper.toFixed(4)}`,
        lower,
        upper,
        '上抜けリバランス'
      ).catch(() => {});
    }

    let positionId: string | null | undefined = lpRes?.positionId;
    if (!positionId) {
      positionId = await bot.lpManager.getActivePositionId();
    }
    if (!positionId) throw new Error("LPポジションIDの特定に失敗。");

    bot.state.lpPositionId = positionId;
    bot.state.basePrice = price;
    bot.state.rangeLower = price * (1 - bot.state.rangeWidth);
    bot.state.rangeUpper = price * (1 + bot.state.rangeWidth);
    bot.state.lastRebalanceAt = Date.now();
    bot.state.rebalanceHistory.push(Date.now());
    bot.state.phase = 'B';
    bot.currentPhase = CyclePhase.B;

    Logger.success(`[${bot.name}] ✅ 上抜けリバランス完了。`);
  }

  /**
   * 統合デルタヘッジの実行・調整およびON/OFF制御
   */
  private async maintainHedge(suiPrice: number) {
    if (this.isAnyBotRebuilding()) {
      Logger.warn('[HEDGE] 急騰対応の再構築中のため、ヘッジ計算をスキップします。');
      return;
    }

    const isHedgeEnabled = this.config.hedgeEnabled !== false;

    if (!isHedgeEnabled) {
      // ── ヘッジがOFFに切り替えられた場合 ──
      // Bluefinのヘッジポジションが存在すればクローズし、処理を終了する（LPは維持）
      const hedgeStatus = this.hedgeManager.getStatus(suiPrice);
      if (hedgeStatus.active) {
        Logger.info("[HEDGE] ヘッジ設定がOFFに切り替えられました。Bluefinのヘッジポジションをすべてクローズします。");
        await this.hedgeManager.closeHedge(suiPrice, this.sessionId).catch(e => {
          Logger.error("ヘッジポジションのクローズに失敗しました", e);
        });
        await this.tracker.recordHedge('CLOSE', 'ヘッジ設定がOFFになったためクローズしました。', suiPrice, 0).catch(() => {});
      }
      return;
    }

    // ── ヘッジがONの場合 ──
    // Bot1 と Bot2 の LP 内の合計 SUI 数量を算出する
    let totalSui = 0;
    if (this.config.strategyMode === 'range_order') {
      const p1 = this.bot1.state;
      const p2 = this.bot2.state;
      const posIds1 = [p1.lpPositionIdBelow1, p1.lpPositionIdBelow2, p1.lpPositionIdAbove1, p1.lpPositionIdAbove2].filter(Boolean) as string[];
      const posIds2 = [p2.lpPositionIdBelow1, p2.lpPositionIdBelow2, p2.lpPositionIdAbove1, p2.lpPositionIdAbove2].filter(Boolean) as string[];

      for (const id of posIds1) {
        totalSui += await this.bot1.lpManager.getSuiAmountInLp(id).catch(() => 0);
      }
      for (const id of posIds2) {
        totalSui += await this.bot2.lpManager.getSuiAmountInLp(id).catch(() => 0);
      }
    } else {
      const suiInLp1 = await this.bot1.lpManager.getSuiAmountInLp();
      const suiInLp2 = await this.bot2.lpManager.getSuiAmountInLp();
      totalSui = suiInLp1 + suiInLp2;
    }

    if (totalSui > 0) {
      // 合計SUI量の50%をヘッジ目標額 (USD) とする
      const targetHedgeUsd = totalSui * suiPrice * 0.50;
      
      // Bluefin のポジションが存在しない場合は新規オープン、存在する場合は差分調整
      const hedgeStatus = this.hedgeManager.getStatus(suiPrice);
      if (!hedgeStatus.active) {
        // 仕様書準拠: LPとヘッジは常に反対方向。SUI下落/上昇の相殺のため通常はショートから開始
        // (フェーズに応じてロング/ショートを適切に判定)
        const direction = this.bot1.state.bluefinSide === 'long' || this.bot2.state.bluefinSide === 'long' ? 'LONG' : 'SHORT';
        Logger.info(`[HEDGE] 統合ヘッジを開始します。合計SUI量: ${totalSui.toFixed(4)} SUI, 目標: $${targetHedgeUsd.toFixed(2)} USDC (${direction})`);
        const res = await this.hedgeManager.openHedge(targetHedgeUsd, suiPrice, direction, this.sessionId);
        this.bot1.state.bluefinOrderId = res.digest;
        this.bot1.state.bluefinSide = direction.toLowerCase() as any;
        await this.tracker.recordHedge('OPEN', `ヘッジを新規にオープンしました。目標: $${targetHedgeUsd.toFixed(2)}`, suiPrice, totalSui * 0.5, res.digest).catch(() => {});
      } else {
        // 差分が 10% 以上あればポジションサイズを動的微調整（adjustPosition）
        const adjustRes = await this.hedgeManager.adjustPosition(targetHedgeUsd, suiPrice, this.sessionId);
        if (adjustRes && adjustRes.digest) {
          await this.tracker.recordHedge('ADJUST', `ヘッジポジションサイズを調整しました。目標: $${targetHedgeUsd.toFixed(2)}`, suiPrice, totalSui * 0.5, adjustRes.digest).catch(() => {});
        }
      }
    }
  }

  /**
   * 緊急停止処理
   */
  private async emergencyStop(reason: string) {
    this.isRunning = false;
    this.isEmergencyStopped = true;
    this.currentPhase = CyclePhase.EMERGENCY;
    Logger.error(`🚨 [EMERGENCY_STOP] 両ボットを緊急停止します。理由: ${reason}`);

    try {
      const price1 = await this.bot1.priceMonitor.getCurrentPrice();
      // 1. ヘッジポジションを全決済
      await this.hedgeManager.closeHedge(price1, this.sessionId).catch(e => {
        Logger.error("緊急クローズ: ヘッジポジション決済失敗", e);
      });

      // 2. 両方の Cetus LP を全解除
      await this.bot1.lpManager.forceCloseAllPositions().catch(e => {
        Logger.error("緊急クローズ: Bot1 LP解除失敗", e);
      });
      await this.bot2.lpManager.forceCloseAllPositions().catch(e => {
        Logger.error("緊急クローズ: Bot2 LP解除失敗", e);
      });

      // 3. 状態をクリアして保存
      this.bot1.state.lpPositionId = null;
      this.bot1.state.lpPositionIdBelow = null;
      this.bot1.state.lpPositionIdAbove = null;
      this.bot1.state.lpPositionIdBelow1 = null;
      this.bot1.state.lpPositionIdBelow2 = null;
      this.bot1.state.lpPositionIdAbove1 = null;
      this.bot1.state.lpPositionIdAbove2 = null;
      this.bot1.state.lastSlideDirection = null;
      this.bot1.state.bluefinOrderId = null;
      this.bot1.state.bluefinSide = 'none';
      this.bot1.state.phase = 'A';
      this.bot1.stateManager.saveState(this.bot1.state);

      this.bot2.state.lpPositionId = null;
      this.bot2.state.lpPositionIdBelow = null;
      this.bot2.state.lpPositionIdAbove = null;
      this.bot2.state.lpPositionIdBelow1 = null;
      this.bot2.state.lpPositionIdBelow2 = null;
      this.bot2.state.lpPositionIdAbove1 = null;
      this.bot2.state.lpPositionIdAbove2 = null;
      this.bot2.state.lastSlideDirection = null;
      this.bot2.state.bluefinOrderId = null;
      this.bot2.state.bluefinSide = 'none';
      this.bot2.state.phase = 'A';
      this.bot2.stateManager.saveState(this.bot2.state);

      if (this.saveStateCallback) {
        this.saveStateCallback();
      }
      Logger.success("🚨 [EMERGENCY_STOP] 両ポジション全決済完了。安全停止状態です。");
    } catch (e: any) {
      Logger.error(`緊急停止処理中にエラーが発生しました: ${e.message}`);
    }
  }

  public serialize() {
    return {
      isRunning: this.isRunning,
      currentPhase: this.currentPhase,
      isEmergencyStopped: this.isEmergencyStopped,
      bot1State: this.bot1.state,
      bot2State: this.bot2.state
    };
  }

  public restore(state: any) {
    if (state) {
      this.isRunning = state.isRunning || false;
      this.currentPhase = state.currentPhase || CyclePhase.IDLE;
      this.isEmergencyStopped = state.isEmergencyStopped || false;
      if (state.bot1State) this.bot1.state = state.bot1State;
      if (state.bot2State) this.bot2.state = state.bot2State;
      this.bot1.state.isRebuilding = false;
      this.bot2.state.isRebuilding = false;
    }
  }

  public async getPnlData(currentPrice: number, userWalletAddress?: string) {
    if (this.pnlDataInFlight && this.pnlDataInFlightWallet === userWalletAddress) {
      return this.pnlDataInFlight;
    }

    this.pnlDataInFlightWallet = userWalletAddress;
    this.pnlDataInFlight = this.calculatePnlData(currentPrice, userWalletAddress);
    try {
      return await this.pnlDataInFlight;
    } finally {
      this.pnlDataInFlight = null;
      this.pnlDataInFlightWallet = undefined;
    }
  }

  private async calculatePnlData(currentPrice: number, userWalletAddress?: string) {
    const now = Date.now();
    // LP 8本の詳細取得はRPC負荷が高いため、Cetus監視間隔に合わせて再利用する。
    if (this.lastPnlData && (now - this.lastPnlDataTime < 5 * 60 * 1000) && (this.lastPnlData.userWalletAddress === userWalletAddress)) {
      return this.lastPnlData.data;
    }

    if (!this.isRunning) {
      if (this.lastPnlData && this.lastPnlData.userWalletAddress === userWalletAddress) {
        return { ...this.lastPnlData.data, isStopped: true };
      }
      const hedgeStatus = this.hedgeManager.getStatus(currentPrice);
      return {
        isStopped: true,
        pnl: {
          netPnl: 0,
          dailyPnl: 0,
          lpPnl: 0,
          hedgePnl: hedgeStatus.cumulativePnl + hedgeStatus.currentPnl,
          feesCollected: 0,
          gasSpent: this.gasTracker.getStats().totalGasUsdc || 0,
          botWalletBalanceSui: 0,
          botWalletBalanceUsdc: 0,
          botWalletSufficient: false,
          bot1LpValue: 0,
          bot2LpValue: 0,
          userWalletBalanceSui: 0,
          userWalletBalanceUsdc: 0,
          userWalletSufficient: false,
        },
        delta: {
          hedgeActive: hedgeStatus.active,
          hedgeSize: hedgeStatus.size,
          direction: hedgeStatus.direction,
          lpSuiAmount: 0,
        },
        hedge: hedgeStatus,
        dailySnapshots: []
      };
    }

    if (this.isAnyBotRebuilding()) {
      Logger.warn('[PNL] 急騰対応の再構築中のため、LP詳細取得をスキップして直近キャッシュまたは暫定値を返します。');
      if (this.lastPnlData && this.lastPnlData.userWalletAddress === userWalletAddress) {
        return { ...this.lastPnlData.data, isRebuilding: true };
      }

      const hedgeStatus = this.hedgeManager.getStatus(currentPrice);
      const balance = await this.bot1.lpManager.checkBalance().catch(() => ({
        suiBalance: 0,
        usdcBalance: 0,
        sufficient: false,
        coinABalance: 0,
        coinBBalance: 0,
      }));
      return {
        isRebuilding: true,
        pnl: {
          netPnl: 0,
          dailyPnl: 0,
          lpPnl: 0,
          hedgePnl: hedgeStatus.cumulativePnl + hedgeStatus.currentPnl,
          feesCollected: 0,
          gasSpent: this.gasTracker.getStats().totalGasUsdc || 0,
          botWalletBalanceSui: balance.suiBalance,
          botWalletBalanceUsdc: balance.usdcBalance,
          botWalletSufficient: balance.sufficient,
          bot1LpValue: 0,
          bot2LpValue: 0,
          userWalletBalanceSui: 0,
          userWalletBalanceUsdc: 0,
          userWalletSufficient: false,
        },
        delta: {
          hedgeActive: hedgeStatus.active,
          hedgeSize: hedgeStatus.size,
          direction: hedgeStatus.direction,
          lpSuiAmount: 0,
        },
        hedge: hedgeStatus,
        dailySnapshots: []
      };
    }

    const stats = this.tracker.getStats();
    const hedgeStatus = this.hedgeManager.getStatus(currentPrice);
    
    const totalFeesNum = parseFloat(stats.totalFees) || 0;
    const gasSpentNum = this.gasTracker.getStats().totalGasUsdc || 0;
    
    let lpValue1 = 0;
    let lpValue2 = 0;
    let totalSuiInLp = 0;

    // DEEP/SUIプールの資産価値を正しくドル換算するための価格定義
    const priceSuiUsdc = currentPrice;
    const priceDeepSui = await this.bot2.priceMonitor.getCurrentPrice().catch(() => 0);
    const priceDeepUsdc = priceDeepSui * priceSuiUsdc;

    if (this.config.strategyMode === 'range_order') {
      const p1 = this.bot1.state;
      const p2 = this.bot2.state;
      const posIds1 = [
        p1.lpPositionIdBelow1,
        p1.lpPositionIdBelow2,
        p1.lpPositionIdAbove1,
        p1.lpPositionIdAbove2
      ].filter(Boolean) as string[];

      const posIds2 = [
        p2.lpPositionIdBelow1,
        p2.lpPositionIdBelow2,
        p2.lpPositionIdAbove1,
        p2.lpPositionIdAbove2
      ].filter(Boolean) as string[];

      for (const id of posIds1) {
        const details = await this.bot1.lpManager.getPositionDetails(id).catch(() => null);
        lpValue1 += details?.usdValue || 0;
        totalSuiInLp += await this.bot1.lpManager.getSuiAmountInLp(id).catch(() => 0);
      }
      for (const id of posIds2) {
        const details = await this.bot2.lpManager.getPositionDetails(id).catch(() => null);
        if (details) {
          // details.usdValue (DEEPベースの生値) ではなく、ドルに正しく換算する
          const val = (details.amountA * priceDeepUsdc) + (details.amountB * priceSuiUsdc);
          lpValue2 += val;
        }
        totalSuiInLp += await this.bot2.lpManager.getSuiAmountInLp(id).catch(() => 0);
      }
    } else {
      const suiInLp1 = await this.bot1.lpManager.getSuiAmountInLp().catch(() => 0);
      const suiInLp2 = await this.bot2.lpManager.getSuiAmountInLp().catch(() => 0);
      totalSuiInLp = suiInLp1 + suiInLp2;

      const lpDetails1 = this.bot1.state.lpPositionId 
        ? await this.bot1.lpManager.getPositionDetails(this.bot1.state.lpPositionId).catch(() => null)
        : null;
      const lpDetails2 = this.bot2.state.lpPositionId
        ? await this.bot2.lpManager.getPositionDetails(this.bot2.state.lpPositionId).catch(() => null)
        : null;

      lpValue1 = lpDetails1?.usdValue || 0;
      if (lpDetails2) {
        lpValue2 = (lpDetails2.amountA * priceDeepUsdc) + (lpDetails2.amountB * priceSuiUsdc);
      } else {
        lpValue2 = 0;
      }
    }

    const balance = await this.bot1.lpManager.checkBalance();

    // 動的な純利益 (Net P&L) の計算
    const botSuiUsdValue = balance.suiBalance * priceSuiUsdc;
    const currentTotalCapital = lpValue1 + lpValue2 + (hedgeStatus?.marginBalance || 0) + balance.usdcBalance + botSuiUsdValue;
    const initialCapital = this.config.totalOperationalCapitalUsdc || 200;
    const actualNetPnl = currentTotalCapital - initialCapital;

    // トラッカーを最新の計算値で更新（非同期）
    this.tracker.update(currentPrice, actualNetPnl).catch((e) => Logger.error('Failed to update tracker PnL', e));

    const totalPnlNum = actualNetPnl;

    let userBalance = { suiBalance: 0, usdcBalance: 0, sufficient: false };
    if (userWalletAddress) {
      if (userWalletAddress.toLowerCase() === this.bot1.lpManager.getWalletAddress().toLowerCase()) {
        userBalance = {
          suiBalance: balance.suiBalance,
          usdcBalance: balance.usdcBalance,
          sufficient: balance.sufficient
        };
      } else {
        userBalance = await this.bot1.lpManager.checkBalance(userWalletAddress);
      }
    }

    const result = {
      pnl: {
        netPnl: totalPnlNum,
        dailyPnl: totalPnlNum,
        lpPnl: totalPnlNum - (hedgeStatus.cumulativePnl + hedgeStatus.currentPnl),
        hedgePnl: hedgeStatus.cumulativePnl + hedgeStatus.currentPnl,
        feesCollected: totalFeesNum,
        gasSpent: gasSpentNum,
        botWalletBalanceSui: balance.suiBalance,
        botWalletBalanceUsdc: balance.usdcBalance,
        botWalletSufficient: balance.sufficient,
        bot1LpValue: lpValue1,
        bot2LpValue: lpValue2,
        userWalletBalanceSui: userBalance.suiBalance,
        userWalletBalanceUsdc: userBalance.usdcBalance,
        userWalletSufficient: userBalance.sufficient,
      },
      delta: {
        hedgeActive: hedgeStatus.active,
        hedgeSize: hedgeStatus.size,
        direction: hedgeStatus.direction,
        lpSuiAmount: totalSuiInLp,
      },
      hedge: hedgeStatus,
      dailySnapshots: []
    };

    this.lastPnlData = {
      userWalletAddress,
      data: result
    };
    this.lastPnlDataTime = now;

    return result;
  }

  public calculateVolatility() {
    return 0;
  }

  public detectTrend() {
    return 'RANGE';
  }

  public async runRebalance(currentPrice: number, force: boolean = false) {
    if (force) {
      this.bot1.state.isRebuilding = true;
      this.bot2.state.isRebuilding = true;
      this.isRolling[this.bot1.name] = true;
      this.isRolling[this.bot2.name] = true;
      this.bot1.stateManager.saveState(this.bot1.state);
      this.bot2.stateManager.saveState(this.bot2.state);

      try {
        // 強制リバランス: フェーズCではなく統合フェーズA（全資金再配分）を実行
        Logger.info('[STRATEGY] 手動リバランス: 両ボットの全資金を再配分します（統合フェーズA）');
        const price2 = await this.bot2.priceMonitor.getCurrentPrice();

        // ポジションIDをクリアして強制再構築を促す
        this.resetRangeOrderState(this.bot1);
        this.resetRangeOrderState(this.bot2);
        this.bot1.stateManager.saveState(this.bot1.state);
        this.bot2.stateManager.saveState(this.bot2.state);
        await this.executeCombinedPhaseA(currentPrice, price2);
        if (this.config.strategyMode === 'range_order') {
          const bot1Valid = await this.validateRangeOrderStateOnChain(this.bot1);
          const bot2Valid = await this.validateRangeOrderStateOnChain(this.bot2);
          if (!bot1Valid || !bot2Valid) {
            throw new Error('8ポジション再配置後のチェーン確認に失敗しました。ログで未作成ポジションを確認してください。');
          }
        }
      } finally {
        this.bot1.state.isRebuilding = false;
        this.bot2.state.isRebuilding = false;
        this.isRolling[this.bot1.name] = false;
        this.isRolling[this.bot2.name] = false;
        this.bot1.stateManager.saveState(this.bot1.state);
        this.bot2.stateManager.saveState(this.bot2.state);
      }
      return;
    }
    // 通常リバランス（レンジ外の場合のみ）
    if (this.bot1.state.phase === 'B') {
      Logger.info('[STRATEGY] Bot1 リバランスを実行します');
      this.bot1.state.phase = 'C';
      await this.executePhaseC(this.bot1, currentPrice);
    }
    if (this.bot2.state.phase === 'B') {
      Logger.info('[STRATEGY] Bot2 リバランスを実行します');
      this.bot2.state.phase = 'C';
      const price2 = await this.bot2.priceMonitor.getCurrentPrice();
      await this.executePhaseC(this.bot2, price2);
    }
  }
}
