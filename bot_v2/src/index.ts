import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { getFaucetHost, requestSuiFromFaucetV0 } from '@mysten/sui/faucet';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import crypto from 'crypto';

import { Logger } from './logger.js';
import { PriceMonitor } from './priceMonitor.js';
import { LpManager } from './lpManager.js';
import { HedgeManager } from './hedgeManager.js';
import { GasTracker } from './gasTracker.js';
import { PnlEngine } from './pnlEngine.js';
import { Strategy } from './strategy.js';
import { Tracker } from './tracker.js';
import { config, reloadConfig, updateConfigReference } from './config.js';
import { SessionManager } from './sessionManager.js';

// ES Module dir resolution
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

let strategyInstance: Strategy | null = null;
let priceMonitorInstance: PriceMonitor | null = null;
let lpManagerInstance: LpManager | null = null;
let hedgeManagerInstance: HedgeManager | null = null;
let gasTrackerInstance: GasTracker | null = null;
let pnlEngineInstance: PnlEngine | null = null;

function refreshAllComponents() {
  // .envファイルを再読み込み
  dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });
  
  const newConfig = reloadConfig();
  updateConfigReference(newConfig);
  
  if (priceMonitorInstance) priceMonitorInstance.refreshConfig();
  if (lpManagerInstance) lpManagerInstance.refreshConfig();
  if (strategyInstance) strategyInstance.refreshConfig();
  
  Logger.success('All components refreshed with new configuration.');
}

async function bootstrap() {
  Logger.box('Bot Starting', 'Sui CLMM LP Auto Rebalance Bot V3 — Profit Optimized');

  try {
    await Tracker.init();

    // PnLデータの復元
    const pnlDataPath = path.resolve(process.cwd(), 'pnl_data.json');
    
    priceMonitorInstance = new PriceMonitor();
    gasTrackerInstance = new GasTracker();
    pnlEngineInstance = new PnlEngine();

    // PnL状態復元
    try {
      if (fs.existsSync(pnlDataPath)) {
        const pnlData = JSON.parse(fs.readFileSync(pnlDataPath, 'utf-8'));
        pnlEngineInstance.restore(pnlData);
      }
    } catch (e) {
      Logger.warn('PnLデータの復元に失敗');
    }

    lpManagerInstance = new LpManager(priceMonitorInstance, gasTrackerInstance);
    hedgeManagerInstance = new HedgeManager(config.hedgeMode);

    strategyInstance = new Strategy(
      priceMonitorInstance,
      lpManagerInstance,
      hedgeManagerInstance,
      gasTrackerInstance,
      pnlEngineInstance
    );

    // 定期的にPnLデータを保存 (30秒ごと)
    setInterval(() => {
      if (pnlEngineInstance) {
        try {
          fs.writeFileSync(pnlDataPath, JSON.stringify(pnlEngineInstance.serialize(), null, 2));
        } catch (e) {
          // 静かに無視
        }
      }
    }, 30000);

  } catch (error) {
    Logger.error('Bot logic initialization failed.', error);
  }
}

// ============== API ENDPOINTS (MULTI-USER) ============== //

// セッション作成・ログイン
app.post('/api/session', async (req, res) => {
  try {
    const { privateKey } = req.body;
    
    if (!privateKey || !privateKey.startsWith('suiprivkey')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid private key format' 
      });
    }

    // ウォレットアドレスで既存セッションを検索
    const decoded = decodeSuiPrivateKey(privateKey);
    const keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
    const walletAddress = keypair.getPublicKey().toSuiAddress();

    let session = SessionManager.getSessionByWallet(walletAddress);

    // 既存セッションがなければ新規作成
    if (!session) {
      const sessionId = crypto.randomUUID();
      session = await SessionManager.createSession(sessionId, privateKey);
    }

    Logger.success(`Session started for wallet: ${walletAddress}`);
    
    res.json({ 
      success: true, 
      sessionId: session.sessionId,
      walletAddress: session.walletAddress
    });
  } catch (e: any) {
    Logger.error('Failed to create session', e);
    res.status(500).json({ success: false, error: e.message });
  }
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
    isRunning: session.strategy.isRunning
  });
});

