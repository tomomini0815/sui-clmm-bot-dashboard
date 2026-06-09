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

import { Logger } from './modules/logger.js';
import { PriceMonitor } from './modules/priceMonitor.js';
import { LpManager } from './modules/lpManager.js';
import { HedgeManager } from './modules/hedgeManager.js';
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
      const latest = sessionFiles[0];
      const sessionId = latest.sessionId;
      
      Logger.info(`ℹ Auto-resuming most relevant session: ${sessionId} (Running: ${latest.isRunning}, Tracker: ${latest.trackerSize} bytes)`);
      
      const session = await SessionManager.createSession(sessionId);
      const actualSessionId = session.sessionId; // 確定後のIDを取得

      if (session.strategy.isRunning) {
        Logger.info(`🚀 [AUTO-RESUME] Starting strategy for session ${actualSessionId}`);
        session.strategy.isRunning = false;
        await session.strategy.start();
      }

      // 他の古いセッションはスキップ
      if (sessionFiles.length > 1) {
        Logger.warn(`Skipped ${sessionFiles.length - 1} older session files to prevent competition.`);
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
  try {
    const { mnemonic, privateKey, walletAddress, isWalletConnect, poolObjectId } = req.body;
    let sessionId = req.body.sessionId;
    
    // 1. ウォレット接続モード (ブラウザウォレット使用)
    if (isWalletConnect && walletAddress) {
      // デバイスが変わっても同一セッションを復元できるよう、ウォレットアドレスから決定論的なIDを生成
      if (!sessionId) {
        const addrSuffix = walletAddress.slice(-6);
        const poolSuffix = (poolObjectId || 'default').slice(-6);
        sessionId = `wallet-${addrSuffix}-${poolSuffix}`;
      }
      
      let session = SessionManager.findSessionIdByWalletAndPool(walletAddress, poolObjectId || '');

      // 既存セッションがなければ新規作成
      if (!session) {
        const newSession = await SessionManager.createSession(sessionId, null, null, walletAddress, poolObjectId);
        session = newSession.sessionId;
      }

      const existing = SessionManager.getSession(session);
      if (!existing) {
         // メモリにない場合はロード
         await SessionManager.createSession(session, null, null, walletAddress, poolObjectId);
      } else {
         // メモリにある場合も履歴の再統合を試みる（最新化）
         await SessionManager.consolidateWalletHistory(walletAddress, existing.tracker, existing.sessionId);
      }
      
      const s = SessionManager.getSession(session)!;
      Logger.success(`Session started (WalletConnect): ${walletAddress} Pool: ${poolObjectId || 'default'}`);
      
      return res.json({ 
        success: true, 
        sessionId: s.sessionId,
        walletAddress: s.walletAddress,
        botWalletAddress: s.botWalletAddress,
        mnemonic: s.mnemonic 
      });
    }

    // 2. 直接運用モード (秘密鍵 または シードフレーズ)
    if (mnemonic || privateKey) {
      if (!sessionId) sessionId = crypto.randomUUID();
      let session = mnemonic ? SessionManager.getSessionByMnemonic(mnemonic) : null;
      
      if (!session && privateKey) {
         try {
           const { secretKey } = privateKey.startsWith('suiprivkey') 
             ? decodeSuiPrivateKey(privateKey)
             : { secretKey: Buffer.from(privateKey.replace('0x', ''), 'hex') };
           const keypair = Ed25519Keypair.fromSecretKey(secretKey);
           const addr = keypair.getPublicKey().toSuiAddress();
           session = SessionManager.getSessionByWallet(addr);
         } catch (e) {}
      }

      if (!session) {
        session = await SessionManager.createSession(sessionId, mnemonic || null, privateKey || null, null, poolObjectId);
      }

      Logger.success(`Session started (Direct): ${session.sessionId} Pool: ${poolObjectId || 'default'}`);
      
      return res.json({ 
        success: true, 
        sessionId: session.sessionId,
        walletAddress: session.walletAddress,
        botWalletAddress: session.botWalletAddress,
        mnemonic: session.mnemonic 
      });
    }

    return res.status(400).json({ 
      success: false, 
      error: 'Invalid request. Mnemonic, private key, or wallet address required.' 
    });

  } catch (e: any) {
    Logger.error('Failed to create session', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ウォレットに関連付けられたセッション一覧（または全てのセッション）
app.get('/api/sessions', (req, res) => {
  const { walletAddress } = req.query;

  // メモリ上とファイル上の両方から検索
  let activeSessions = [];
  if (walletAddress) {
    activeSessions = SessionManager.listSessionsByWallet(walletAddress as string);
  } else {
    activeSessions = SessionManager.getAllSessions();
  }
  
  // ファイルからもスキャンして統合
  const allSessions: any[] = [...activeSessions.map(s => ({
    sessionId: s.sessionId,
    poolObjectId: s.config.poolObjectId,
    isRunning: s.strategy.isRunning,
    botWalletAddress: s.botWalletAddress,
    createdAt: s.createdAt
  }))];

  const files = fs.readdirSync(process.cwd());
  for (const file of files) {
    if (file.startsWith('session_state_') && file.endsWith('.json')) {
      try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!walletAddress || state.walletAddress === walletAddress) {
          // 重複チェック
          if (!allSessions.find(s => s.sessionId === state.sessionId)) {
            allSessions.push({
              sessionId: state.sessionId,
              poolObjectId: state.config?.poolObjectId,
              isRunning: state.isRunning,
              botWalletAddress: state.botWalletAddress,
              createdAt: state.createdAt
            });
          }
        }
      } catch (e) {}
    }
  }

  res.json({ success: true, sessions: allSessions });
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
      rangeOrderWidthPct: (parseFloat(rangeWidth) / 100) || session.config.rangeOrderWidthPct,
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
    
    // 設定はリフレッシュ済み。次のサイクルから新設定が自動的に適用される。
    // 注意: 設定変更時に強制リバランスを実行すると、レンジ内であっても
    // 不要なオンチェーン取引が発生してガス・スリップページの損失が生じるため、
    // ここでは意図的にオンチェーン操作を行わない。
    if (session.strategy.isRunning) {
      Logger.info(`[CONFIG] 設定を更新しました (strategyMode: ${newConfig.strategyMode})。次のサイクルから新設定が適用されます。`);
    }
    
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

// 両ボットを即座にフェーズAにリセットして全資金再配置
app.post('/api/rebuild', async (req, res) => {
  const { sessionId, rangeWidth } = req.body;

  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Session ID required' });
  }

  const session = SessionManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  try {
    // レンジ幅が指定されていれば設定を更新
    if (rangeWidth) {
      const newRangeWidth = parseFloat(rangeWidth) / 100;
      const newConfig = { ...session.config, strategyMode: 'range_order' as const, hedgeEnabled: false, rangeWidth: newRangeWidth, rangeOrderWidthPct: newRangeWidth };
      session.config = newConfig;
      session.strategy.refreshConfig(newConfig);
      Logger.info(`[REBUILD] レンジ幅を ${rangeWidth}% に更新しました。`);
    }

    // 強制再配置中は通常サイクルを止め、完了後に稼働状態へ戻す
    session.strategy.stop();
    const currentPrice = await session.priceMonitor.getCurrentPrice();
    await session.strategy.runRebalance(currentPrice, true);
    await session.strategy.start();
    SessionManager.saveSessionState(sessionId);

    res.json({ success: true, status: 'running', message: '両ボットの全資金再配置が完了し、Botを起動しました。' });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ボットを再起動し、両ボット合計8ポジションを現在価格基準で再配置
app.post('/api/restart-rebuild', async (req, res) => {
  const { sessionId, rangeWidth } = req.body;

  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Session ID required' });
  }

  const session = SessionManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  try {
    const newRangeWidth = rangeWidth ? parseFloat(rangeWidth) / 100 : session.config.rangeOrderWidthPct || session.config.rangeWidth;
    const newConfig = {
      ...session.config,
      strategyMode: 'range_order' as const,
      hedgeEnabled: false,
      rangeWidth: newRangeWidth,
      rangeOrderWidthPct: newRangeWidth,
    };
    session.config = newConfig;
    session.strategy.refreshConfig(newConfig);
    Logger.info(`[RESTART_REBUILD] 指値レンジ戦略でレンジ幅を ${(newRangeWidth * 100).toFixed(2)}% に更新しました。`);

    Logger.info(`[RESTART_REBUILD] Bot再起動と8ポジション再配置を開始します。session=${sessionId}`);
    session.strategy.stop();
    await new Promise(resolve => setTimeout(resolve, 1000));

    const currentPrice = await session.priceMonitor.getCurrentPrice();
    await session.strategy.runRebalance(currentPrice, true);
    await session.strategy.start();

    SessionManager.saveSessionState(sessionId);
    res.json({ success: true, status: 'running', message: 'Botを再起動し、8ポジションの再配置が完了しました。' });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 統計取得（セッション指定）
app.get('/api/stats', async (req, res) => {
  const sessionId = req.query.sessionId as string;
  
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
    const pnlData = await session.strategy.getPnlData(currentPrice, session.walletAddress);

    // Bot1の偏り判定 (isUnbalanced)
    let isUnbalanced = false;
    try {
      const p1 = session.strategy.bot1.state;
      const posIds1 = [p1.lpPositionIdBelow1, p1.lpPositionIdBelow2, p1.lpPositionIdAbove1, p1.lpPositionIdAbove2].filter(Boolean) as string[];
      if (posIds1.length === 4) {
        const posValues1: number[] = [];
        for (const id of posIds1) {
          const details = await session.strategy.bot1.lpManager.getPositionDetails(id).catch(() => null);
          posValues1.push(details?.usdValue || 0);
        }
        const maxVal1 = Math.max(...posValues1);
        const minVal1 = Math.min(...posValues1);
        if (maxVal1 > 0.3 && (minVal1 / maxVal1 < 0.4)) {
          isUnbalanced = true;
        }
      }
    } catch (e) {}

    res.json({
      success: true,
      data: {
        ...stats,
        isRunning: session.strategy.isRunning,
        isUnbalanced,
        currentPrice: currentPrice,
        ...pnlData,
        currentPhase: session.strategy.currentPhase,
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
        trendInfo: (() => {
          try {
            return session.priceMonitor.evaluateTrend?.() ?? null;
          } catch { return null; }
        })(),
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
  const volatility = master.strategy.calculateVolatility() * 100;
  const trend = master.strategy.detectTrend();
  
  res.json({
    success: true,
    data: {
      price,
      volatility: volatility > 2.0 ? 'HIGH' : volatility > 0.5 ? 'NORMAL' : 'LOW',
      volatilityPct: volatility,
      trend,
      ema20: price * 0.998, // 簡易
      ema50: price * 0.995, // 簡易
      timestamp: Date.now()
    }
  });
});

// Bot2ステータス専用 (後方互換用)
app.get('/api/bot2/status', async (req, res) => {
  const sessions = SessionManager.getAllSessions();
  if (sessions.length === 0) {
    return res.json({ success: false, message: 'No active session' });
  }
  const session = sessions[0];
  const bot2 = session.strategy.bot2;
  if (!bot2) {
    return res.json({ success: false, message: 'Bot2 instance not found in strategy' });
  }

  try {
    const currentPrice = await bot2.priceMonitor.getCurrentPrice().catch(() => 0);
    
    // LP価値の取得
    let lpValue = 0;
    const p2 = bot2.state;
    const posValues: number[] = [];
    
    if (session.config.strategyMode === 'range_order') {
      const posIds = [p2.lpPositionIdBelow1, p2.lpPositionIdBelow2, p2.lpPositionIdAbove1, p2.lpPositionIdAbove2].filter(Boolean) as string[];
      for (const id of posIds) {
        const details = await bot2.lpManager.getPositionDetails(id).catch(() => null);
        const val = details?.usdValue || 0;
        lpValue += val;
        posValues.push(val);
      }
    } else {
      const lpDetails = p2.lpPositionId 
        ? await bot2.lpManager.getPositionDetails(p2.lpPositionId).catch(() => null)
        : null;
      lpValue = lpDetails?.usdValue || 0;
    }

    const maxVal = posValues.length > 0 ? Math.max(...posValues) : 0;
    const minVal = posValues.length > 0 ? Math.min(...posValues) : 0;
    const isUnbalanced = posValues.length === 4 && maxVal > 0.3 && (minVal / maxVal < 0.4);

    res.json({
      success: true,
      active: session.strategy.isRunning,
      isUnbalanced,
      pool: 'DEEP/SUI',
      poolId: bot2.lpManager.config.poolObjectId,
      maxCapitalUsdc: p2.totalCapital || 3,
      currentPrice: currentPrice,
      currentRange: {
        lower: p2.rangeLower || 0,
        upper: p2.rangeUpper || 0
      },
      tracker: {
        rebalanceCount: p2.rebalanceCount24h || 0,
        totalFeesEarned: 0,
        successfulRebalances: p2.rebalanceCount24h || 0,
        history: []
      },
      pnl: {
        netPnl: 0,
        bot2LpValue: lpValue
      },
      phase: p2.phase,
      message: session.strategy.isRunning ? '稼働中 (監視)' : '停止中'
    });
  } catch (e: any) {
    res.json({ success: false, message: e.message });
  }
});

// Bot3ステータス専用 (後方互換用)
app.get('/api/bot3/status', (req, res) => {
  const stats = SessionManager.getAllSessionsStats();
  if (stats.length < 3) return res.json({ success: false, message: 'Bot3 not running' });
  res.json({ success: true, ...stats[2] });
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
app.listen(port, '0.0.0.0', () => {
  Logger.success(`API Server Running: port ${port}`);
  
  // Start bot logic in background to avoid health check timeout
  console.log('DEBUG: Starting background bootstrap...');
  bootstrap().then(() => {
    Logger.info('Bot Bootstrap completed successfully.');
  }).catch(err => {
    Logger.error('DEBUG: Bootstrap ERROR:', err);
  });
});
