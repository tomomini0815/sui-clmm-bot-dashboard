import dotenv from 'dotenv';
import { Logger } from './logger.js';

// 環境変数の読み込み
dotenv.config();

export interface BotConfig {
  privateKey: string;
  rpcUrl: string;
  telegramToken?: string;
  telegramChatId?: string;
  lpAmountUsdc: number;
  hedgeRatio: number;
  rangeWidth: number;
  monitorIntervalMs: number;
  cooldownPeriodMs: number;
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

  if (!PRIVATE_KEY || PRIVATE_KEY === 'your_private_key_here' || PRIVATE_KEY.length < 10) {
    Logger.warn('PRIVATE_KEY is not configured yet. Bot logic will wait for configuration.');
    // 不要なプロセス終了を避け、APIサーバーが起動できるようにします
  }

  return {
    privateKey: PRIVATE_KEY,
    rpcUrl: SUI_RPC_URL || 'https://fullnode.testnet.sui.io',
    telegramToken: TELEGRAM_BOT_TOKEN,
    telegramChatId: TELEGRAM_CHAT_ID,
    lpAmountUsdc: parseFloat(LP_AMOUNT_USDC || '500'),
    hedgeRatio: parseFloat(HEDGE_RATIO || '0.5'),
    rangeWidth: parseFloat(RANGE_WIDTH || '0.05'),
    monitorIntervalMs: parseInt(MONITOR_INTERVAL_MS || '60000', 10),
    cooldownPeriodMs: parseInt(COOLDOWN_PERIOD_MS || '600000', 10),
  };
}

export const config = loadConfig();
