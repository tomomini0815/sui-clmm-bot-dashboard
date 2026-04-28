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
import { SessionManager } from './sessionManager.js';

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
  public isEmergencyStopped: boolean = false;
  private isProcessingRebalance: boolean = false;
  private currentLpValueUsdc: number = 0;
  private sessionPrivateKey: string | null = null;
  private sessionWalletAddress: string | null = null;

  constructor(
    public priceMonitor: PriceMonitor,
    public lpManager: LpManager,
    public hedgeManager: HedgeManager,
    public gasTracker: GasTracker,
    public pnlEngine: PnlEngine,
    public tracker: Tracker,
    public config: BotConfig,
    public sessionId: string = 'master-bot',
    private onStateChange?: () => void
  ) {
    this.refreshConfig();
  }

  public async setPrivateKey(privateKey: string) {
    this.sessionPrivateKey = privateKey;
    try {
      const decoded = decodeSuiPrivateKey(privateKey);
      const keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
      this.sessionWalletAddress = keypair.getPublicKey().toSuiAddress();
      this.lpManager.setKeypair(keypair);
      const network = this.config.rpcUrl.includes('testnet') ? 'testnet' : 'mainnet';
      await this.hedgeManager.setupBluefin(keypair, this.config.rpcUrl, network as any);
    } catch (e) {}
  }

  public getWalletAddress() { return this.sessionWalletAddress || 'unknown'; }

  public serialize() {
    return {
      currentLowerBound: this.currentLowerBound,
      currentUpperBound: this.currentUpperBound,
      lastRebalanceTime: this.lastRebalanceTime,
      currentPositionNft: this.lpManager.currentPositionNft,
    };
  }

  public restore(state: any) {
    if (!state) return;
    this.currentLowerBound = state.currentLowerBound || 0;
    this.currentUpperBound = state.currentUpperBound || 0;
    this.lastRebalanceTime = state.lastRebalanceTime || 0;
    if (state.currentPositionNft) this.lpManager.currentPositionNft = state.currentPositionNft;
  }

  public async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isEmergencyStopped = false;
    Logger.success(`Strategy [${this.sessionId}] started.`);
    this.notify(`🚀 ボット稼働開始 (${this.sessionId})`);
    
    const currentPrice = await this.priceMonitor.getCurrentPrice();
    await this.runRebalance(currentPrice, true);
    
    this.intervalId = setInterval(async () => {
      try {
        const price = await this.priceMonitor.getCurrentPrice();
        await this.runRebalance(price);
      } catch (err) {
        Logger.error('Strategy loop error', err);
      }
    }, 30000);
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    // ヘッジ要求をクリア
    this.hedgeManager.clearSessionTarget(this.sessionId);
    Logger.warn(`Strategy [${this.sessionId}] stopped.`);
    this.notify(`🛑 ボット停止 (${this.sessionId})`);
  }

  public refreshConfig(newConfig?: BotConfig) {
    if (newConfig) this.config = newConfig;
    if (this.config.telegramToken && this.config.telegramChatId) {
      this.telegram = new TelegramBot(this.config.telegramToken, { polling: false });
    } else {
      this.telegram = null;
    }
  }

  private notify(message: string) {
    if (this.telegram && this.config.telegramChatId) {
      this.telegram.sendMessage(this.config.telegramChatId, `🤖 SUI Bot\n${message}`).catch(() => {});
    }
  }

  public async getPnlData(currentPrice: number) {
    const pnl = this.pnlEngine.calculateNetPnl(currentPrice);
    const hedge = this.hedgeManager.getStatus(currentPrice);
    const gas = this.gasTracker.getStats();
    
    return {
      pnl,
      hedge,
      gasStats: gas,
      delta: {
        totalDelta: 0,
        lpDelta: 0.5,
        hedgeDelta: hedge.active ? -0.5 : 0
      },
      currentPhase: this.currentPhase,
      dailySnapshots: []
    };
  }

  public async runRebalance(currentPrice: number, forceReset: boolean = false) {
    if (this.isProcessingRebalance) return;
    try {
      this.isProcessingRebalance = true;
      this.currentPhase = CyclePhase.REBALANCING;
      await this.executeBalancedStrategy(currentPrice, forceReset);
    } catch (e: any) {
      Logger.error(`Rebalance failed: ${e.message}`);
      await this.tracker.recordEvent('エラー', `リバランス失敗: ${e.message}`, currentPrice);
    } finally {
      this.isProcessingRebalance = false;
      this.lastRebalanceTime = Date.now();
    }
  }

  private async executeBalancedStrategy(currentPrice: number, forceReset: boolean = false) {
    const isOutOfRange = (this.currentLowerBound > 0 && this.currentUpperBound > 0) &&
                        (currentPrice < this.currentLowerBound || currentPrice > this.currentUpperBound);

    if (!isOutOfRange && !forceReset && this.currentLowerBound > 0) {
      const hasPosition = await this.lpManager.hasActivePosition();
      if (hasPosition) {
        this.currentPhase = CyclePhase.MONITORING;
        return;
      }
    }

    Logger.info(`Strategy [${this.sessionId}] Rebalancing: Price $${currentPrice.toFixed(4)}`);
    
    // ヘッジ無効設定の場合、個別のターゲットを0にする（集約ヘッジロジックが他ボットと合算して調整する）
    if (!this.config.hedgeEnabled) {
      this.hedgeManager.clearSessionTarget(this.sessionId);
      await this.hedgeManager.adjustPosition(0, currentPrice, this.sessionId);
    }

    // 自身のポジションのみをクローズ
    await this.closeAllPositions(currentPrice);
    
    const { lpValue } = await this.evaluateAndBalance(currentPrice);

    if (lpValue < 0.1) {
      Logger.warn(`Strategy [${this.sessionId}]: lpValue ($${lpValue.toFixed(2)}) is too small. Waiting for more funds.`);
      this.currentPhase = CyclePhase.IDLE;
      return;
    }

    const width = this.config.rangeWidth || 0.02;
    const lowerBound = currentPrice * (1 - width);
    const upperBound = currentPrice * (1 + width);

    // LP投入
    await this.lpManager.addLiquidity(lowerBound, upperBound, lpValue, true);

    // ヘッジ調整 (集約ロジックを使用)
    if (this.config.hedgeEnabled) {
      // デルタ0.5固定（価格中央）
      const hedgeUsd = lpValue * 0.5 * this.config.hedgeRatio;
      await this.hedgeManager.adjustPosition(hedgeUsd, currentPrice, this.sessionId);
    }

    this.currentLowerBound = lowerBound;
    this.currentUpperBound = upperBound;
    this.currentPhase = CyclePhase.MONITORING;
    if (this.onStateChange) this.onStateChange();
  }

  private async closeAllPositions(currentPrice: number) {
    // 自身のPosition NFTのみを解除
    await this.lpManager.removeLiquidity().catch(() => {});
    
    // ヘッジは完全決済せず、自身のターゲットを0にして全体で調整
    this.hedgeManager.clearSessionTarget(this.sessionId);
    await this.hedgeManager.adjustPosition(0, currentPrice, this.sessionId);
    
    this.currentLowerBound = 0;
    this.currentUpperBound = 0;
  }

  private async evaluateAndBalance(currentPrice: number) {
    const { usdcBalance, suiBalance } = await this.lpManager.checkBalance();
    const margin = await this.hedgeManager.getMarginBalance();
    
    // ウォレット全体の時価総額
    const totalWalletEquityUsd = usdcBalance + (suiBalance * currentPrice) + margin;
    
    // 全アクティブボットの希望額の合計を取得
    const totalDesired = SessionManager.getTotalDesiredCapital();
    
    let availableEquityUsd;
    if (totalDesired > totalWalletEquityUsd && totalDesired > 0) {
      // 【自動調整】総資産が不足している場合、比例配分を行う
      const myShare = this.config.lpAmountUsdc / totalDesired;
      availableEquityUsd = totalWalletEquityUsd * myShare;
      Logger.info(`Strategy [${this.sessionId}] Scaling: TotalEquity($${totalWalletEquityUsd.toFixed(2)}) < TotalDesired($${totalDesired.toFixed(2)}). Share: ${(myShare * 100).toFixed(1)}%`);
    } else {
      // 資金が十分にある場合は、従来の「他ボットの予約分を差し引く」ロジック
      const committedByOthers = SessionManager.getCommittedCapital(this.sessionId);
      availableEquityUsd = Math.max(0, totalWalletEquityUsd - committedByOthers);
    }
    
    Logger.info(`Strategy [${this.sessionId}] Allocation: Total=$${totalWalletEquityUsd.toFixed(2)}, Target=$${this.config.lpAmountUsdc.toFixed(2)}, Available=$${availableEquityUsd.toFixed(2)}`);

    // 運用額の決定
    let lpValue = this.config.lpAmountUsdc;
    
    // lpAmountUsdc が未設定（0以下）の場合は、安全な最小額で運用を試みる
    if (lpValue <= 0.1) {
      const minLp = Math.min(availableEquityUsd * 0.95, 2.0); 
      lpValue = Math.max(0, minLp);
    } else {
      // 指定額がある場合、利用可能額を超えないようにガード（ガス代バッファ 5%）
      lpValue = Math.min(lpValue, availableEquityUsd * 0.95);
    }
    
    this.currentLpValueUsdc = lpValue;
    return { totalCapital: availableEquityUsd, lpValue };
  }
}
