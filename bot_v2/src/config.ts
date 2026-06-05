import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Logger } from './logger.js';

// ES Module dir resolution
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .envファイルのパスを明示的に指定（bot_v2ディレクトリ直下）
const envPath = path.resolve(__dirname, '../.env');
console.log(`DEBUG: Loading .env from: ${envPath}`);
const result = dotenv.config({ path: envPath });
if (result.error) {
  console.error('DEBUG: Dotenv Load Error:', result.error);
} else {
  console.log('DEBUG: Dotenv Loaded successfully');
  console.log('DEBUG: LP_AMOUNT_USDC from env:', process.env.LP_AMOUNT_USDC);
}

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
  breachConfirmMs: number;
  apiPort: number;
  
  // === 新設定: 利益最適化 ===
  feeCollectIntervalMs: number;     // 手数料回収間隔 (ms)
  minProfitForRebalance: number;    // リバランス最小利益閾値 (USDC)
  gasBudgetSui: number;             // TX当たりのガス予算 (SUI)
  rsiEntryLow: number;              // RSIエントリー下限
  rsiEntryHigh: number;             // RSIエントリー上限
  hedgeMode: 'simulate' | 'bluefin'; // ヘッジモード
  maxSlippage: number;              // 最大スリッページ (%)
  balanceCheckEnabled: boolean;     // 残高チェック有効化
  configMode: 'auto' | 'manual';   // 設定モード（追加）
  backupPassword?: string;          // バックアップ保護パスワード
  totalOperationalCapitalUsdc: number; // 総運用資金 (USDC)

  // === 指値レンジ戦略 (Range Order) 設定 ===
  strategyMode: 'balanced' | 'range_order' | 'bluefin_grid';
  rangeOrderSide: 'above' | 'below';
  rangeOrderOffset1Pct: number;     // 1段階目のオフセット (%)
  rangeOrderOffset2Pct: number;     // 2段階目のオフセット (%)
  rangeOrderWidthPct: number;       // 各レンジ幅 (%)
  rangeOrderHedgeEnabled: boolean;  // デルタヘッジを有効にするか（指値注文中は通常false）
  hedgeEnabled: boolean;           // 全体的なヘッジの有効・無効
  poolObjectId: string;            // 運用対象のプールID
  rangeOrderBreachDurationMs?: number; // レンジはみ出し判定継続時間 (ms)
}

function loadConfig(): BotConfig {
  const {
    PRIVATE_KEY_HEX,
    SUI_RPC_URL,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    LP_AMOUNT_USDC,
    HEDGE_RATIO,
    RANGE_WIDTH,
    MONITOR_INTERVAL_MS,
    COOLDOWN_PERIOD_MS,
    // 新設定
    FEE_COLLECT_INTERVAL_MS,
    MIN_PROFIT_FOR_REBALANCE,
    GAS_BUDGET_SUI,
    RSI_ENTRY_LOW,
    RSI_ENTRY_HIGH,
    HEDGE_MODE,
    MAX_SLIPPAGE,
    BALANCE_CHECK_ENABLED,
    CONFIG_MODE,
    BACKUP_PASSWORD,
    TOTAL_OPERATIONAL_CAPITAL_USDC,
    // 戦略
    STRATEGY_MODE,
    RANGE_ORDER_SIDE,
    RANGE_ORDER_OFFSET_1_PCT,
    RANGE_ORDER_OFFSET_2_PCT,
    RANGE_ORDER_WIDTH_PCT,
    RANGE_ORDER_HEDGE_ENABLED,
    HEDGE_ENABLED,
  } = process.env;

  if (!PRIVATE_KEY_HEX || PRIVATE_KEY_HEX === 'your_private_key_here') {
    Logger.warn('PRIVATE_KEY_HEX is not configured yet. Bot logic will wait for configuration.');
  } else {
    Logger.info(`PRIVATE_KEY loaded (${PRIVATE_KEY_HEX.length} characters)`);
  }

  return {
    privateKey: PRIVATE_KEY_HEX,
    rpcUrl: SUI_RPC_URL || process.env.RPC_URL || 'https://sui.publicnode.com',
    telegramToken: TELEGRAM_BOT_TOKEN,
    telegramChatId: TELEGRAM_CHAT_ID,
    lpAmountUsdc: parseFloat(LP_AMOUNT_USDC || '0.10'),
    hedgeRatio: parseFloat(HEDGE_RATIO || '0.5'),
    rangeWidth: parseFloat(RANGE_WIDTH || '0.05'),
    monitorIntervalMs: parseInt(MONITOR_INTERVAL_MS || '30000', 10),
    cooldownPeriodMs: parseInt(COOLDOWN_PERIOD_MS || '300000', 10),
    breachConfirmMs: parseInt(process.env.BREACH_CONFIRM_MS || '300000', 10),
    apiPort: parseInt(process.env.PORT || '3002', 10),
    
    // 新設定のデフォルト値
    feeCollectIntervalMs: parseInt(FEE_COLLECT_INTERVAL_MS || '300000', 10), 
    minProfitForRebalance: parseFloat(MIN_PROFIT_FOR_REBALANCE || '0.005'),  
    gasBudgetSui: parseFloat(GAS_BUDGET_SUI || '0.05'),
    rsiEntryLow: parseInt(RSI_ENTRY_LOW || '35', 10),
    rsiEntryHigh: parseInt(RSI_ENTRY_HIGH || '65', 10),
    hedgeMode: (HEDGE_MODE as 'simulate' | 'bluefin') || 'simulate',
    maxSlippage: parseFloat(MAX_SLIPPAGE || '0.05'),   
    balanceCheckEnabled: BALANCE_CHECK_ENABLED !== 'false',
    configMode: (CONFIG_MODE as 'auto' | 'manual') || 'auto',
    backupPassword: BACKUP_PASSWORD || 'change_me',
    totalOperationalCapitalUsdc: parseFloat(TOTAL_OPERATIONAL_CAPITAL_USDC || '200'),

    // 戦略設定
    strategyMode: (STRATEGY_MODE as 'balanced' | 'range_order') || 'balanced',
    rangeOrderSide: (RANGE_ORDER_SIDE as 'above' | 'below') || 'above',
    rangeOrderOffset1Pct: parseFloat(RANGE_ORDER_OFFSET_1_PCT || '0.005'), // デフォルト 0.5%
    rangeOrderOffset2Pct: parseFloat(RANGE_ORDER_OFFSET_2_PCT || '0.015'), // デフォルト 1.5%
    rangeOrderWidthPct: parseFloat(RANGE_ORDER_WIDTH_PCT || '0.001'),  // デフォルト 0.1%
    rangeOrderHedgeEnabled: RANGE_ORDER_HEDGE_ENABLED === 'true',     // 指値レンジではデフォルト false
    hedgeEnabled: HEDGE_ENABLED !== 'false',                         // デフォルトは true
    poolObjectId: process.env.POOL_OBJECT_ID || (SUI_RPC_URL?.includes('testnet') ? '0xf4f9663f288049ede73a9f19e3a655c74be8a9a84dd3e2c7f04c190c5c9f1fba' : '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105'),
    rangeOrderBreachDurationMs: parseInt(process.env.RANGE_ORDER_BREACH_DURATION_MS || '60000', 10),
  };
}

