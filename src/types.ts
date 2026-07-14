// ============================================================
// src/types.ts  — 全共通型定義
// ============================================================

export type Side = "sell" | "buy";
export type Dex = "cetus" | "turbos";
export type Mode = "grid" | "gap" | "center"; // grid=通常グリッド稼働, gap=空白BOT(待機), center=LP手数料稼働
export type Origin = "bot" | "manual";
export type AllocMode = "equal" | "geometric";

// ── LPポジション ──────────────────────────────────────────
export interface LpPosition {
  positionId: string;
  dex: Dex;
  pool: string;          // 例: "DEEP/SUI"
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  side: Side;
  amountA: string;       // bigint文字列 (最小単位)
  amountB: string;
  usdValue: number;
  uncollectedFeeA?: string;
  uncollectedFeeB?: string;
  origin: Origin;
  mode: Mode;
  gridIndex: number;     // グリッド帯内の連番
  bandId: number;        // グリッド帯ID
  walletAddress: string;
  openedAt: number;      // unix timestamp (ms)
  filledAt?: number;
  /** 約定処理済みタイムスタンプ（再処理防止用）。セット後は次のサイクルで約定判定をスキップ */
  closedAt?: number;
  isActive: boolean;
}

// ── グリッドメイン状態 ────────────────────────────────────
export interface GridState {
  positions: Record<string, LpPosition>;    // positionId → LpPosition
  pendingOpens: PendingOpen[];
  realized: Record<string, number>;         // token symbol → 累計差益
  feesEarned: Record<string, number>;       // token symbol → 累計手数料
  swapFeesPaid: Record<string, number>;     // token symbol → 累計swapコスト
  lastCycleAt: number;
  gasUsedSinceStart: number;
  gasUsedCumulative: number;
  restartCount: number;
  dailyOpenCount: number;
  dailyOpenCountResetAt: number;
  rebalancedAt: number;
  fundTransferDailyCount: number;
  fundTransferDailyResetAt: number;
  autoConfig: AutoConfig;
  initParams: GridInitParams;
  currentPrices: Record<string, number>;    // pool → current price
  fillHistory: FillEvent[];
  importantEvents: ImportantEvent[];
}

// ── 未処理発注キュー ──────────────────────────────────────
export interface PendingOpen {
  id: string;             // UUID
  dex: Dex;
  pool: string;
  tickLower: number;
  tickUpper: number;
  side: Side;
  amountA: string;
  amountB: string;
  origin: Origin;
  mode: Mode;
  bandId: number;
  walletAddress: string;
  retriesLeft: number;
  createdAt: number;
  reason: string;         // 発注理由（例: "processFill after sell"）
}

// ── 約定イベント ──────────────────────────────────────────
export interface FillEvent {
  positionId: string;
  pool: string;
  dex: Dex;
  side: Side;
  filledAt: number;
  amountA: string;
  amountB: string;
  /** 円環開始時のA保有量（sell→buy→sellの往復損益計算用） */
  startingAmountA: string;
  roundTripCompleted: boolean;
  realizedPnl?: Record<string, number>;
}

// ── 重要イベント履歴 ──────────────────────────────────────
export interface ImportantEvent {
  id: string;
  timestamp: number;
  category: "init" | "fill" | "rebalance" | "fund_transfer" | "promote" | "demote" | "error" | "info";
  message: string;
  detail?: Record<string, unknown>;
}

// ── ログエントリ ──────────────────────────────────────────
export type LogLevel = "info" | "warn" | "error" | "debug" | "important";

export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  tag: string;            // 例: "Grid・Cetus"
  message: string;
  detail?: string;
}

// ── 自動調整設定 ──────────────────────────────────────────
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
  // 自動調整の現在値（読み取り専用）
  currentPollSec?: number;
  currentRangeWidthPct?: number;
  currentGridBands?: number;
}

// ── グリッド初期化パラメータ ──────────────────────────────
export interface GridInitParams {
  gridWidthPct: number;
  gridLevelsUp: number;
  gridLevelsDown: number;
  gridCapitalA: string;
  gridCapitalB: string;
  allocMode: AllocMode;
}

// ── パフォーマンスサマリー ────────────────────────────────
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

// ── DEXアダプタインターフェース ──────────────────────────
export interface PositionRange {
  tickLower: number;
  tickUpper: number;
  side: Side;
  amountA: string;
  amountB: string;
}

export interface IGridAdapter {
  readonly dex: Dex;
  getAllPositions(walletAddress: string, knownIds?: string[], existingPositions?: Record<string, LpPosition>): Promise<LpPosition[]>;
  getCurrentTick(pool: string): Promise<number>;
  getCurrentPrice(pool: string): Promise<number>;
  openPosition(pool: string, range: PositionRange, walletAddress: string): Promise<string>;
  closePosition(positionId: string, walletAddress: string): Promise<{ amountA: string; amountB: string }>;
  movePosition(pool: string, positionId: string, newRange: PositionRange, walletAddress: string): Promise<{ positionId: string; amountA: string; amountB: string }>;
  multiOpenPositions(pool: string, ranges: PositionRange[], walletAddress: string): Promise<string[]>;
  getWalletBalances(walletAddress: string): Promise<Record<string, string>>;
  getPoolSymbols(pool: string): { symbolA: string; symbolB: string };
  estimateGas(operation: string): Promise<number>;
  /** SUI→トークン スワップ（自動補充用）。pool="DEEP/SUI" or "SUI/USDC" */
  swapSuiForToken(pool: string, tokenSymbol: string, suiAmountMist: bigint): Promise<{ digest: string; tokenReceived: string }>;
  /** トークン→SUI スワップ（ガス代補充用）。pool="DEEP/SUI" or "SUI/USDC" */
  swapTokenForSui(pool: string, tokenSymbol: string, tokenAmount: bigint): Promise<{ digest: string; suiReceived: string }>;
}

// ── ウォレット残高 ────────────────────────────────────────
export interface WalletInfo {
  address: string;
  label: string;         // 例: "グリッド用", "空白用"
  balances: Record<string, string>;  // symbol → amount文字列
}

// ── BOTプロセス情報 ───────────────────────────────────────
export interface BotProcess {
  botId: string;
  label: string;          // 例: "Grid・Cetus"
  dex: Dex;
  mode: Mode;
  pid?: number;
  status: "running" | "stopped" | "error";
  startedAt?: number;
}
