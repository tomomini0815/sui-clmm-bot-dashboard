import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Strategy } from './strategy.js';
import { PriceMonitor } from './priceMonitor.js';
import { LpManager } from './lpManager.js';
import { HedgeManager } from './hedgeManager.js';
import { GasTracker } from './gasTracker.js';
import { PnlEngine } from './pnlEngine.js';
import { Tracker } from './tracker.js';
import { Logger } from './logger.js';
import { config as globalConfig, BotConfig } from './config.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * ユーザーセッション管理
 * 各ユーザーごとに独立したボットインスタンスを管理
 */
export interface UserSession {
  sessionId: string;
  walletAddress: string;
  botWalletAddress: string;
  keypair: Ed25519Keypair;
  mnemonic?: string;
  strategy: Strategy;
  priceMonitor: PriceMonitor;
  lpManager: LpManager;
  hedgeManager: HedgeManager;
  gasTracker: GasTracker;
  pnlEngine: PnlEngine;
  tracker: Tracker;
  config: BotConfig;
  createdAt: number;
  lastActive: number;
}

export class SessionManager {
  private static sessions: Map<string, UserSession> = new Map();
  private static hedgeManagers: Map<string, HedgeManager> = new Map();
  private static readonly SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24時間

  /**
   * 新しいセッションを作成
   * @param mnemonic シードフレーズ（オプション - 復元用）
   * @param privateKey 秘密鍵（オプション - ウォレット接続モードでは不要）
   * @param walletAddress ユーザーの接続ウォレットアドレス（オプション）
   */
  static async createSession(sessionId: string, mnemonic: string | null = null, privateKey: string | null = null, walletAddress: string | null = null): Promise<UserSession> {
    Logger.success(`Creating/Restoring session: ${sessionId}`);

    // セッション専用のキーペアを準備
    let sessionKeypair: Ed25519Keypair | null = null;
    let sessionMnemonic: string | undefined = mnemonic || undefined;

    // 【最優先】 .env にマスター秘密鍵が設定されている場合はそれを使用する (固定化)
    if (globalConfig.privateKey && globalConfig.privateKey !== 'your_private_key_here') {
      try {
        const { secretKey } = (globalConfig.privateKey.startsWith('suiprivkey')) 
          ? decodeSuiPrivateKey(globalConfig.privateKey)
          : { secretKey: Buffer.from(globalConfig.privateKey.replace('0x', ''), 'hex') };
        
        sessionKeypair = Ed25519Keypair.fromSecretKey(secretKey);
        const masterAddress = sessionKeypair.getPublicKey().toSuiAddress();
        Logger.success(`[MASTER KEY] Dedicated Bot Wallet FIXED to: ${masterAddress}`);
        
        const masterSessionId = `master-${masterAddress.slice(0, 8)}`;
        
        Logger.info(`[DEBUG] masterAddress: ${masterAddress}`);
        Logger.info(`[DEBUG] connecting walletAddress: ${walletAddress}`);
        
        // セッションIDが「default」であるか、接続ウォレットがマスターアドレスと一致する場合、マスターセッションとして扱う
        const isDefaultMaster = (sessionId === masterSessionId || sessionId === 'default' || walletAddress === masterAddress);
        
        Logger.info(`[DEBUG] isDefaultMaster: ${isDefaultMaster} (ID match: ${sessionId === masterSessionId}, default: ${sessionId === 'default'}, wallet match: ${walletAddress === masterAddress})`);
        
        // メモリ上に既存のセッションがあればそれを返す
        // ただし、明示的に異なるセッションID（bot2など）が指定されている場合は、シングルトンをバイパスして新規作成を許可する
        const existingSession = Array.from(this.sessions.values()).find(s => s.sessionId === masterSessionId || s.walletAddress === masterAddress);
        
        if (existingSession && isDefaultMaster) {
          Logger.info(`[SINGLETON] Reusing existing master session [${existingSession.sessionId}] for wallet: ${masterAddress}`);
          return existingSession;
        }

        // ここで sessionId をマスター用のものに上書き（マスター判定時のみ）
        if (isDefaultMaster) sessionId = masterSessionId;
      } catch (e: any) {
        Logger.error(`Failed to load MASTER PRIVATE_KEY from .env: ${e.message}`);
      }
    }

    if (!sessionKeypair) {
      // まず既存の永続化ファイルから鍵を復元できるか試みる
      // シードフレーズが提供された場合、既存のセッションファイルをスキャンして一致するものを探す
      let targetSessionId = sessionId;
      if (mnemonic) {
        const existingId = this.findSessionIdByMnemonic(mnemonic);
        if (existingId) {
          Logger.success(`Found existing session [${existingId}] for provided mnemonic.`);
          targetSessionId = existingId;
        }
      }

      // まず既存の永続化ファイルから鍵を復元できるか試みる
      const filePath = path.resolve(process.cwd(), `session_state_${targetSessionId}.json`);
      
      if (fs.existsSync(filePath)) {
        try {
          const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          
          // シードフレーズがあれば優先的に使用
          if (state.mnemonic) {
            sessionMnemonic = state.mnemonic;
            sessionKeypair = Ed25519Keypair.deriveKeypair(sessionMnemonic as string);
            Logger.success(`Dedicated Bot Wallet restored from Mnemonic: ${sessionKeypair.getPublicKey().toSuiAddress()}`);
          } 
          // 秘密鍵のみの場合
          else if (state.botSecretKey) {
            const { secretKey } = (state.botSecretKey.startsWith('suiprivkey')) 
              ? decodeSuiPrivateKey(state.botSecretKey)
              : { secretKey: Buffer.from(state.botSecretKey.replace('0x', ''), 'hex') };
            sessionKeypair = Ed25519Keypair.fromSecretKey(secretKey);
            Logger.success(`Dedicated Bot Wallet restored from Secret Key: ${sessionKeypair.getPublicKey().toSuiAddress()}`);
          }
        } catch (e) {
          Logger.warn(`Failed to restore wallet from file: ${targetSessionId}`);
        }
      }

      if (!sessionKeypair) {
        if (sessionMnemonic) {
          try {
            sessionKeypair = Ed25519Keypair.deriveKeypair(sessionMnemonic);
            Logger.success(`Wallet derived from provided mnemonic: ${sessionKeypair.getPublicKey().toSuiAddress()}`);
          } catch (e) {
            Logger.error('Failed to derive wallet from provided mnemonic');
          }
        }
        
        if (!sessionKeypair && privateKey) {
          try {
            const { secretKey } = (privateKey.startsWith('suiprivkey')) 
              ? decodeSuiPrivateKey(privateKey)
              : { secretKey: Buffer.from(privateKey.replace('0x', ''), 'hex') };
            sessionKeypair = Ed25519Keypair.fromSecretKey(secretKey);
          } catch (e) {
            Logger.warn('Invalid private key provided, generating new one with mnemonic.');
            sessionMnemonic = bip39.generateMnemonic(wordlist);
            sessionKeypair = Ed25519Keypair.deriveKeypair(sessionMnemonic);
          }
        } else if (!sessionKeypair) {
          // 完全新規生成
          sessionMnemonic = bip39.generateMnemonic(wordlist);
          sessionKeypair = Ed25519Keypair.deriveKeypair(sessionMnemonic);
        }
      }
    }

    const targetSessionId = sessionId; // 互換性のため保持

    const botWalletAddress = sessionKeypair.getPublicKey().toSuiAddress();
    Logger.info(`Dedicated Bot Wallet generated: ${botWalletAddress}`);

    // セッション固有の設定（グローバル設定をコピー）
    const sessionConfig: BotConfig = { ...globalConfig };

    // 各コンポーネントをインスタンス化
    const priceMonitor = new PriceMonitor(sessionConfig);
    const gasTracker = new GasTracker();
    const tracker = new Tracker(targetSessionId);
    await tracker.init();
    
    const pnlEngine = new PnlEngine();
    
    // LpManagerにキーペアとTrackerを注入
    const lpManager = new LpManager(priceMonitor, gasTracker, tracker, sessionConfig);
    lpManager.setKeypair(sessionKeypair);

    let hedgeManager = this.hedgeManagers.get(botWalletAddress);
    if (!hedgeManager) {
      hedgeManager = new HedgeManager(sessionConfig.hedgeMode);
      this.hedgeManagers.set(botWalletAddress, hedgeManager);
    }

    const strategy = new Strategy(
      priceMonitor,
      lpManager,
      hedgeManager,
      gasTracker,
      pnlEngine,
      tracker,
      sessionConfig,
      targetSessionId, // sessionIdを明示的に渡す
      () => SessionManager.saveSessionState(targetSessionId)
    );

    // Strategyに秘密鍵を設定して初期化 (Bluefin等のセットアップを待機)
    await strategy.setPrivateKey(sessionKeypair.getSecretKey());

    // 保存された状態があれば復元
    const savedState = this.loadSessionState({ sessionId: targetSessionId, pnlEngine, gasTracker, hedgeManager, tracker, strategy });
    
    // 保存された状態がある場合、まず保存された設定をベースにする
    if (savedState && savedState.config) {
      Object.assign(sessionConfig, savedState.config);
      
      // その上で、運用額などの動的に変更したい項目のみ .env から最新化する
      sessionConfig.lpAmountUsdc = globalConfig.lpAmountUsdc;
      sessionConfig.totalOperationalCapitalUsdc = globalConfig.totalOperationalCapitalUsdc;
      sessionConfig.rpcUrl = globalConfig.rpcUrl;
      
      // コンポーネントに反映
      priceMonitor.refreshConfig(sessionConfig);
      lpManager.refreshConfig(sessionConfig);
      strategy.refreshConfig(sessionConfig);
      
      Logger.info(`Session [${targetSessionId}] config restored and synced with key .env values.`);
    }
    
    // ウォレット接続モード（デモ/読み取り専用）
    let sessionWalletAddress = walletAddress;
    if (!sessionWalletAddress && privateKey) {
      sessionWalletAddress = strategy.getWalletAddress();
    }
    if (!sessionWalletAddress) {
      sessionWalletAddress = '0x' + targetSessionId.replace(/-/g, '').slice(0, 40); // フォールバック
    }

    const session: UserSession = {
      sessionId: targetSessionId,
      walletAddress: walletAddress || botWalletAddress,
      botWalletAddress,
      keypair: sessionKeypair,
      mnemonic: sessionMnemonic,
      strategy,
      priceMonitor,
      lpManager,
      hedgeManager,
      gasTracker,
      pnlEngine,
      tracker,
      config: sessionConfig,
      createdAt: Date.now(),
      lastActive: Date.now()
    };

    this.sessions.set(targetSessionId, session);
    Logger.success(`Session [${targetSessionId}] created for wallet: ${session.walletAddress}`);

    // 新規作成時も即座に一度保存して鍵を確定させる
    this.saveSessionState(targetSessionId);

    return session;
  }

