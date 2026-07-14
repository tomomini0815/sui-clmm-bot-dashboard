// ============================================================
// dashboard/src/types.ts  — ダッシュボード用型定義
// ============================================================

export type Side = "sell" | "buy";
export type Dex = "cetus" | "turbos";
export type Mode = "grid" | "gap" | "center";
export type Origin = "bot" | "manual";
export type LogLevel = "info" | "warn" | "error" | "debug" | "important";

export interface LpPosition {
  positionId: string;
  dex: Dex;
  pool: string;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  side: Side;
  amountA: string;
  amountB: string;
  usdValue: number;
  uncollectedFeeA?: string;
  uncollectedFeeB?: string;
  origin: Origin;
  mode: Mode;
  gridIndex: number;
  bandId: number;
  walletAddress: string;
  openedAt: number;
  filledAt?: number;
  isActive: boolean;
}

export interface ImportantEvent {
  id: string;
  timestamp: number;
  category: "init" | "fill" | "rebalance" | "fund_transfer" | "promote" | "demote" | "error" | "info";
  message: string;
  detail?: Record<string, unknown>;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  tag: string;
  message: string;
  detail?: string;
}

export interface AutoConfig {
  autoInterval: boolean;
  autoRangeWidth: boolean;
  autoGridBand: boolean;
  autoReinit: boolean;
  autoReinitMinPositions: number;
  autoRebalanceInventory: boolean;
  rebalanceThresholdPct: number;
  rebalanceCooldownSec: number;
  autoFundTransfer: boolean;
  fundTransferDailyLimit: number;
  fundTransferDailyMax: number;
  autoPromoteDemoteGap: boolean;
  minPollSec: number;
  maxPollSec: number;
  maxOpensPerCycle: number;
  maxOpensPerDay: number;
  currentPollSec?: number;
  currentRangeWidthPct?: number;
  currentGridBands?: number;
}

export interface GridInitParams {
  gridWidthPct: number;
  gridLevelsUp: number;
  gridLevelsDown: number;
  gridCapitalA: string;
  gridCapitalB: string;
  allocMode: "equal" | "geometric";
}

export interface PerformanceSummary {
  totalNetProfitUsd: number;
  byToken: Record<string, number>;
  today: Record<string, number>;
  cumulativeState: Record<string, number>;
  roundTripsCompleted: number;
  gasUsedSinceStart: number;
  gasUsedCumulative: number;
  restartCountSinceStart: number;
  restartCountCumulative: number;
}

export interface WalletInfo {
  address: string;
  label: string;
  balances: Record<string, string>;
}

export interface BotProcess {
  botId: string;
  label: string;
  dex: Dex;
  mode: Mode;
  pid?: number;
  status: "running" | "stopped" | "error";
  startedAt?: number;
}

export interface GridState {
  positions: Record<string, LpPosition>;
  pendingOpens: unknown[];
  realized: Record<string, number>;
  feesEarned: Record<string, number>;
  swapFeesPaid: Record<string, number>;
  lastCycleAt: number;
  gasUsedSinceStart: number;
  gasUsedCumulative: number;
  restartCount: number;
  dailyOpenCount: number;
  autoConfig: AutoConfig;
  initParams: GridInitParams;
  currentPrices: Record<string, number>;
  importantEvents: ImportantEvent[];
}
