import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Strategy } from './strategy.js';
import { PriceMonitor } from './modules/priceMonitor.js';
import { LpManager } from './modules/lpManager.js';
import { HedgeManager } from './modules/hedgeManager.js';
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
   * @param poolObjectId 運用対象のプールID（オプション）
   */
  static async createSession(sessionId: string, mnemonic: string | null = null, privateKey: string | null = null, walletAddress: string | null = null, poolObjectId: string | null = null): Promise<UserSession> {
    Logger.success(`Creating/Restoring session: ${sessionId} (Pool: ${poolObjectId || 'default'})`);

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
        
        // マスターキー使用時は、入力された sessionId にかかわらず、アドレスベースの固定IDを使用する
        const masterSessionId = `master-${masterAddress.slice(0, 8)}`;
        
        // メモリ上に既存のセッションがあればそれを返す
        const existingMasterSession = this.sessions.get(masterSessionId) || Array.from(this.sessions.values()).find(s => s.botWalletAddress === masterAddress);
        if (existingMasterSession) {
          Logger.info(`[SINGLETON] Reusing existing session [${existingMasterSession.sessionId}] for master wallet: ${masterAddress}`);
          return existingMasterSession;
        }

        // ここで sessionId をマスター用のものに上書き
        sessionId = masterSessionId;
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
      } else if (walletAddress) {
        const existingId = this.findSessionIdByWalletAndPool(walletAddress, poolObjectId || '');
        if (existingId) {
          Logger.success(`Found existing session [${existingId}] for wallet and pool.`);
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
            sessionKeypair = Ed25519Keypair.deriveKeypair(sessionMnemonic as string, "m/44'/784'/0'/0'/0'");
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
            sessionKeypair = Ed25519Keypair.deriveKeypair(sessionMnemonic, "m/44'/784'/0'/0'/0'");
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
            Logger.success(`Wallet restored from provided private key: ${sessionKeypair.getPublicKey().toSuiAddress()}`);
          } catch (e) {
            Logger.error('Failed to restore wallet from provided private key');
          }
        }
        
        if (!sessionKeypair) {
          // 完全新規生成
          sessionMnemonic = bip39.generateMnemonic(wordlist);
          sessionKeypair = Ed25519Keypair.deriveKeypair(sessionMnemonic, "m/44'/784'/0'/0'/0'");
          Logger.info(`Generated new dedicated wallet: ${sessionKeypair.getPublicKey().toSuiAddress()}`);
        }
      }
    }

    const targetSessionId = sessionId; // 互換性のため保持

    const botWalletAddress = sessionKeypair.getPublicKey().toSuiAddress();
    Logger.info(`Dedicated Bot Wallet generated: ${botWalletAddress}`);

    // セッション固有の設定（グローバル設定をコピー）
    const sessionConfig: BotConfig = { ...globalConfig, poolObjectId: poolObjectId || globalConfig.poolObjectId };

    // 各コンポーネントをインスタンス化
    const priceMonitor = new PriceMonitor(sessionConfig);
    const gasTracker = new GasTracker();
    const tracker = new Tracker(targetSessionId);
    await tracker.init();
    
    const pnlEngine = new PnlEngine();
    
    // LpManagerにキーペアとTrackerを注入
    const lpManager = new LpManager(priceMonitor, gasTracker, sessionConfig);
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
      tracker,
      sessionConfig,
      () => SessionManager.saveSessionState(targetSessionId),
      targetSessionId
    );

    // Strategyに秘密鍵を設定して初期化 (Bluefin等のセットアップを待機)
    await strategy.setPrivateKey(sessionKeypair.getSecretKey());

    // 保存された状態があれば復元
    const savedState = this.loadSessionState({ sessionId: targetSessionId, pnlEngine, gasTracker, hedgeManager, tracker, strategy });
    
    // 保存された設定がある場合、UIで変更したレンジ幅などを復元する
    if (savedState && savedState.config) {
      Object.assign(sessionConfig, savedState.config);

      // 戦略的に重要な接続・鍵設定は .env から最新化する
      sessionConfig.privateKey = globalConfig.privateKey;
      sessionConfig.lpAmountUsdc = globalConfig.lpAmountUsdc;
      sessionConfig.totalOperationalCapitalUsdc = globalConfig.totalOperationalCapitalUsdc;
      sessionConfig.hedgeMode = globalConfig.hedgeMode;
      sessionConfig.rpcUrl = globalConfig.rpcUrl;
      sessionConfig.rangeOrderWidthPct = savedState.config.rangeOrderWidthPct ?? savedState.config.rangeWidth ?? sessionConfig.rangeOrderWidthPct;
      sessionConfig.rangeWidth = savedState.config.rangeWidth ?? sessionConfig.rangeWidth;
      
      // コンポーネントに反映
      priceMonitor.refreshConfig(sessionConfig);
      lpManager.refreshConfig(sessionConfig);
      strategy.refreshConfig(sessionConfig);
      
      Logger.info(`Session [${targetSessionId}] config synced with latest .env values.`);
    }
    
    // ウォレット接続モード（デモ/読み取り専用）
    let finalWalletAddress = walletAddress || (savedState && savedState.walletAddress);
    if (!finalWalletAddress && privateKey) {
      finalWalletAddress = strategy.getWalletAddress();
    }
    if (!finalWalletAddress) {
      finalWalletAddress = botWalletAddress; // フォールバック
    }

    const session: UserSession = {
      sessionId: targetSessionId,
      walletAddress: finalWalletAddress,
      botWalletAddress: (savedState && savedState.botWalletAddress) || botWalletAddress,
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

    // ウォレットに関連する過去の履歴があれば統合（デバイス間での履歴共有を保証）
    if (session.walletAddress) {
      await this.consolidateWalletHistory(session.walletAddress, tracker, targetSessionId);
    }

    // 保存された状態で稼働中だった場合は自動開始
    if (session.strategy.isRunning) {
      Logger.info(`🚀 [AUTO-RESUME] Starting strategy for session ${targetSessionId}`);
      session.strategy.isRunning = false; // start()内部でtrueにされるため一度戻す
      await session.strategy.start();
    }

    // 新規作成時も即座に一度保存して鍵を確定させる
    this.saveSessionState(targetSessionId);

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
   * 全セッションを取得
   */
  static getAllSessions(): UserSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * ウォレットアドレスでセッションを検索
   */
  static getSessionByWallet(walletAddress: string): UserSession | null {
    return Array.from(this.sessions.values()).find(s => s.walletAddress === walletAddress || s.botWalletAddress === walletAddress) || null;
  }

  static getSessionByMnemonic(mnemonic: string): UserSession | null {
    return Array.from(this.sessions.values()).find(s => s.mnemonic === mnemonic) || null;
  }

  /**
   * ウォレットアドレスに関連するセッションをすべて取得
   */
  static listSessionsByWallet(walletAddress: string): UserSession[] {
    return Array.from(this.sessions.values()).filter(s => 
      (s.walletAddress && s.walletAddress.toLowerCase() === walletAddress.toLowerCase()) || 
      (s.botWalletAddress && s.botWalletAddress.toLowerCase() === walletAddress.toLowerCase())
    );
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
   * ウォレットに関連する全てのトラッカー履歴を統合する
   */
  public static async consolidateWalletHistory(walletAddress: string, currentTracker: Tracker, currentSessionId: string): Promise<void> {
    try {
      const files = fs.readdirSync(process.cwd());
      const histories: any[] = [];
      
      for (const file of files) {
        if (file.startsWith('session_state_') && file.endsWith('.json')) {
          const sid = file.replace('session_state_', '').replace('.json', '');
          if (sid === currentSessionId) continue;

          try {
            const state = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (state.walletAddress && state.walletAddress.toLowerCase() === walletAddress.toLowerCase()) {
              Logger.info(`Found historical session [${sid}] for wallet: ${walletAddress}`);
              const trackerFile = path.resolve(process.cwd(), `tracker_${sid}.json`);
              if (fs.existsSync(trackerFile)) {
                const trackerData = JSON.parse(fs.readFileSync(trackerFile, 'utf8'));
                if (trackerData.history && Array.isArray(trackerData.history)) {
                  histories.push(...trackerData.history);
                }
              } else if (state.tracker && state.tracker.history && Array.isArray(state.tracker.history)) {
                // トラッカーファイルがない場合、セッション状態内のデータを使用
                histories.push(...state.tracker.history);
              }

              // 統計データと残高履歴も統合
              if (fs.existsSync(trackerFile)) {
                const trackerData = JSON.parse(fs.readFileSync(trackerFile, 'utf8'));
                await currentTracker.mergeData(trackerData);
              } else if (state.tracker) {
                await currentTracker.mergeData(state.tracker);
              }
              Logger.info(`Successfully merged stats/history from session [${sid}]`);
            }
          } catch (e) {}
        }
      }

      if (histories.length > 0) {
        await currentTracker.mergeHistory(histories);
        Logger.info(`Successfully consolidated ${histories.length} historical events for wallet: ${walletAddress}`);
      }
    } catch (e) {
      Logger.warn(`Failed to consolidate wallet history: ${e}`);
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
    userWalletAddress?: string;
    botWalletAddress?: string;
    isRunning: boolean;
    createdAt: number;
  }> {
    const stats = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      stats.push({
        sessionId,
        walletAddress: session.walletAddress,
        userWalletAddress: session.walletAddress,
        botWalletAddress: session.botWalletAddress || session.walletAddress,
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
   * ウォレットアドレスとプールIDの組み合わせで既存セッションを探す
   */
  static findSessionIdByWalletAndPool(walletAddress: string, poolObjectId: string): string | null {
    const sessions = SessionManager.listSessionsByWallet(walletAddress);
    
    // 特定のプールIDに一致するセッションを探す
    const match = sessions.find(s => s.config.poolObjectId === poolObjectId);
    if (match) return match.sessionId;

    // 一致するものがない場合は、セッションファイルからも探す
    const files = fs.readdirSync(process.cwd());
    for (const file of files) {
      if (file.startsWith('session_state_') && file.endsWith('.json')) {
        try {
          const content = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (content.walletAddress === walletAddress && content.config?.poolObjectId === poolObjectId) {
            return file.replace('session_state_', '').replace('.json', '');
          }
        } catch (e) {}
      }
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
        sessionId: session.sessionId,
        pnl: session.pnlEngine.serialize(),
        gas: session.gasTracker.serialize(),
        hedge: session.hedgeManager.serialize(),
        tracker: session.tracker.serialize(), // Trackerデータを追加
        strategy: session.strategy.serialize(), // 戦略状態を追加
        botSecretKey: session.keypair.getSecretKey(),
        mnemonic: session.mnemonic,
        walletAddress: session.walletAddress,
        botWalletAddress: session.botWalletAddress,
        config: session.config,
        isRunning: session.strategy.isRunning,
        updatedAt: Date.now()
      };
      
      const filePath = path.resolve(process.cwd(), `session_state_${sessionId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
      Logger.info(`Session state saved (including secret key): ${sessionId}`);
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