  /**
   * ウォレットアドレスに基づいて既存のセッションIDを検索
   */
  static findSessionIdByWalletAddress(walletAddress: string): string | null {
    try {
      const files = fs.readdirSync(process.cwd());
      const sessionFiles = files.filter(f => f.startsWith('session_state_') && f.endsWith('.json'));

      for (const file of sessionFiles) {
        try {
          const content = fs.readFileSync(path.join(process.cwd(), file), 'utf-8');
          const state = JSON.parse(content);
          if (state.walletAddress === walletAddress) {
            return file.replace('session_state_', '').replace('.json', '');
          }
        } catch (e) {}
      }
    } catch (e) {
      Logger.error('Failed to scan session files for wallet address', e);
    }
    return null;
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
   * 全セッションを取得
   */
  static getAllSessions(): UserSession[] {
    return Array.from(this.sessions.values());
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
    lpAmountUsdc: number;
  }> {
    const stats = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      stats.push({
        sessionId,
        walletAddress: session.walletAddress,
        isRunning: session.strategy.isRunning,
        createdAt: session.createdAt,
        lpAmountUsdc: session.config.lpAmountUsdc
      });
    }
    return stats;
  }

  /**
   * 指定したセッション以外で使用されている総資金を計算
   */
  static getCommittedCapital(excludeSessionId: string): number {
    let total = 0;
    for (const [sid, session] of this.sessions.entries()) {
      if (sid !== excludeSessionId && session.strategy.isRunning) {
        // 設定されたLP運用額を「コミット済み」とみなす
        total += session.config.lpAmountUsdc;
      }
    }
    return total;
  }