// ==========================================
// V4.0 Multi-Bot Configurations
// ==========================================

export const BOT1_CONFIG = {
  name: "Bot1 (SUI-USDC)",
  pool: "SUI/USDC",
  poolObjectId: "0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105",
  feeRate: 0.0025,
  atrMultiplier: 3.0,
  cooldownSec: 300,
  minRangePct: 0.15,
  twapWindow: 5,
};

export const BOT2_CONFIG = {
  name: "Bot2 (DEEP-SUI)",
  pool: "DEEP/SUI",
  poolObjectId: "0xe01243f37f712ef87e556afb9b1d03d0fae13f96d324ec912daffc339dfdcbd2",
  feeRate: 0.01,
  atrMultiplier: 4.0,
  cooldownSec: 600,
  minRangePct: 0.25,
  twapWindow: 10,
};

export interface GridConfig {
  market: string;
  leverage: number;
  totalCapital: number;
  longGridLevels: number;
  longGridSpacing: number;
  longGridSize: number;
  shortEnabled: boolean;
  resistanceLevels: number[];
  shortGridLevels: number;
  shortGridSize: number;
}

export const BOT3_CONFIG: GridConfig = {
  market: "SUI-PERP",
  leverage: 2,
  totalCapital: 1.0, // テスト中
  longGridLevels: 5,
  longGridSpacing: 0.005,
  longGridSize: 0.08,
  shortEnabled: false,
  resistanceLevels: [],
  shortGridLevels: 2,
  shortGridSize: 0.04,
};

export const SAFETY_CONFIG = {
  totalDDLimit: 0.20,
  botDDLimit: 0.10,
  marginRatioMin: 1.3,
  gasMin: 0.05,
  errorLimit: 5,
  priceAgeMax: 120,
};

export const PORTFOLIO_ALLOCATION = [
  { maxUsd: 50,    bot1: 0.40,  bot2: 0.40,  bot3: 0.10, hedge: 0.05, gas: 0.05 }, // Test Mode
  { maxUsd: 200,   bot1: 0.40,  bot2: 0.40,  bot3: 0.16, hedge: 0.00, gas: 0.04 },
  { maxUsd: 1000,  bot1: 0.375, bot2: 0.375, bot3: 0.10, hedge: 0.10, gas: 0.05 },
  { maxUsd: 10000, bot1: 0.35,  bot2: 0.35,  bot3: 0.13, hedge: 0.15, gas: 0.02 },
  { maxUsd: Infinity, bot1: 0.35, bot2: 0.30, bot3: 0.17, hedge: 0.15, gas: 0.03 }
];

export function reloadConfig(): BotConfig {
  const result = dotenv.config({ override: true });
  if (result.error) {
    Logger.error('Failed to load .env file', result.error);
  }
  const newConfig = loadConfig();
  return newConfig;
}

export let config = loadConfig();

export function updateConfigReference(newConfig: BotConfig) {
  config = newConfig;
}
