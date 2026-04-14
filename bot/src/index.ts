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
import { config } from './config.js';

// ES Module dir resolution
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

let strategyInstance: Strategy | null = null;
let currentConfig = config; // 動的にリロード可能なコンフィグ保持用

async function bootstrap() {
  Logger.box('Bot Starting', 'Sui CLMM LP Auto Rebalance Bot Initialization');

  try {
    await Tracker.init();

    const priceMonitor = new PriceMonitor();
    const lpManager = new LpManager(priceMonitor);
    const hedgeManager = new HedgeManager();

    strategyInstance = new Strategy(priceMonitor, lpManager, hedgeManager);
  } catch (error) {
    Logger.error('Bot logic initialization failed.', error);
  }
}

// ============== API ENDPOINTS (UI BRIDGE) ============== //

app.post('/api/config', (req, res) => {
  try {
    const { privateKey, rangeWidth, hedgeRatio, telegramToken, telegramChatId } = req.body;
    
    // .env ファイルの生成と保存
    // 既存の他の設定項目も一旦固定値として再展開するか、読み込んでマージすべきですが、
    // ボットの起動に最低限必要な必須項目を保存します。
    const envPath = path.resolve(__dirname, '../../.env');
    let envContent = `PRIVATE_KEY=${privateKey || ''}\n`;
    envContent += `SUI_RPC_URL=https://fullnode.testnet.sui.io:443\n`;
    envContent += `LP_AMOUNT_USDC=500\n`;
    envContent += `RANGE_WIDTH=${(parseFloat(rangeWidth) / 100) || 0.05}\n`;
    envContent += `HEDGE_RATIO=${(parseFloat(hedgeRatio) / 100) || 0.5}\n`;
    envContent += `TELEGRAM_BOT_TOKEN=${telegramToken || ''}\n`;
    envContent += `TELEGRAM_CHAT_ID=${telegramChatId || ''}\n`;
    envContent += `MONITOR_INTERVAL_MS=60000\n`;
    envContent += `COOLDOWN_PERIOD_MS=600000\n`;

    fs.writeFileSync(envPath, envContent);
    Logger.success('Success: Configuration saved to .env from UI.');
    
    // プロセス再起動が望ましいですが、簡易的にリロードを試みる（またはユーザーに再起動を促す）
    Logger.info('Configuration updated. Please restart the backend if changes do not reflect.');
    
    res.json({ success: true, message: 'Settings saved securely. Please restart bot to apply changes.' });
  } catch (e: any) {
    Logger.error('Failed to save config', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/start', async (req, res) => {
  if (strategyInstance) {
    Logger.info('Start command received from UI.');
    await strategyInstance.start();
    res.json({ success: true, status: 'running' });
  } else {
    res.status(500).json({ success: false, error: 'Bot is not ready yet' });
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
  app.listen(3001, () => {
    Logger.success('API Server Running: http://localhost:3001');
  });
});
