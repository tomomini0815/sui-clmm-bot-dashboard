import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
    // 念のため開始時にもリロード
    refreshAllComponents();
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

    res.json({
      success: true,
      data: {
        totalPnl: stats.totalPnl.toFixed(2),
        totalFees: stats.totalFees.toFixed(4),
        totalRebalances: stats.totalRebalances,
        isRunning: strategyInstance ? strategyInstance.isRunning : false,
        walletAddress,
        priceHistory: prices,
        activityLogs: stats.history.map(h => ({
          time: new Date(h.timestamp).toLocaleTimeString('ja-JP'),
          action: 'Rebalance',
          details: `SUI ${h.price.toFixed(4)} USDC | Fee: +${h.fee.toFixed(4)}`,
          status: 'Success'
        })).slice(-20).reverse(), // 直近20件を新しい順で
        currentRange: {
          lower: Number(lowerBound.toFixed(4)),
          upper: Number(upperBound.toFixed(4))
        },
        config: {
          lpAmountUsdc: config.lpAmountUsdc,
          rangeWidth: config.rangeWidth,
          hedgeRatio: config.hedgeRatio
        }
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

// 起動開始
bootstrap().then(() => {
  const port = config.apiPort;
  app.listen(port, () => {
    Logger.success(`API Server Running: port ${port}`);
  });
});
