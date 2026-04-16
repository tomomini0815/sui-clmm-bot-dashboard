import { Strategy } from './strategy.js';
import { PriceMonitor } from './priceMonitor.js';
import { LpManager } from './lpManager.js';
import { HedgeManager } from './hedgeManager.js';
import { GasTracker } from './gasTracker.js';
import { PnlEngine } from './pnlEngine.js';
import { Logger } from './logger.js';
import { config } from './config.js';

/**
 * ユーザーセッション管理
 * 各ユーザーごとに独立したボットインスタンスを管理
 */
export interface UserSession {
  sessionId: string;
  walletAddress: string;
  strategy: Strategy;
  priceMonitor: PriceMonitor;
  lpManager: LpManager;
  hedgeManager: HedgeManager;
  gasTracker: GasTracker;
  pnlEngine: PnlEngine;
  createdAt: number;
  lastActive: number;
}

export class SessionManager {
  private static sessions: Map<string, UserSession> = new Map();
  private static readonly SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24時間

  /**
   * 新しいセッションを作成
   * @param privateKey 秘密鍵（オプション - ウォレット接続モードでは不要）
   * @param walletAddress ウォレットアドレス（オプション - 秘密鍵モードでは自動取得）
   */
  static async createSession(sessionId: string, privateKey: string | null = null, walletAddress: string | null = null): Promise<UserSession> {
    Logger.success(`Creating new session: ${sessionId}`);

    // 各コンポーネントをインスタンス化
    const priceMonitor = new PriceMonitor();
    const gasTracker = new GasTracker();
    const pnlEngine = new PnlEngine();
    const lpManager = new LpManager(priceMonitor, gasTracker);
    const hedgeManager = new HedgeManager(config.hedgeMode);

    const strategy = new Strategy(
      priceMonitor,
      lpManager,
      hedgeManager,
      gasTracker,
      pnlEngine
    );

    // 秘密鍵モード
    if (privateKey) {
      strategy.setPrivateKey(privateKey);
    }
    
    // ウォレット接続モード（デモ/読み取り専用）
    let sessionWalletAddress = walletAddress;
    if (!sessionWalletAddress && privateKey) {
      sessionWalletAddress = strategy.getWalletAddress();
    }
    if (!sessionWalletAddress) {
      sessionWalletAddress = '0x' + sessionId.replace(/-/g, '').slice(0, 40); // フォールバック
    }

    const session: UserSession = {
      sessionId,
      walletAddress: sessionWalletAddress,
      strategy,
      priceMonitor,
      lpManager,
      hedgeManager,
      gasTracker,
      pnlEngine,
      createdAt: Date.now(),
      lastActive: Date.now()
    };

    this.sessions.set(sessionId, session);
    Logger.success(`Session created for wallet: ${session.walletAddress}`);

    return session;
  }

  /**
   * セッションを取得
   */
  static getSession(sessionId: string): UserSession | null {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActive = Date.now();
    }
    return session || null;
  }

  /**
   * ウォレットアドレスでセッションを検索
   */
  static getSessionByWallet(walletAddress: string): UserSession | null {
    for (const session of this.sessions.values()) {
      if (session.walletAddress === walletAddress) {
        session.lastActive = Date.now();
        return session;
      }
    }
    return null;
  }

  /**
   * セッションを削除
   */
  static removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.strategy.stop();
      this.sessions.delete(sessionId);
      Logger.success(`Session removed: ${sessionId}`);
    }
  }

  /**
   * 期限切れセッションをクリーンアップ
   */
  static cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActive > this.SESSION_TIMEOUT) {
        Logger.info(`Cleaning up expired session: ${sessionId}`);
        session.strategy.stop();
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * 全セッションの統計を取得
   */
  static getAllSessionsStats(): Array<{
    sessionId: string;
    walletAddress: string;
    isRunning: boolean;
    createdAt: number;
  }> {
    const stats = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      stats.push({
        sessionId,
        walletAddress: session.walletAddress,
        isRunning: session.strategy.isRunning,
        createdAt: session.createdAt
      });
    }
    return stats;
  }

  /**
   * アクティブセッション数
   */
  static getActiveSessionCount(): number {
    return this.sessions.size;
  }
}
