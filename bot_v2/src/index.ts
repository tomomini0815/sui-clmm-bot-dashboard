import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { requestSuiFromFaucetV0, getFaucetHost } from '@mysten/sui/faucet';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import crypto from 'crypto';

import { Logger } from './logger.js';
import { PriceMonitor } from './priceMonitor.js';
import { LpManager } from './lpManager.js';
import { HedgeManager } from './hedgeManager.js';
import { GasTracker } from './gasTracker.js';
import { PnlEngine } from './pnlEngine.js';
import { Strategy, CyclePhase } from './strategy.js';
import { Tracker } from './tracker.js';
import { config, BotConfig } from './config.js';
import { SessionManager } from './sessionManager.js';
import { globalTxQueue } from './walletTxQueue.js';

// ES Module dir resolution
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

/**
 * セッション固有の設定を更新し、コンポーネントに反映
 */
function refreshSessionComponents(sessionId: string, newConfig: BotConfig) {
  const session = SessionManager.getSession(sessionId);
  if (!session) return;

  session.config = newConfig;
  session.priceMonitor.refreshConfig(newConfig);
  session.lpManager.refreshConfig(newConfig);
  session.strategy.refreshConfig(newConfig);
  
  Logger.success(`Session [${sessionId}] components refreshed with new configuration.`);
}

async function bootstrap() {
  Logger.box('API Server Starting', 'Sui CLMM LP Auto Rebalance Bot V3');

  try {
    // セッションデータ保存タイマー (5分おきに全セッションを保存)
    setInterval(() => {
      const stats = SessionManager.getAllSessionsStats();
      for (const s of stats) {
        SessionManager.saveSessionState(s.sessionId);
      }
    }, 5 * 60 * 1000);

    // 【自動復帰】保存されているセッションをスキャンし、最新の運用中だったもののみを再開
    const files = fs.readdirSync(process.cwd());    // セッションファイルの一覧を取得
    const sessionFiles = files
      .filter(f => f.startsWith('session_state_') && f.endsWith('.json'))
      .map(f => {
        const sessionId = f.replace('session_state_', '').replace('.json', '');
        const trackerFile = `tracker_${sessionId}.json`;
        let trackerSize = 0;
        let isRunning = false;
        
        try {
          if (fs.existsSync(trackerFile)) {
            trackerSize = fs.statSync(trackerFile).size;
          }
          const content = JSON.parse(fs.readFileSync(f, 'utf8'));
          isRunning = content.isRunning === true;
        } catch (e) {}

        return {
          name: f,
          time: fs.statSync(f).mtime.getTime(),
          sessionId,
          trackerSize,
          isRunning
        };
      })
      // ソート順: 実行中のものを優先 > トラッカーサイズが大きいものを優先 > タイムスタンプが新しいものを優先
      .sort((a, b) => {
        if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
        if (Math.abs(a.trackerSize - b.trackerSize) > 500) return b.trackerSize - a.trackerSize;
        return b.time - a.time;
      });

    if (sessionFiles.length > 0) {
      Logger.info(`ℹ Found ${sessionFiles.length} session files. Selective resume starting...`);
      
      for (const sessionFile of sessionFiles) {
        const sid = sessionFile.sessionId.toLowerCase();
        // メインボット（master）と Bot2 のみを自動再開の対象にする
        const isTargetBot = sid.startsWith('master-') || sid.startsWith('bot2-');
        
        Logger.info(`[BOOTSTRAP] Checking session: ${sid} (Target: ${isTargetBot}, Running: ${sessionFile.isRunning})`);
        
        if (isTargetBot && (sessionFile.isRunning || sessionFile === sessionFiles[0])) {
          try {
            Logger.info(`🔄 Resuming target session: ${sid}`);
            const session = await SessionManager.createSession(sessionFile.sessionId);
            const actualSessionId = session.sessionId;

            // レンジ幅を 2% (0.02) に強制同期
            const TARGET_RANGE_WIDTH = 0.02;
            if (session.config.rangeWidth !== TARGET_RANGE_WIDTH) {
              Logger.info(`🎯 Overriding rangeWidth for ${sid} to 2%: ${TARGET_RANGE_WIDTH}`);
              session.config.rangeWidth = TARGET_RANGE_WIDTH;
              session.strategy.refreshConfig(session.config);
            }

            // Bot2 (DEEP/SUI) の場合はプールIDを強制セット（初期状態または旧IDの場合）
            if (sid.startsWith('bot2-')) {
              const DEEP_SUI_POOL_ID = '0xe01243f37f712ef87e556afb9b1d03d0fae13f96d324ec912daffc339dfdcbd2';
              if (session.config.poolObjectId !== DEEP_SUI_POOL_ID) {
                Logger.info(`🎯 Overriding poolObjectId for Bot2 to DEEP/SUI: ${DEEP_SUI_POOL_ID}`);
                session.config.poolObjectId = DEEP_SUI_POOL_ID;
                session.priceMonitor.refreshConfig(session.config);
                session.lpManager.refreshConfig(session.config);
              }
            }

            if (sessionFile.isRunning) {
              Logger.info(`🚀 [AUTO-RESUME] Starting strategy for session ${actualSessionId} (Background)`);
              session.strategy.isRunning = false;
              session.strategy.start().catch(err => {
                Logger.error(`Failed to background-start strategy for ${actualSessionId}`, err);
              });
            } else {
              Logger.info(`💤 [RESTORED] Session ${actualSessionId} loaded in IDLE state.`);
            }
          } catch (err) {
            Logger.error(`Failed to resume session: ${sessionFile.sessionId}`, err);
          }
        } else {
          Logger.info(`⏭ Skipping session: ${sid}`);
        }
      }
    }

    Logger.success('Bootstrap complete. API server is ready with Auto-Resume.');
  } catch (error) {
    Logger.error('Bootstrap failed.', error);
  }
}






