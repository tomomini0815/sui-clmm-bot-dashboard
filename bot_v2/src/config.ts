import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Logger } from './logger.js';

// ES Module dir resolution
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .envファイルのパスを明示的に指定（bot_v2の親ディレクトリ）
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

export interface BotConfig {
  privateKey?: string;
  rpcUrl: string;
  telegramToken?: string;
  telegramChatId?: string;
  lpAmountUsdc: number;
  hedgeRatio: number;
  rangeWidth: number;
  monitorIntervalMs: number;
  cooldownPeriodMs: number;
  apiPort: number;
}

function loadConfig(): BotConfig {
  const {
    PRIVATE_KEY,
    SUI_RPC_URL,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    LP_AMOUNT_USDC,
    HEDGE_RATIO,
    RANGE_WIDTH,
    MONITOR_INTERVAL_MS,
    COOLDOWN_PERIOD_MS,
  } = process.env;

  if (!PRIVATE_KEY || PRIVATE_KEY === 'your_private_key_here') {
    Logger.warn('PRIVATE_KEY is not configured yet. Bot logic will wait for configuration.');
    // 不要なプロセス終了を避け、APIサーバーが起動できるようにします
  } else {
    Logger.info(`PRIVATE_KEY loaded (${PRIVATE_KEY.length} characters)`);
  }

  return {
    privateKey: PRIVATE_KEY,
    rpcUrl: SUI_RPC_URL || 'https://fullnode.testnet.sui.io',
    telegramToken: TELEGRAM_BOT_TOKEN,
    telegramChatId: TELEGRAM_CHAT_ID,
    lpAmountUsdc: parseFloat(LP_AMOUNT_USDC || '0.05'),
    hedgeRatio: parseFloat(HEDGE_RATIO || '0.5'),
    rangeWidth: parseFloat(RANGE_WIDTH || '0.05'),
    monitorIntervalMs: parseInt(MONITOR_INTERVAL_MS || '60000', 10),
    cooldownPeriodMs: parseInt(COOLDOWN_PERIOD_MS || '600000', 10),
    apiPort: parseInt(process.env.PORT || '3002', 10),
  };
}

export function reloadConfig(): BotConfig {
  // 環境変数を強制的に再読み込み
  const result = dotenv.config({ override: true });
  if (result.error) {
    Logger.error('Failed to load .env file', result.error);
  }
  const newConfig = loadConfig();
  // 既存のオブジェクトの中身を更新するのではなく、新しい設定を返す
  return newConfig;
}

export let config = loadConfig();

export function updateConfigReference(newConfig: BotConfig) {
  config = newConfig;
}