  /**
   * 全アクティブセッションの合計希望運用額を計算
   */
  static getTotalDesiredCapital(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      if (session.strategy.isRunning) {
        total += session.config.lpAmountUsdc;
      }
    }
    return total;
  }

  /**
   * アクティブセッション数
   */
  static getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * シードフレーズに基づいて既存のセッションIDを検索
   */
  private static findSessionIdByMnemonic(mnemonic: string): string | null {
    try {
      const files = fs.readdirSync(process.cwd());
      const sessionFiles = files.filter(f => f.startsWith('session_state_') && f.endsWith('.json'));

      for (const file of sessionFiles) {
        try {
          const content = fs.readFileSync(path.join(process.cwd(), file), 'utf-8');
          const state = JSON.parse(content);
          if (state.mnemonic === mnemonic) {
            // "session_state_ID.json" から ID を抽出
            return file.replace('session_state_', '').replace('.json', '');
          }
        } catch (e) {
          // 個別ファイルのエラーは無視
        }
      }
    } catch (e) {
      Logger.error('Failed to scan session files', e);
    }
    return null;
  }

  /**
   * セッションの状態をファイルに保存
   */
  static saveSessionState(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      const state = {
        pnl: session.pnlEngine.serialize(),
        gas: session.gasTracker.serialize(),
        hedge: session.hedgeManager.serialize(),
        tracker: session.tracker.serialize(), // Trackerデータを追加
        strategy: session.strategy.serialize(), // 戦略状態を追加
        botSecretKey: session.keypair.getSecretKey(),
        mnemonic: session.mnemonic,
        walletAddress: session.walletAddress, // ウォレットアドレスを保存
        config: session.config,
        isRunning: session.strategy.isRunning,
        updatedAt: Date.now()
      };
      
      const filePath = path.resolve(process.cwd(), `session_state_${sessionId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
      Logger.info(`Session state saved (including secret key and wallet address): ${sessionId}`);
    } catch (e) {
      Logger.error(`Failed to save session state: ${sessionId}`, e);
    }
  }

  /**
   * セッションの状態をファイルから復元
   */
  private static loadSessionState(components: { 
    sessionId: string, 
    pnlEngine: PnlEngine, 
    gasTracker: GasTracker, 
    hedgeManager: HedgeManager,
    tracker: Tracker,
    strategy: Strategy
  }): any {
    const { sessionId, pnlEngine, gasTracker, hedgeManager } = components;
    const filePath = path.resolve(process.cwd(), `session_state_${sessionId}.json`);
    
    if (fs.existsSync(filePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        pnlEngine.restore(state.pnl);
        gasTracker.restore(state.gas);
        hedgeManager.restore(state.hedge);
        if (state.tracker) components.tracker.restore(state.tracker); // Trackerデータを復元
        if (state.strategy) components.strategy.restore(state.strategy); // 戦略状態を復元
        
        // 実行状態を復元
        if (state.isRunning) {
          components.strategy.isRunning = true;
          Logger.info(`Session [${sessionId}] was running, prepared for auto-resume.`);
        }

        Logger.success(`Session state restored from file: ${sessionId}`);
        return state;
      } catch (e) {
        Logger.warn(`Failed to restore session state: ${sessionId}`);
      }
    }
    return null;
  }
}