// ============== API ENDPOINTS (MULTI-USER) ============== //

// セッション作成・ログイン
app.post('/api/session', async (req, res) => {
  Logger.info(`API Request: POST /api/session - Body: ${JSON.stringify(req.body)}`);
  try {
    const { privateKey, mnemonic, walletAddress, isWalletConnect } = req.body;
    
    // シードフレーズ（mnemonic）によるログイン/復旧
    if (mnemonic) {
      let session = await SessionManager.createSession(crypto.randomUUID(), mnemonic);
      
      Logger.success(`Session restored/started from mnemonic: ${session.botWalletAddress}`);
      
      return res.json({ 
        success: true, 
        sessionId: session.sessionId,
        walletAddress: session.walletAddress,
        botWalletAddress: session.botWalletAddress
      });
    }

    // ウォレット接続モード（Sui Walletから接続）
    if (isWalletConnect && walletAddress) {
      let session = SessionManager.getSessionByWallet(walletAddress);

      // 既存セッションがなければ新規作成
      if (!session) {
        Logger.info(`[WALLET CONNECT] No active session found for ${walletAddress}. Searching filesystem...`);
        // まずファイルシステムから検索
        const existingId = SessionManager.findSessionIdByWalletAddress(walletAddress);
        const sessionId = existingId || crypto.randomUUID();
        Logger.info(`[WALLET CONNECT] Selected SessionID: ${sessionId} (Found existing: ${!!existingId})`);
        session = await SessionManager.createSession(sessionId, null, null, walletAddress);
      }

      Logger.success(`Session started for wallet (WalletConnect): ${walletAddress}`);
      
      return res.json({ 
        success: true, 
        sessionId: session.sessionId,
        walletAddress: session.walletAddress,
        botWalletAddress: session.botWalletAddress
      });
    }
    
    // 従来の秘密鍵モード
    if (!privateKey || !privateKey.startsWith('suiprivkey')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid private key format or wallet address required' 
      });
    }

    // ウォレットアドレスで既存セッションを検索
    const decoded = decodeSuiPrivateKey(privateKey);
    const keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
    const addr = keypair.getPublicKey().toSuiAddress();

    let session = SessionManager.getSessionByWallet(addr);

    // 既存セッションがなければ新規作成
    if (!session) {
      const sessionId = crypto.randomUUID();
      session = await SessionManager.createSession(sessionId, privateKey as string);
    }

    Logger.success(`Session started for wallet: ${addr}`);
    
    res.json({ 
      success: true, 
      sessionId: session.sessionId,
      walletAddress: session.walletAddress,
      botWalletAddress: session.botWalletAddress
    });
  } catch (e: any) {
    Logger.error('Failed to create session', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 現在アクティブな全セッションを一覧表示 (デバッグ用)
app.get('/api/sessions/active', (req, res) => {
  const stats = SessionManager.getAllSessionsStats();
  res.json({
    success: true,
    count: stats.length,
    sessions: stats.map(session => ({
        sessionId: session.sessionId,
        walletAddress: session.walletAddress,
        isRunning: session.isRunning,
        createdAt: session.createdAt
      }))
  });
});

// セッション情報取得
app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = SessionManager.getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  res.json({
    success: true,
    sessionId: session.sessionId,
    walletAddress: session.walletAddress,
    botWalletAddress: session.botWalletAddress,
    isRunning: session.strategy.isRunning
  });
});

