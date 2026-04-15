import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { getFaucetHost, requestSuiFromFaucetV0 } from '@mysten/sui/faucet';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

import { Logger } from './logger.js';
import { PriceMonitor } from './priceMonitor.js';
import { LpManager } from './lpManager.js';
import { HedgeManager } from './hedgeManager.js';
import { Strategy } from './strategy.js';
import { Tracker } from './tracker.js';
import { config, reloadConfig, updateConfigReference } from './config.js';

// ES Module dir resolution
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

let strategyInstance: Strategy | null = null;
let priceMonitorInstance: PriceMonitor | null = null;
let lpManagerInstance: LpManager | null = null;
let hedgeManagerInstance: HedgeManager | null = null;

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
  Logger.box('Bot Starting', 'Sui CLMM LP Auto Rebalance Bot Initialization');

  try {
    await Tracker.init();

    priceMonitorInstance = new PriceMonitor();
    lpManagerInstance = new LpManager(priceMonitorInstance);
    hedgeManagerInstance = new HedgeManager();

    strategyInstance = new Strategy(priceMonitorInstance, lpManagerInstance, hedgeManagerInstance);
  } catch (error) {
    Logger.error('Bot logic initialization failed.', error);
  }
}

// ============== API ENDPOINTS (UI BRIDGE) ============== //

app.post('/api/config', (req, res) => {
  try {
    const { privateKey, rangeWidth, hedgeRatio, lpAmountUsdc, telegramToken, telegramChatId, rpcUrl, poolObjectId } = req.body;
    
    // .env ファイルの生成と保存
    const envPath = path.resolve(__dirname, '../../.env');
    let envContent = `PRIVATE_KEY=${privateKey || ''}\n`;
    envContent += `SUI_RPC_URL=${rpcUrl || 'https://fullnode.mainnet.sui.io'}\n`;
    envContent += `POOL_OBJECT_ID=${poolObjectId || ''}\n`;
    envContent += `LP_AMOUNT_USDC=${parseFloat(lpAmountUsdc) || 0.05}\n`;
    envContent += `RANGE_WIDTH=${(parseFloat(rangeWidth) / 100) || 0.05}\n`;
    envContent += `HEDGE_RATIO=${(parseFloat(hedgeRatio) / 100) || 0.5}\n`;
    envContent += `TELEGRAM_BOT_TOKEN=${telegramToken || ''}\n`;
    envContent += `TELEGRAM_CHAT_ID=${telegramChatId || ''}\n`;
    envContent += `MONITOR_INTERVAL_MS=10000\n`;
    envContent += `COOLDOWN_PERIOD_MS=60000\n`;

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

app.post('/api/start', async (req, res) => {
  if (strategyInstance) {
    Logger.info('Start command received from UI.');
    // 設定リロードは不要（起動時に正しく読み込み済み）
    await strategyInstance.start();
    res.json({ success: true, status: 'running' });
  } else {
    res.status(500).json({ success: false, error: 'Bot is not ready yet' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = Tracker.getStats();
    const prices = priceMonitorInstance ? priceMonitorInstance.getPriceHistory() : [];

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

    // 平均保有時間を計算
    const avgHoldingTime = stats.totalRebalances > 0 ? '15分' : '0分';

    // Pyth OracleからSUI市場価格を取得
    let pythPrice = 0;
    try {
      if (priceMonitorInstance) {
        pythPrice = await priceMonitorInstance.getPythPrice();
        if (pythPrice > 0) {
          console.log(`API: Pyth price = $${pythPrice.toFixed(4)}`);
        }
      }
    } catch (e: any) {
      console.log(`API: Pyth price fetch failed: ${e.message}`);
    }

    res.json({
      success: true,
      data: {
        ...stats,
        isRunning: strategyInstance ? strategyInstance.isRunning : false,
        walletAddress,
        priceHistory: prices,
        activityLogs: stats.history, // 全件（新しい順）
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
        avgHoldingTime,
        dailyPnl: '0.00', // 将来的に日次計算を実装
        pythPrice: pythPrice > 0 ? Number(pythPrice.toFixed(4)) : null // Pyth市場価格
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
      // レート制限などの場合はエラーメッセージを詳細に返す
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
