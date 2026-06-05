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

export class Strategy {
  public isRunning: boolean = false;
  public currentPhase: CyclePhase = CyclePhase.IDLE;
  public isEmergencyStopped: boolean = false;
  private keypair?: Ed25519Keypair;
  
  private bot1!: BotInstance;
  private bot2!: BotInstance;
  private riskGuard: RiskGuard;
  private timer: NodeJS.Timeout | null = null;
  private isPhaseARunning: boolean = false; // 統合フェーズAの二重起動防止フラグ

  // PnL データのキャッシュ機構（429 Too Many Requestsの防止）
  private lastPnlData: any = null;
  private lastPnlDataTime: number = 0;
  
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
      rebalanceHistory: []
    };

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
      rebalanceHistory: []
    };

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
    await this.hedgeManager.setupBluefin(this.keypair, rpcUrl, network as any);
  }

  public refreshConfig(newConfig: BotConfig) {
    this.config = newConfig;
    this.bot1.lpManager.refreshConfig(newConfig);
    this.bot1.swapManager.refreshConfig(newConfig);
    
    const bot2Config: BotConfig = { ...newConfig, poolObjectId: BOT2_CONFIG.poolObjectId };
    this.bot2.priceMonitor.refreshConfig(bot2Config);
    this.bot2.lpManager.refreshConfig(bot2Config);
    this.bot2.swapManager.refreshConfig(bot2Config);
  }

  public async start() {
    // 起動する際は緊急停止状態を自動で解除（リセット）
    this.isEmergencyStopped = false;

    if (this.isRunning) return;
    this.isRunning = true;
    Logger.info("Sui Dual Delta-Neutral LP Bot (SUI/USDC & DEEP/SUI) を起動します...");
    
    if (this.keypair) {
      await this.hedgeManager.syncPositionWithBluefin().catch(() => {});
    }

    await this.cycle();

    this.timer = setInterval(async () => {
      await this.cycle();
    }, 30000);
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

  /**
   * メインサイクル
   */
  private async cycle() {
    if (!this.isRunning) return;
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

      // ── Bot1 / Bot2 サイクル ──
      // どちらかがフェーズAにいる場合、全資金をバランス配分して両ボットを同時セットアップ
      if (this.bot1.state.phase === 'A' || this.bot2.state.phase === 'A') {
        await this.executeCombinedPhaseA(price1, price2);
      } else {
        await this.runSingleBotCycle(this.bot1, price1, balance.usdcBalance);
        await this.runSingleBotCycle(this.bot2, price2, balance.usdcBalance);
      }

      // ── 統合ヘッジ管理 ──
      await this.maintainHedge(price1);

      // 状態の保存
      this.bot1.stateManager.saveState(this.bot1.state);
      this.bot2.stateManager.saveState(this.bot2.state);
      
      this.currentPhase = this.bot1.currentPhase; // UI用

      if (this.saveStateCallback) {
        this.saveStateCallback();
      }

    } catch (e: any) {
      Logger.error(`[CYCLE_ERROR] ${e.message}`, e);
      this.riskGuard.recordError();
      this.tracker.recordEvent('システムエラー', `サイクル実行エラー: ${e.message}`, this.bot1.state.basePrice).catch(() => {});
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
        const hasBot1Positions = !!(
          this.bot1.state.lpPositionIdBelow1 &&
          this.bot1.state.lpPositionIdBelow2 &&
          this.bot1.state.lpPositionIdAbove1 &&
          this.bot1.state.lpPositionIdAbove2
        );
        const hasBot2Positions = !!(
          this.bot2.state.lpPositionIdBelow1 &&
          this.bot2.state.lpPositionIdBelow2 &&
          this.bot2.state.lpPositionIdAbove1 &&
          this.bot2.state.lpPositionIdAbove2
        );

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
        await this.bot1.lpManager.forceCloseAllPositions().catch(e => Logger.warn(`[PHASE_A] Bot1 forceCloseエラー: ${e.message}`));
        this.bot1.state.lpPositionId = null;
        this.bot1.state.lpPositionIdBelow = null;
        this.bot1.state.lpPositionIdAbove = null;
        this.bot1.state.lpPositionIdBelow1 = null;
        this.bot1.state.lpPositionIdBelow2 = null;
        this.bot1.state.lpPositionIdAbove1 = null;
        this.bot1.state.lpPositionIdAbove2 = null;

        this.bot2.currentPhase = CyclePhase.A;
        await this.bot2.lpManager.forceCloseAllPositions().catch(e => Logger.warn(`[PHASE_A] Bot2 forceCloseエラー: ${e.message}`));
        this.bot2.state.lpPositionId = null;
        this.bot2.state.lpPositionIdBelow = null;
        this.bot2.state.lpPositionIdAbove = null;
        this.bot2.state.lpPositionIdBelow1 = null;
        this.bot2.state.lpPositionIdBelow2 = null;
        this.bot2.state.lpPositionIdAbove1 = null;
        this.bot2.state.lpPositionIdAbove2 = null;

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
        const bot1SuiNeeded  = (bot1AllocUsdc * 0.25) / price1;

        const bot2SuiNeeded  = (bot2AllocUsdc * 0.25) / price1;
        const bot2DeepNeeded = (bot2AllocUsdc * 0.25) / (price2 * price1);

        Logger.info(`[PHASE_A] 目標(各25% x4): Bot1 USDC=$${(bot1UsdcNeeded*4).toFixed(2)} | Bot2 DEEP=${(bot2DeepNeeded*4).toFixed(2)}`);

        // 1. DEEP残高の調整 (目標の 50% = 2倍が必要)
        const totalDeepNeeded = bot2DeepNeeded * 2.0;
        if (deepBalance > totalDeepNeeded + 1.0) {
          const deepToSell = deepBalance - totalDeepNeeded;
          Logger.info(`[PHASE_A] 余剰DEEPを売却します: ${deepToSell.toFixed(2)} DEEP -> SUI`);
          await this.bot2.swapManager.swapDeepToSui(deepToSell);
        } else if (deepBalance < totalDeepNeeded - 1.0) {
          const deepToBuy = totalDeepNeeded - deepBalance;
          const preBal = await this.bot1.lpManager.checkBalance();
          const suiToSwap = Math.min(deepToBuy * price2, Math.max(0, preBal.suiBalance - 1.0));
          if (suiToSwap > 0.05) {
            Logger.info(`[PHASE_A] 不足DEEPを補うため SUIをスワップします: ${suiToSwap.toFixed(4)} SUI -> DEEP`);
            await this.bot2.swapManager.swapSuiToDeep(suiToSwap);
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
          }
        } else if (currentBal.usdcBalance < totalUsdcNeeded - 0.1) {
          const usdcToBuy = totalUsdcNeeded - currentBal.usdcBalance;
          const suiToSell = Math.min(usdcToBuy / price1, Math.max(0, currentBal.suiBalance - 1.0));
          if (suiToSell > 0.05) {
            Logger.info(`[PHASE_A] 不足USDCを補うため SUIを売却します: ${suiToSell.toFixed(4)} SUI -> USDC`);
            await this.bot1.swapManager.swapSuiToUsdc(suiToSell);
          }
        }

        // 最新の残高でLPを構築
        const finalBal = await this.bot1.lpManager.checkBalance();
        const finalDeepObj = await this.bot1.lpManager.suiClient.getBalance({
          owner: this.bot1.lpManager.getWalletAddress(),
          coinType: deepCoinType || ''
        });
        const finalDeep = Number(finalDeepObj.totalBalance) / 1e6;

        const allocatedIds1: string[] = [];

        // ══ Bot1: 現在価格中心に1%幅4ポジション隣接配置 ══
        // Below1: [price*0.99, price]         ← 現在価格すぐ下の買い指値
        // Below2: [price*0.98, price*0.99]    ← さらに1%下の買い指値
        // Above1: [price, price*1.01]         ← 現在価格すぐ上の売り指値
        // Above2: [price*1.01, price*1.02]    ← さらに1%上の売り指値
        const bot1LowerBelow1 = price1 * (1 - width);
        const bot1UpperBelow1 = price1;
        const bot1LowerBelow2 = price1 * (1 - 2 * width);
        const bot1UpperBelow2 = price1 * (1 - width);
        const bot1LowerAbove1 = price1;
        const bot1UpperAbove1 = price1 * (1 + width);
        const bot1LowerAbove2 = price1 * (1 + width);
        const bot1UpperAbove2 = price1 * (1 + 2 * width);

        Logger.info(`[Bot1] レンジ構成:`);
        Logger.info(`  Below2: $${bot1LowerBelow2.toFixed(4)} - $${bot1UpperBelow2.toFixed(4)}`);
        Logger.info(`  Below1: $${bot1LowerBelow1.toFixed(4)} - $${bot1UpperBelow1.toFixed(4)}`);
        Logger.info(`  現在価格: $${price1.toFixed(4)}`);
        Logger.info(`  Above1: $${bot1LowerAbove1.toFixed(4)} - $${bot1UpperAbove1.toFixed(4)}`);
        Logger.info(`  Above2: $${bot1LowerAbove2.toFixed(4)} - $${bot1UpperAbove2.toFixed(4)}`);

        // ── Bot1 Below1: USDC 50%を投入（買い指値）──
        const bot1LpUsdc1 = Math.min(finalBal.usdcBalance * 0.50, bot1UsdcNeeded * 1.02);
        Logger.info(`[Bot1] Below1 LP構築 (レンジ: $${bot1LowerBelow1.toFixed(4)}-$${bot1UpperBelow1.toFixed(4)}, USDC: $${bot1LpUsdc1.toFixed(2)})...`);
        const lpRes1Below1 = await this.bot1.lpManager.addLiquidity(bot1LowerBelow1, bot1UpperBelow1, bot1LpUsdc1, true);
        const activeIds1_b1 = await this.bot1.lpManager.getActivePositionIds();
        const pos1Below1 = lpRes1Below1.positionId || activeIds1_b1.find(id => !allocatedIds1.includes(id));
        if (pos1Below1) {
          allocatedIds1.push(pos1Below1);
          this.bot1.state.lpPositionIdBelow1 = pos1Below1;
          this.bot1.state.rangeLowerBelow1 = bot1LowerBelow1;
          this.bot1.state.rangeUpperBelow1 = bot1UpperBelow1;
          Logger.success(`[Bot1] ✅ Below1指値LP構築完了: ${pos1Below1}`);
        }

        // ── Bot1 Below2: 残りUSDCを投入（さらに下の買い指値）──
        const finalBal_b2 = await this.bot1.lpManager.checkBalance();
        const bot1LpUsdc2 = Math.min(finalBal_b2.usdcBalance * 0.98, bot1UsdcNeeded * 1.02);
        Logger.info(`[Bot1] Below2 LP構築 (レンジ: $${bot1LowerBelow2.toFixed(4)}-$${bot1UpperBelow2.toFixed(4)}, USDC: $${bot1LpUsdc2.toFixed(2)})...`);
        const lpRes1Below2 = await this.bot1.lpManager.addLiquidity(bot1LowerBelow2, bot1UpperBelow2, bot1LpUsdc2, true);
        const activeIds1_b2 = await this.bot1.lpManager.getActivePositionIds();
        const pos1Below2 = lpRes1Below2.positionId || activeIds1_b2.find(id => !allocatedIds1.includes(id));
        if (pos1Below2) {
          allocatedIds1.push(pos1Below2);
          this.bot1.state.lpPositionIdBelow2 = pos1Below2;
          this.bot1.state.rangeLowerBelow2 = bot1LowerBelow2;
          this.bot1.state.rangeUpperBelow2 = bot1UpperBelow2;
          Logger.success(`[Bot1] ✅ Below2指値LP構築完了: ${pos1Below2}`);
        }

        // ── Bot1 Above1: SUI 50%を投入（売り指値）──
        const finalBalSui = await this.bot1.lpManager.checkBalance();
        const bot1LpSui1 = Math.min((finalBalSui.suiBalance - 0.5) * 0.50, bot1SuiNeeded * 1.02);

        if (bot1LpSui1 > 0.05) {
          Logger.info(`[Bot1] Above1 LP構築 (レンジ: $${bot1LowerAbove1.toFixed(4)}-$${bot1UpperAbove1.toFixed(4)}, SUI: ${bot1LpSui1.toFixed(4)})...`);
          const lpRes1Above1 = await this.bot1.lpManager.addLiquidity(bot1LowerAbove1, bot1UpperAbove1, bot1LpSui1, false);
          const activeIds1_a1 = await this.bot1.lpManager.getActivePositionIds();
          const pos1Above1 = lpRes1Above1.positionId || activeIds1_a1.find(id => !allocatedIds1.includes(id));
          if (pos1Above1) {
            allocatedIds1.push(pos1Above1);
            this.bot1.state.lpPositionIdAbove1 = pos1Above1;
            this.bot1.state.rangeLowerAbove1 = bot1LowerAbove1;
            this.bot1.state.rangeUpperAbove1 = bot1UpperAbove1;
            Logger.success(`[Bot1] ✅ Above1指値LP構築完了: ${pos1Above1}`);
          }
        }

        // ── Bot1 Above2: 残りSUIを投入（さらに上の売り指値）──
        const finalBalSui_a2 = await this.bot1.lpManager.checkBalance();
        const bot1LpSui2 = Math.min(finalBalSui_a2.suiBalance - 0.5, bot1SuiNeeded * 1.02);

        if (bot1LpSui2 > 0.05) {
          Logger.info(`[Bot1] Above2 LP構築 (レンジ: $${bot1LowerAbove2.toFixed(4)}-$${bot1UpperAbove2.toFixed(4)}, SUI: ${bot1LpSui2.toFixed(4)})...`);
          const lpRes1Above2 = await this.bot1.lpManager.addLiquidity(bot1LowerAbove2, bot1UpperAbove2, bot1LpSui2, false);
          const activeIds1_a2 = await this.bot1.lpManager.getActivePositionIds();
          const pos1Above2 = lpRes1Above2.positionId || activeIds1_a2.find(id => !allocatedIds1.includes(id));
          if (pos1Above2) {
            allocatedIds1.push(pos1Above2);
            this.bot1.state.lpPositionIdAbove2 = pos1Above2;
            this.bot1.state.rangeLowerAbove2 = bot1LowerAbove2;
            this.bot1.state.rangeUpperAbove2 = bot1UpperAbove2;
            Logger.success(`[Bot1] ✅ Above2指値LP構築完了: ${pos1Above2}`);
          }
        }

        // ── Bot2 (SUI / DEEP) LP構築 ──
        const finalBal3 = await this.bot1.lpManager.checkBalance();
        const allocatedIds2: string[] = [];

        // ══ Bot2: 現在価格中心に1%幅4ポジション隣接配置 ══
        // Below1: [price2*(1-w), price2]          ← SUI買い指値（SUIを投入）
        // Below2: [price2*(1-2w), price2*(1-w)]   ← さらに下の買い指値
        // Above1: [price2, price2*(1+w)]           ← DEEP売り指値（DEEPを投入）
        // Above2: [price2*(1+w), price2*(1+2w)]   ← さらに上の売り指値
        const bot2LowerBelow1 = price2 * (1 - width);
        const bot2UpperBelow1 = price2;
        const bot2LowerBelow2 = price2 * (1 - 2 * width);
        const bot2UpperBelow2 = price2 * (1 - width);
        const bot2LowerAbove1 = price2;
        const bot2UpperAbove1 = price2 * (1 + width);
        const bot2LowerAbove2 = price2 * (1 + width);
        const bot2UpperAbove2 = price2 * (1 + 2 * width);

        Logger.info(`[Bot2] レンジ構成:`);
        Logger.info(`  Below2: ${bot2LowerBelow2.toFixed(6)} - ${bot2UpperBelow2.toFixed(6)}`);
        Logger.info(`  Below1: ${bot2LowerBelow1.toFixed(6)} - ${bot2UpperBelow1.toFixed(6)}`);
        Logger.info(`  現在価格: ${price2.toFixed(6)}`);
        Logger.info(`  Above1: ${bot2LowerAbove1.toFixed(6)} - ${bot2UpperAbove1.toFixed(6)}`);
        Logger.info(`  Above2: ${bot2LowerAbove2.toFixed(6)} - ${bot2UpperAbove2.toFixed(6)}`);

        // ── Bot2 Below1: SUI 50%を投入（買い指値）──
        const bot2LpSui1 = Math.min((finalBal3.suiBalance - 0.3) * 0.50, bot2SuiNeeded * 1.02);

        if (bot2LpSui1 > 0.05) {
          Logger.info(`[Bot2] Below1 LP構築 (レンジ: ${bot2LowerBelow1.toFixed(6)}-${bot2UpperBelow1.toFixed(6)}, SUI: ${bot2LpSui1.toFixed(4)})...`);
          const lpRes2Below1 = await this.bot2.lpManager.addLiquidity(bot2LowerBelow1, bot2UpperBelow1, bot2LpSui1, false);
          const activeIds2_b1 = await this.bot2.lpManager.getActivePositionIds();
          const pos2Below1 = lpRes2Below1.positionId || activeIds2_b1.find(id => !allocatedIds1.includes(id) && !allocatedIds2.includes(id));
          if (pos2Below1) {
            allocatedIds2.push(pos2Below1);
            this.bot2.state.lpPositionIdBelow1 = pos2Below1;
            this.bot2.state.rangeLowerBelow1 = bot2LowerBelow1;
            this.bot2.state.rangeUpperBelow1 = bot2UpperBelow1;
            Logger.success(`[Bot2] ✅ Below1指値LP構築完了: ${pos2Below1}`);
          }
        }

        // ── Bot2 Below2: 残りSUIを投入（さらに下の買い指値）──
        const finalBal3_b2 = await this.bot2.lpManager.checkBalance();
        const bot2LpSui2 = Math.min((finalBal3_b2.suiBalance - 0.3) * 0.98, bot2SuiNeeded * 1.02);

        if (bot2LpSui2 > 0.05) {
          Logger.info(`[Bot2] Below2 LP構築 (レンジ: ${bot2LowerBelow2.toFixed(6)}-${bot2UpperBelow2.toFixed(6)}, SUI: ${bot2LpSui2.toFixed(4)})...`);
          const lpRes2Below2 = await this.bot2.lpManager.addLiquidity(bot2LowerBelow2, bot2UpperBelow2, bot2LpSui2, false);
          const activeIds2_b2 = await this.bot2.lpManager.getActivePositionIds();
          const pos2Below2 = lpRes2Below2.positionId || activeIds2_b2.find(id => !allocatedIds1.includes(id) && !allocatedIds2.includes(id));
          if (pos2Below2) {
            allocatedIds2.push(pos2Below2);
            this.bot2.state.lpPositionIdBelow2 = pos2Below2;
            this.bot2.state.rangeLowerBelow2 = bot2LowerBelow2;
            this.bot2.state.rangeUpperBelow2 = bot2UpperBelow2;
            Logger.success(`[Bot2] ✅ Below2指値LP構築完了: ${pos2Below2}`);
          }
        }

        // ── Bot2 Above1: DEEP 50%を投入（売り指値）──
        const bot2LpDeep1 = Math.min(finalDeep * 0.50, bot2DeepNeeded * 1.02);

        Logger.info(`[Bot2] Above1 LP構築 (レンジ: ${bot2LowerAbove1.toFixed(6)}-${bot2UpperAbove1.toFixed(6)}, DEEP: ${bot2LpDeep1.toFixed(2)})...`);
        const lpRes2Above1 = await this.bot2.lpManager.addLiquidity(bot2LowerAbove1, bot2UpperAbove1, bot2LpDeep1, true);
        const activeIds2_a1 = await this.bot2.lpManager.getActivePositionIds();
        const pos2Above1 = lpRes2Above1.positionId || activeIds2_a1.find(id => !allocatedIds1.includes(id) && !allocatedIds2.includes(id));
        if (pos2Above1) {
          allocatedIds2.push(pos2Above1);
          this.bot2.state.lpPositionIdAbove1 = pos2Above1;
          this.bot2.state.rangeLowerAbove1 = bot2LowerAbove1;
          this.bot2.state.rangeUpperAbove1 = bot2UpperAbove1;
          Logger.success(`[Bot2] ✅ Above1指値LP構築完了: ${pos2Above1}`);
        }

        // ── Bot2 Above2: 残りDEEPを投入（さらに上の売り指値）──
        const finalDeepObj_a2 = await this.bot2.lpManager.suiClient.getBalance({
          owner: this.bot2.lpManager.getWalletAddress(),
          coinType: deepCoinType || ''
        });
        const finalDeep_a2 = Number(finalDeepObj_a2.totalBalance) / 1e6;
        const bot2LpDeep2 = Math.min(finalDeep_a2 * 0.98, bot2DeepNeeded * 1.02);

        Logger.info(`[Bot2] Above2 LP構築 (レンジ: ${bot2LowerAbove2.toFixed(6)}-${bot2UpperAbove2.toFixed(6)}, DEEP: ${bot2LpDeep2.toFixed(2)})...`);
        const lpRes2Above2 = await this.bot2.lpManager.addLiquidity(bot2LowerAbove2, bot2UpperAbove2, bot2LpDeep2, true);
        const activeIds2_a2 = await this.bot2.lpManager.getActivePositionIds();
        const pos2Above2 = lpRes2Above2.positionId || activeIds2_a2.find(id => !allocatedIds1.includes(id) && !allocatedIds2.includes(id));
        if (pos2Above2) {
          allocatedIds2.push(pos2Above2);
          this.bot2.state.lpPositionIdAbove2 = pos2Above2;
          this.bot2.state.rangeLowerAbove2 = bot2LowerAbove2;
          this.bot2.state.rangeUpperAbove2 = bot2UpperAbove2;
          Logger.success(`[Bot2] ✅ Above2指値LP構築完了: ${pos2Above2}`);
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
    
    if (this.config.strategyMode === 'range_order') {
      // 0. アクティブポジション数のチェックと自己修復（常に4ポジションを維持。欠落が続けば再構築）
      const activePositionsCount = [
        bot.state.lpPositionIdBelow1,
        bot.state.lpPositionIdBelow2,
        bot.state.lpPositionIdAbove1,
        bot.state.lpPositionIdAbove2
      ].filter(Boolean).length;

      if (activePositionsCount === 0) {
        Logger.error(`[${bot.name}] アクティブな指値ポジションが0個になりました。即座にフェーズAへ移行し、ポジションを再構築します。`);
        this.bot1.state.phase = 'A';
        this.bot1.currentPhase = CyclePhase.A;
        this.bot2.state.phase = 'A';
        this.bot2.currentPhase = CyclePhase.A;
        this.bot1.state.missingPositionsStartAt = undefined;
        this.bot2.state.missingPositionsStartAt = undefined;
        this.bot1.stateManager.saveState(this.bot1.state);
        this.bot2.stateManager.saveState(this.bot2.state);
        return;
      }

      if (activePositionsCount < 4) {
        if (!bot.state.missingPositionsStartAt) {
          bot.state.missingPositionsStartAt = Date.now();
          Logger.warn(`[${bot.name}] ポジションの欠落を検知しました (現在: ${activePositionsCount}/4)。自己修復タイマーを開始します。`);
        } else {
          const duration = Date.now() - bot.state.missingPositionsStartAt;
          Logger.warn(`[${bot.name}] ポジション欠落継続中: ${(duration / 1000).toFixed(1)}秒 / 90秒`);
          if (duration >= 90000) { // 90秒継続で再構築
            Logger.error(`[${bot.name}] ポジションの欠落が90秒間継続したため、自動自己修復（統合フェーズA）を実行します。`);
            bot.state.missingPositionsStartAt = undefined;
            this.bot1.state.phase = 'A';
            this.bot1.currentPhase = CyclePhase.A;
            this.bot2.state.phase = 'A';
            this.bot2.currentPhase = CyclePhase.A;
            this.bot1.stateManager.saveState(this.bot1.state);
            this.bot2.stateManager.saveState(this.bot2.state);
            return;
          }
        }
      } else {
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

      Logger.info(`[${bot.name}] 監視中(指値)... 価格=$${price.toFixed(4)}, はみ出し監視レンジ=[$${rangeLower.toFixed(4)} - $${rangeUpper.toFixed(4)}], 生存数: ${activePositionsCount}/4`);

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
            Logger.error(`[${bot.name}] レンジ外はみ出しが設定時間以上継続したため、緊急リバランスを実行します。`);
            bot.state.breachStartAt = undefined;
            bot.state.phase = 'C';
            bot.currentPhase = CyclePhase.C;
            await this.executePhaseC(bot, price);
            return;
          }
        }
      } else {
        if (bot.state.breachStartAt) {
          Logger.info(`[${bot.name}] 価格がレンジ内に戻りました。はみ出しタイマーをリセットします。`);
          bot.state.breachStartAt = undefined;
        }
      }

      // 4. 手数料自動回収 (4つのポジションすべて対象)
      const positionsToCollect = [
        bot.state.lpPositionIdBelow1,
        bot.state.lpPositionIdBelow2,
        bot.state.lpPositionIdAbove1,
        bot.state.lpPositionIdAbove2
      ].filter(Boolean) as string[];

      const gasCostUsd = this.gasTracker.getAvgGasUsdc();
      for (const posId of positionsToCollect) {
        const feesUsd = await bot.lpManager.getAccumulatedFeesUsd(posId).catch(() => 0);
        if (feesUsd > gasCostUsd * 20) {
          Logger.info(`[${bot.name}] ポジション ${posId} の手数料自動回収を実行します。累積手数料: $${feesUsd.toFixed(4)}`);
          await bot.lpManager.collectFees(posId).catch(e => Logger.error(`手数料回収エラー: ${e.message}`));
        }
      }
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
      else {
        // レンジ内: 手数料自動回収
        if (bot.state.lpPositionId) {
          const feesUsd = await bot.lpManager.getAccumulatedFeesUsd(bot.state.lpPositionId);
          const gasCostUsd = this.gasTracker.getAvgGasUsdc();
          if (feesUsd > gasCostUsd * 20) {
            Logger.info(`[${bot.name}] 手数料累積回収を実行します。`);
            await bot.lpManager.collectFees(bot.state.lpPositionId);
          }
        }
      }
    }
  }

  private async checkAndRollPositions(bot: BotInstance, price: number): Promise<boolean> {
    const isBot1 = bot.name.includes('Bot1');
    const width = this.config.rangeOrderWidthPct || 0.01;
    const GAS_RESERVE = 0.5;


    // ─── 1. Below2 下限を下抜けした場合 → 下落方向スライドローリング ───
    // 価格が全4ポジションの最下限(Below2下限)を下回った = 2%下落した
    // → Above2をクローズし、グリッドを下にスライドさせ、新しいBelow2を構築
    if (bot.state.lpPositionIdBelow2 && price <= (bot.state.rangeUpperBelow2 || 0)) {
      Logger.warn(`[${bot.name}] 🔻 価格が Below2 の上限を下抜け（Below2がアクティブに）しました。下落方向スライドローリングを実行します。`);
      Logger.warn(`[${bot.name}]    価格: $${price.toFixed(6)}, Below2上限: $${(bot.state.rangeUpperBelow2 || 0).toFixed(6)}`);

      try {
        // 全ポジションから金利を回収して再投資資金にする
        const allActivePosIds = [
          bot.state.lpPositionIdBelow1,
          bot.state.lpPositionIdBelow2,
          bot.state.lpPositionIdAbove1,
          bot.state.lpPositionIdAbove2
        ].filter(Boolean) as string[];
        for (const posId of allActivePosIds) {
          try {
            Logger.info(`[${bot.name}] スライド前にポジション ${posId} から金利を回収し再投資へ...`);
            await bot.lpManager.collectFees(posId);
          } catch (e: any) {
            Logger.warn(`[${bot.name}] 金利自動回収失敗（続行します）: ${e.message}`);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1500));

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
        if (isBot1) {
          // Bot1 (SUI-USDC): Above2クローズで得たSUI → USDC に換えてBelow2資金にする
          const balance1 = await this.bot1.lpManager.checkBalance();
          const suiToSwap = Math.max(0, balance1.suiBalance - GAS_RESERVE);
          if (suiToSwap > 0.05) {
            Logger.info(`[${bot.name}] SUI → USDC スワップ: ${suiToSwap.toFixed(4)} SUI`);
            await bot.swapManager.swapSuiToUsdc(suiToSwap);
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        } else {
          // Bot2 (DEEP-SUI): Above2クローズで得たDEEP → SUI に換えてBelow2資金にする
          const deepCoinType = bot.lpManager.coinTypeA || '';
          const deepBalObj = await bot.lpManager.suiClient.getBalance({
            owner: bot.lpManager.getWalletAddress(),
            coinType: deepCoinType
          });
          const deepBalance = Number(deepBalObj.totalBalance) / 1e6;
          if (deepBalance > 0.5) {
            Logger.info(`[${bot.name}] DEEP → SUI スワップ: ${deepBalance.toFixed(2)} DEEP`);
            await bot.swapManager.swapDeepToSui(deepBalance);
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }

        // Step 4: 新しい Below2 を構築（旧 Below2 のさらに 1% 下）
        const finalUpper = rangeLowerBelow2_prev > 0 ? rangeLowerBelow2_prev : price * (1 - width);
        const newLower   = finalUpper * (1 - width);

        let amountToInvest = 0;
        let isCoinA = false;

        if (isBot1) {
          const balance1 = await this.bot1.lpManager.checkBalance();
          amountToInvest = balance1.usdcBalance * 0.98;
          isCoinA = true;
        } else {
          const balance2 = await bot.lpManager.checkBalance();
          amountToInvest = Math.max(0, balance2.suiBalance - GAS_RESERVE) * 0.98;
          isCoinA = false;
        }

        if (amountToInvest > 0.05) {
          Logger.info(`[${bot.name}] 新 Below2 構築: ${newLower.toFixed(6)} - ${finalUpper.toFixed(6)}, 投資量: ${amountToInvest.toFixed(4)}`);
          const lpRes = await bot.lpManager.addLiquidity(newLower, finalUpper, amountToInvest, isCoinA);
          const activeIds   = await bot.lpManager.getActivePositionIds();
          const allocatedIds = [bot.state.lpPositionIdBelow1, bot.state.lpPositionIdBelow2,
                                bot.state.lpPositionIdAbove1, bot.state.lpPositionIdAbove2].filter(Boolean) as string[];
          const newPosId = lpRes.positionId || activeIds.find(id => !allocatedIds.includes(id));

          if (newPosId) {
            bot.state.lpPositionIdBelow2   = newPosId;
            bot.state.rangeLowerBelow2     = newLower;
            bot.state.rangeUpperBelow2     = finalUpper;
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
          this.bot1.stateManager.saveState(this.bot1.state);
          this.bot2.stateManager.saveState(this.bot2.state);
          return true;
        }
        bot.stateManager.saveState(bot.state);
        return true;
      } catch (e: any) {
        Logger.error(`[${bot.name}] 下落スライドローリング中にエラー: ${e.message}`, e);
      }
    }

    // ─── 2. Above2 上限を上抜けした場合 → 上昇方向スライドローリング ───
    // 価格が全4ポジションの最上限(Above2上限)を上回った = 2%上昇した
    // → Below2をクローズし、グリッドを上にスライドさせ、新しいAbove2を構築
    if (bot.state.lpPositionIdAbove2 && price >= (bot.state.rangeLowerAbove2 || Infinity)) {
      Logger.warn(`[${bot.name}] 🔺 価格が Above2 の下限を上抜け（Above2がアクティブに）しました。上昇方向スライドローリングを実行します。`);
      Logger.warn(`[${bot.name}]    価格: $${price.toFixed(6)}, Above2下限: $${(bot.state.rangeLowerAbove2 || 0).toFixed(6)}`);

      try {
        // 全ポジションから金利を回収して再投資資金にする
        const allActivePosIds = [
          bot.state.lpPositionIdBelow1,
          bot.state.lpPositionIdBelow2,
          bot.state.lpPositionIdAbove1,
          bot.state.lpPositionIdAbove2
        ].filter(Boolean) as string[];
        for (const posId of allActivePosIds) {
          try {
            Logger.info(`[${bot.name}] スライド前にポジション ${posId} から金利を回収し再投資へ...`);
            await bot.lpManager.collectFees(posId);
          } catch (e: any) {
            Logger.warn(`[${bot.name}] 金利自動回収失敗（続行します）: ${e.message}`);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1500));

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
        if (isBot1) {
          // Bot1 (SUI-USDC): Below2クローズで得たUSDC → SUI に換えてAbove2資金にする
          const balance1 = await this.bot1.lpManager.checkBalance();
          const usdcToSwap = balance1.usdcBalance;
          if (usdcToSwap > 0.1) {
            Logger.info(`[${bot.name}] USDC → SUI スワップ: $${usdcToSwap.toFixed(2)} USDC`);
            await bot.swapManager.swapUsdcToSui(usdcToSwap);
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        } else {
          // Bot2 (DEEP-SUI): Below2クローズで得たSUI → DEEP に換えてAbove2資金にする
          const balance2 = await bot.lpManager.checkBalance();
          const suiToSwap = Math.max(0, balance2.suiBalance - GAS_RESERVE);
          if (suiToSwap > 0.05) {
            Logger.info(`[${bot.name}] SUI → DEEP スワップ: ${suiToSwap.toFixed(4)} SUI`);
            await bot.swapManager.swapSuiToDeep(suiToSwap);
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }

        // Step 4: 新しい Above2 を構築（旧 Above2 のさらに 1% 上）
        const finalLower = rangeUpperAbove2_prev > 0 ? rangeUpperAbove2_prev : price * (1 + width);
        const newUpper   = finalLower * (1 + width);

        let amountToInvest = 0;
        let isCoinA = false;

        if (isBot1) {
          const balance1 = await this.bot1.lpManager.checkBalance();
          amountToInvest = Math.max(0, balance1.suiBalance - GAS_RESERVE) * 0.98;
          isCoinA = false;
        } else {
          const deepCoinType = bot.lpManager.coinTypeA || '';
          const deepBalObj = await bot.lpManager.suiClient.getBalance({
            owner: bot.lpManager.getWalletAddress(),
            coinType: deepCoinType
          });
          const deepBalance = Number(deepBalObj.totalBalance) / 1e6;
          amountToInvest = deepBalance * 0.98;
          isCoinA = true;
        }

        if (amountToInvest > 0.05) {
          Logger.info(`[${bot.name}] 新 Above2 構築: ${finalLower.toFixed(6)} - ${newUpper.toFixed(6)}, 投資量: ${amountToInvest.toFixed(4)}`);
          const lpRes = await bot.lpManager.addLiquidity(finalLower, newUpper, amountToInvest, isCoinA);
          const activeIds   = await bot.lpManager.getActivePositionIds();
          const allocatedIds = [bot.state.lpPositionIdBelow1, bot.state.lpPositionIdBelow2,
                                bot.state.lpPositionIdAbove1, bot.state.lpPositionIdAbove2].filter(Boolean) as string[];
          const newPosId = lpRes.positionId || activeIds.find(id => !allocatedIds.includes(id));

          if (newPosId) {
            bot.state.lpPositionIdAbove2   = newPosId;
            bot.state.rangeLowerAbove2     = finalLower;
            bot.state.rangeUpperAbove2     = newUpper;
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
          this.bot1.stateManager.saveState(this.bot1.state);
          this.bot2.stateManager.saveState(this.bot2.state);
          return true;
        }
        bot.stateManager.saveState(bot.state);
        return true;
      } catch (e: any) {
        Logger.error(`[${bot.name}] 上昇スライドローリング中にエラー: ${e.message}`, e);
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
      this.bot1.state.bluefinOrderId = null;
      this.bot1.state.bluefinSide = 'none';
      this.bot1.state.phase = 'A';
      this.bot1.stateManager.saveState(this.bot1.state);

      this.bot2.state.lpPositionId = null;
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
    }
  }

  public async getPnlData(currentPrice: number, userWalletAddress?: string) {
    const now = Date.now();
    // 15秒間キャッシュを利用する（同一の連携アドレスに対してのみ）
    if (this.lastPnlData && (now - this.lastPnlDataTime < 15000) && (this.lastPnlData.userWalletAddress === userWalletAddress)) {
      return this.lastPnlData.data;
    }

    const stats = this.tracker.getStats();
    const hedgeStatus = this.hedgeManager.getStatus(currentPrice);
    
    const totalPnlNum = parseFloat(stats.totalPnl) || 0;
    const totalFeesNum = parseFloat(stats.totalFees) || 0;
    const gasSpentNum = this.gasTracker.getStats().totalGasUsdc || 0;
    
    let lpValue1 = 0;
    let lpValue2 = 0;
    let totalSuiInLp = 0;

    if (this.config.strategyMode === 'range_order') {
      const p1 = this.bot1.state;
      const p2 = this.bot2.state;
      const posIds1 = [p1.lpPositionIdBelow1, p1.lpPositionIdBelow2, p1.lpPositionIdAbove1, p1.lpPositionIdAbove2].filter(Boolean) as string[];
      const posIds2 = [p2.lpPositionIdBelow1, p2.lpPositionIdBelow2, p2.lpPositionIdAbove1, p2.lpPositionIdAbove2].filter(Boolean) as string[];

      for (const id of posIds1) {
        const details = await this.bot1.lpManager.getPositionDetails(id).catch(() => null);
        lpValue1 += details?.usdValue || 0;
        totalSuiInLp += await this.bot1.lpManager.getSuiAmountInLp(id).catch(() => 0);
      }
      for (const id of posIds2) {
        const details = await this.bot2.lpManager.getPositionDetails(id).catch(() => null);
        lpValue2 += details?.usdValue || 0;
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
      lpValue2 = lpDetails2?.usdValue || 0;
    }

    const balance = await this.bot1.lpManager.checkBalance();

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
      // 強制リバランス: フェーズCではなく統合フェーズA（全資金再配分）を実行
      Logger.info('[STRATEGY] 手動リバランス: 両ボットの全資金を再配分します（統合フェーズA）');
      const price2 = await this.bot2.priceMonitor.getCurrentPrice();
      this.bot1.state.phase = 'A';
      this.bot2.state.phase = 'A';
      this.bot1.currentPhase = CyclePhase.A;
      this.bot2.currentPhase = CyclePhase.A;
      await this.executeCombinedPhaseA(currentPrice, price2);
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