app.post('/api/config', async (req, res) => {
  try {
    const { 
      sessionId, 
      rangeWidth, 
      hedgeRatio, 
      lpAmountUsdc, 
      totalOperationalCapitalUsdc,
      telegramToken, 
      telegramChatId, 
      rpcUrl, 
      poolObjectId, 
      configMode,
      strategyMode,
      hedgeEnabled,
      backupPassword
    } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'Session ID required' });
    }

    const session = SessionManager.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // セッション固有の設定を構築
    const newConfig: BotConfig = {
      ...session.config,
      strategyMode: strategyMode || session.config.strategyMode,
      hedgeEnabled: (hedgeEnabled !== undefined) ? hedgeEnabled : session.config.hedgeEnabled,
      lpAmountUsdc: parseFloat(lpAmountUsdc) || session.config.lpAmountUsdc,
      totalOperationalCapitalUsdc: parseFloat(totalOperationalCapitalUsdc) || session.config.totalOperationalCapitalUsdc,
      rangeWidth: (parseFloat(rangeWidth) / 100) || session.config.rangeWidth,
      hedgeRatio: (parseFloat(hedgeRatio) / 100) || session.config.hedgeRatio,
      telegramToken: telegramToken || session.config.telegramToken,
      telegramChatId: telegramChatId || session.config.telegramChatId,
      rpcUrl: rpcUrl || session.config.rpcUrl,
      configMode: configMode || session.config.configMode,
      backupPassword: (backupPassword !== undefined) ? backupPassword : session.config.backupPassword
    };

    // グローバルなconfigオブジェクトも同期 (export-key endpointで使用)
    if (newConfig.backupPassword) {
      config.backupPassword = newConfig.backupPassword;
      
      // .env ファイルの更新
      try {
        const envPath = path.resolve(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
          let envContent = fs.readFileSync(envPath, 'utf8');
          if (envContent.includes('BACKUP_PASSWORD=')) {
            envContent = envContent.replace(/BACKUP_PASSWORD=.*/, `BACKUP_PASSWORD=${newConfig.backupPassword}`);
          } else {
            envContent += `\nBACKUP_PASSWORD=${newConfig.backupPassword}`;
          }
          fs.writeFileSync(envPath, envContent);
          Logger.info('BACKUP_PASSWORD updated in .env file');
        }
      } catch (e) {
        Logger.error('Failed to update .env file with new backup password', e);
      }
    }

    // セッションの設定を更新・反映
    refreshSessionComponents(sessionId, newConfig);
    
    // 戦略モードやヘッジ設定が変更された場合、即座にリバランス/クリーンアップを実行
    // ボットが停止していても、ヘッジをオフにした場合は決済が必要なため、強制的に実行するロジックに変更
    Logger.info(`Config updated via API. Triggering immediate reset/cleanup for session: ${sessionId}`);
    
    // 価格取得とリバランスの実行
    (async () => {
      try {
        const currentPrice = await session.priceMonitor.getCurrentPrice();
        await session.strategy.runRebalance(currentPrice, true);
        Logger.success(`Immediate reset/cleanup completed for session: ${sessionId}`);
      } catch (err) {
        Logger.error('Auto-rebalance/Cleanup after config update failed', err);
      }
    })();
    
    // 即座に永続化
    SessionManager.saveSessionState(sessionId);
    
    res.json({ success: true, message: 'Settings saved and applied to your session.' });
  } catch (e: any) {
    Logger.error('Failed to save config', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 専用ウォレットの秘密鍵をエクスポート
app.get('/api/export-key', (req, res) => {
  const { sessionId, password } = req.query;
  
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Session ID required' });
  }

  // バックアップ保護パスワードの検証
  if (!password || password !== config.backupPassword) {
    return res.status(401).json({ success: false, error: '不正なパスワードです。バックアップ情報を取得できません。' });
  }

  const session = SessionManager.getSession(sessionId as string);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  try {
    const suiprivkey = session.keypair.getSecretKey();
    
    res.json({ 
      success: true, 
      secretKey: suiprivkey,
      mnemonic: session.mnemonic, // シードフレーズ
      address: session.botWalletAddress,
      warning: 'この秘密鍵またはフレーズは絶対に他人に教えないでください。'
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ボット起動（セッション指定）
app.post('/api/start', async (req, res) => {
  const { sessionId } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Session ID required' });
  }

  const session = SessionManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  Logger.info('Start command received from UI.');
  await session.strategy.start();
  res.json({ success: true, status: 'running' });
});

// ボット停止（セッション指定）
app.post('/api/stop', async (req, res) => {
  const { sessionId } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Session ID required' });
  }

  const session = SessionManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  session.strategy.stop();
  res.json({ success: true, status: 'stopped' });
});

// 統計取得（セッション指定）
app.get('/api/stats', async (req, res) => {
  const sessionId = req.query.sessionId as string;
  Logger.info(`API Request: GET /api/stats - sessionId: ${sessionId}`);
  
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Session ID required' });
  }

  const session = SessionManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  try {
    const prices = session.priceMonitor.getPriceHistory();
    const stats = session.tracker.getStats();

    // セッションに紐づくインスタンスから現在のレンジを取得
    const lowerBound = session.strategy.currentLowerBound || 0;
    const upperBound = session.strategy.currentUpperBound || 0;

    // 市場状況を判定
    let marketCondition = 'sideways';
    if (prices.length >= 10) {
      const recentPrices = prices.slice(-10).map(p => p.price);
      const shortMA = recentPrices.reduce((a, b) => a + b, 0) / 10;
      const allPrices = prices.map(p => p.price);
      const longMA = allPrices.slice(-50).reduce((a, b) => a + b, 0) / Math.min(allPrices.length, 50);
      const currentPrice = prices[prices.length - 1].price;
      
      const deviation = Math.abs(shortMA - longMA) / longMA;
      
      if (deviation < 0.02) {
        marketCondition = 'sideways';
      } else if (shortMA > longMA && currentPrice > shortMA) {
        marketCondition = 'uptrend';
      } else {
        marketCondition = 'downtrend';
      }
    }

    // Pyth Oracle価格
    let pythPrice = 0;
    try {
      pythPrice = await session.priceMonitor.getPythPrice();
    } catch (e: any) {
      // silent
    }

    // === PnL/Delta/Gas データ ===
    let currentPrice = prices.length > 0 ? prices[prices.length - 1].price : 0;
    
    // 価格が未取得の場合は強制取得
    if (currentPrice <= 0) {
      session.strategy.currentPhase = CyclePhase.IDLE;
      currentPrice = await session.priceMonitor.getCurrentPrice();
    }

    // PnLデータを強制再計算
    const pnlData = await session.strategy.getPnlData(currentPrice);

    res.json({
      success: true,
      data: {
        ...stats,
        isRunning: session.strategy.isRunning,
        ...pnlData,
        botWalletAddress: session.botWalletAddress,
        userWalletAddress: session.walletAddress,
        network: session.config.rpcUrl.includes('testnet') ? 'testnet' : 'mainnet',
        config: session.config,
        priceHistory: prices,
        activityLogs: stats.history,
        currentRange: {
          lower: Number(lowerBound.toFixed(4)),
          upper: Number(upperBound.toFixed(4))
        },
        marketCondition,
        dailyPnl: pnlData?.pnl?.dailyPnl?.toFixed(4) || '0.00',
        pythPrice: pythPrice > 0 ? Number(pythPrice.toFixed(4)) : null,
        
        // ヘッジチャートと詳細表示のために明示的に追加
        hedge: pnlData?.hedge || null,
        dailySnapshots: pnlData?.dailySnapshots || [],
        pnl: pnlData?.pnl || null,
        delta: pnlData?.delta || null,

        // === 仕様書準拠: 安全ゲート状態 ===
        safetyGates: {
          drawdownPct: (() => {
            const totalValue = session.config.totalOperationalCapitalUsdc + (pnlData?.pnl?.netPnl ?? 0);
            const peak = Math.max(session.config.totalOperationalCapitalUsdc, totalValue);
            return peak > 0 ? ((peak - totalValue) / peak) * 100 : 0;
          })(),
          marginRatio: pnlData?.hedge?.active
            ? (pnlData.hedge.marginBalance / (pnlData.hedge.size || 1)) * 100
            : 999,
          priceDataAge: session.priceMonitor.getPriceDataAge?.() ?? 0,
          consecutiveErrors: (session.strategy as any).consecutiveErrors ?? 0,
          isEmergency: session.strategy.isEmergencyStopped,
        },

        // === 1時間サマリー ===
        hourlySummary: (session.strategy as any).lastHourlySummary ?? null,

        // === EMA・TWAP (Phase B/C判断用) ===
        trendInfo: null,
      }

    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/stop', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Session ID required' });
  }
  const session = SessionManager.getSession(sessionId);
  if (session) {
    Logger.info(`Stop command received from UI for session: ${sessionId}`);
    session.strategy.stop();
    res.json({ success: true, status: 'stopped' });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});


// === 追加：市場レジーム・アドバイザー用エンドポイント ===
app.get('/api/market-regime', (req, res) => {
  const sessions = SessionManager.getAllSessions();
  if (sessions.length === 0) return res.json({ success: false, message: 'No active session' });
  
  const master = sessions[0];
  const priceHistory = master.priceMonitor.getPriceHistory();
  const price = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].price : 0;
  res.json({
    success: true,
    data: {
      price,
      volatility: 'NORMAL',
      volatilityPct: 0.5,
      trend: 'SIDEWAYS',
      ema20: price,
      ema50: price,
      timestamp: Date.now()
    }
  });
});

// Bot2ステータス専用 (後方互換用)
app.get('/api/bot2/status', async (req, res) => {
  const sessions = SessionManager.getAllSessions();
  const bot2 = sessions.find(s => s.sessionId.toLowerCase().startsWith('bot2-'));
  
  if (!bot2) return res.json({ success: false, message: 'Bot2 session not found' });
  
  const stats = bot2.tracker.getStats();
  const currentPrice = await bot2.priceMonitor.getCurrentPrice();
  const pnlData = await bot2.strategy.getPnlData(currentPrice);
  
  res.json({ 
    success: true, 
    sessionId: bot2.sessionId,
    active: bot2.strategy.isRunning,
    pool: 'DEEP/SUI', // Bot2はDEEP/SUIペアとして表示
    currentPrice,
    currentRange: {
      lower: bot2.strategy.currentLowerBound,
      upper: bot2.strategy.currentUpperBound
    },
    phase: bot2.strategy.currentPhase,
    tracker: stats,
    ...pnlData
  });
});


app.post('/api/faucet', async (req, res) => {
  try {
    const { privateKey } = req.body;
    if (!privateKey) throw new Error("Private key is required");

    let keypair: Ed25519Keypair;
    try {
      if (privateKey.startsWith('suiprivkey')) {
        const { secretKey } = decodeSuiPrivateKey(privateKey);
        keypair = Ed25519Keypair.fromSecretKey(secretKey);
      } else {
        const pkHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
        keypair = Ed25519Keypair.deriveKeypairFromSeed(pkHex);
      }
    } catch (e: any) {
      Logger.error(`Invalid Private Key format received: ${e.message}`);
      return res.status(400).json({ success: false, error: 'Invalid Private Key format' });
    }
    
    const address = keypair.getPublicKey().toSuiAddress();
    Logger.info(`Faucet request initiated for address: ${address}`);

    try {
      const faucetStatus = await requestSuiFromFaucetV0({
        host: getFaucetHost('testnet'),
        recipient: address,
      });
      Logger.success(`Faucet request successful for ${address}`);
      res.json({ success: true, message: 'Testnet SUI requested successfully' });
    } catch (faucetErr: any) {
      Logger.error(`Faucet Service Error: ${faucetErr.message}`);
      res.status(500).json({ success: false, error: faucetErr.message || 'Faucet service is currently unavailable' });
    }
  } catch (error: any) {
    Logger.error('Internal Server Error in /api/faucet', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 予期せぬエラーのハンドリング
process.on('uncaughtException', (err) => {
  Logger.error('Uncaught Exception occurred:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  Logger.error('Unhandled Rejection at:', reason);
});

// Render/Fly.io Health Check Endpoint (Early Registration)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

console.log('DEBUG: Starting API Server...');
const port = parseInt(process.env.PORT || '3002', 10);
const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';

app.listen(port, host, () => {
  Logger.success(`API Server Running: http://${host}:${port}`);
  
  // Start bot logic in background to avoid health check timeout
  console.log('DEBUG: Starting background bootstrap...');
  bootstrap().then(() => {
    Logger.info('Bot Bootstrap completed successfully.');
  }).catch(err => {
    Logger.error('DEBUG: Bootstrap ERROR:', err);
  });
});