app.post('/api/config', (req, res) => {
  try {
    const { privateKey, rangeWidth, hedgeRatio, lpAmountUsdc, telegramToken, telegramChatId, rpcUrl, poolObjectId } = req.body;
    
    // .env ファイルの生成と保存
    const envPath = path.resolve(__dirname, '../../.env');
    let envContent = `PRIVATE_KEY=${privateKey || ''}\n`;
    envContent += `SUI_RPC_URL=${rpcUrl || 'https://fullnode.mainnet.sui.io'}\n`;
    envContent += `POOL_OBJECT_ID=${poolObjectId || ''}\n`;
    envContent += `LP_AMOUNT_USDC=${parseFloat(lpAmountUsdc) || 0.10}\n`;
    envContent += `RANGE_WIDTH=${(parseFloat(rangeWidth) / 100) || 0.05}\n`;
    envContent += `HEDGE_RATIO=${(parseFloat(hedgeRatio) / 100) || 0.5}\n`;
    envContent += `TELEGRAM_BOT_TOKEN=${telegramToken || ''}\n`;
    envContent += `TELEGRAM_CHAT_ID=${telegramChatId || ''}\n`;
    envContent += `MONITOR_INTERVAL_MS=30000\n`;
    envContent += `COOLDOWN_PERIOD_MS=300000\n`;
    envContent += `FEE_COLLECT_INTERVAL_MS=300000\n`;
    envContent += `MIN_PROFIT_FOR_REBALANCE=0.005\n`;
    envContent += `HEDGE_MODE=simulate\n`;

    fs.writeFileSync(envPath, envContent);
    Logger.success('Success: Configuration saved to .env from UI.');
    
    // 即座に読み込み
    refreshAllComponents();
    
    res.json({ success: true, message: 'Settings saved and applied successfully.' });
  } catch (e: any) {
    Logger.error('Failed to save config', e);
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
  
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Session ID required' });
  }

  const session = SessionManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  try {
    const stats = Tracker.getStats();
    const prices = session.priceMonitor.getPriceHistory();

    // Strategy から現在のレンジを取得
    const lowerBound = strategyInstance ? strategyInstance.currentLowerBound : 0;
    const upperBound = strategyInstance ? strategyInstance.currentUpperBound : 0;

    // ウォレットアドレスを取得
    const walletAddress = lpManagerInstance ? lpManagerInstance.getWalletAddress() : '';

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
      if (priceMonitorInstance) {
        pythPrice = await priceMonitorInstance.getPythPrice();
      }
    } catch (e: any) {
      // silent
    }

    // === 新機能: PnL/Delta/Gas データ ===
    const currentPrice = prices.length > 0 ? prices[prices.length - 1].price : 0;
    let pnlData = null;
    if (strategyInstance && currentPrice > 0) {
      pnlData = strategyInstance.getPnlData(currentPrice);
    }

    res.json({
      success: true,
      data: {
        ...stats,
        isRunning: strategyInstance ? strategyInstance.isRunning : false,
        walletAddress,
        priceHistory: prices,
        activityLogs: stats.history,
        currentRange: {
          lower: Number(lowerBound.toFixed(4)),
          upper: Number(upperBound.toFixed(4))
        },
        config: {
          lpAmountUsdc: config.lpAmountUsdc,
          rangeWidth: config.rangeWidth,
          hedgeRatio: config.hedgeRatio
        },
        marketCondition,
        avgHoldingTime: stats.totalRebalances > 0 ? '15分' : '0分',
        dailyPnl: pnlData?.pnl?.dailyPnl?.toFixed(4) || '0.00',
        pythPrice: pythPrice > 0 ? Number(pythPrice.toFixed(4)) : null,

        // === 新データ ===
        pnl: pnlData?.pnl || null,
        delta: pnlData?.delta || null,
        gasStats: pnlData?.gasStats || null,
        hedge: pnlData?.hedge || null,
        indicators: pnlData ? {
          rsi: pnlData.rsi,
          volatility: pnlData.volatility,
          trend: pnlData.trend,
        } : null,
        dailySnapshots: pnlData?.dailySnapshots || [],
      }
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/stop', (req, res) => {
  if (strategyInstance) {
    Logger.info('Stop command received from UI.');
    strategyInstance.stop();
    res.json({ success: true, status: 'stopped' });
  } else {
    res.status(500).json({ success: false, error: 'Bot is not ready yet' });
  }
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

// Renderのヘルスチェック用エンドポイント
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 起動開始
bootstrap().then(() => {
  const port = parseInt(process.env.PORT || '3002', 10);
  app.listen(port, '0.0.0.0', () => {
    Logger.success(`API Server Running: port ${port}`);
  });
});
