// ============================================================
// src/state.ts  — グリッドBOT状態の永続化（JSON）
// ============================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type {
  GridState,
  LpPosition,
  PendingOpen,
  FillEvent,
  ImportantEvent,
  AutoConfig,
  GridInitParams,
} from "./types.js";
import { generateId } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const STATE_PATH = path.join(DATA_DIR, "state.json");

// ── デフォルト状態 ────────────────────────────────────────

export function defaultAutoConfig(): AutoConfig {
  return {
    autoInterval: true,
    autoRangeWidth: true,
    autoGridBand: true,
    autoReinit: Boolean(process.env.AUTO_REINIT_ENABLED !== "false"),
    autoReinitMinPositions: Number(process.env.AUTO_REINIT_MIN_POSITIONS ?? 1),
    autoRebalanceInventory: Boolean(process.env.AUTO_REBALANCE_ENABLED !== "false"),
    rebalanceThresholdPct: Number(process.env.REBALANCE_THRESHOLD_PCT ?? 70),
    rebalanceCooldownSec: Number(process.env.REBALANCE_COOLDOWN_SEC ?? 300),
    autoFundTransfer: Boolean(process.env.AUTO_FUND_TRANSFER_ENABLED === "true"),
    fundTransferDailyLimit: Number(process.env.FUND_TRANSFER_DAILY_LIMIT ?? 10_000_000_000),
    fundTransferDailyMax: Number(process.env.FUND_TRANSFER_DAILY_MAX ?? 5),
    autoPromoteDemoteGap: Boolean(process.env.AUTO_PROMOTE_DEMOTE_ENABLED !== "false"),
    minPollSec: Number(process.env.MIN_POLL_SEC ?? 3),
    maxPollSec: Number(process.env.MAX_POLL_SEC ?? 60),
    maxOpensPerCycle: Number(process.env.MAX_OPENS_PER_CYCLE ?? 5),
    maxOpensPerDay: Number(process.env.MAX_OPENS_PER_DAY ?? 50),
    currentPollSec: Number(process.env.POLL_INTERVAL_SEC ?? 10),
    currentRangeWidthPct: Number(process.env.GRID_WIDTH_PCT ?? 2),
    currentGridBands: 0,
  };
}

export function defaultInitParams(): GridInitParams {
  return {
    gridWidthPct: Number(process.env.GRID_WIDTH_PCT ?? 2),
    gridLevelsUp: Number(process.env.GRID_LEVELS_UP ?? 3),
    gridLevelsDown: Number(process.env.GRID_LEVELS_DOWN ?? 3),
    gridCapitalA: process.env.GRID_CAPITAL_A ?? "1000000000",
    gridCapitalB: process.env.GRID_CAPITAL_B ?? "1000000",
    allocMode: (process.env.GRID_ALLOC_MODE as "equal" | "geometric") ?? "equal",
  };
}

export function createEmptyState(): GridState {
  return {
    positions: {},
    pendingOpens: [],
    realized: {},
    feesEarned: {},
    swapFeesPaid: {},
    lastCycleAt: 0,
    gasUsedSinceStart: 0,
    gasUsedCumulative: 0,
    restartCount: 0,
    dailyOpenCount: 0,
    dailyOpenCountResetAt: Date.now(),
    rebalancedAt: 0,
    fundTransferDailyCount: 0,
    fundTransferDailyResetAt: Date.now(),
    autoConfig: defaultAutoConfig(),
    initParams: defaultInitParams(),
    currentPrices: {},
    fillHistory: [],
    importantEvents: [],
  };
}

// ── 読み込み・保存 ────────────────────────────────────────

export function loadState(): GridState {
  const botId = process.env.BOT_ID || "";
  const filename = botId ? `state_${botId}.json` : "state.json";
  const filePath = path.join(DATA_DIR, filename);

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    const s = createEmptyState();
    // 他のボットと設定情報を同期させるため、既存の state.json から設定を継承する
    const sharedPath = path.join(DATA_DIR, "state.json");
    if (fs.existsSync(sharedPath)) {
      try {
        const raw = fs.readFileSync(sharedPath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<GridState>;
        if (parsed.autoConfig) s.autoConfig = parsed.autoConfig;
        if (parsed.initParams) s.initParams = parsed.initParams;
      } catch {}
    }
    saveState(s);
    return s;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GridState>;
    return { ...createEmptyState(), ...parsed };
  } catch (e) {
    console.error(`[state] Failed to parse ${filename}, starting fresh:`, e);
    return createEmptyState();
  }
}

export function saveState(state: GridState): void {
  const botId = process.env.BOT_ID || "";
  const filename = botId ? `state_${botId}.json` : "state.json";
  const filePath = path.join(DATA_DIR, filename);

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tempPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    console.error(`[state] Failed to write state file ${filename} atomically:`, e);
    try {
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
    } catch {}
  }
}

export function loadMergedState(): GridState {
  const stateFiles = ["state_BOT1.json", "state_BOT2.json", "state_BOT3.json", "state_BOT4.json", "state.json"];
  const merged = createEmptyState();
  let latestLastCycleAt = 0;

  const allEvents: ImportantEvent[] = [];
  const allFills: any[] = [];

  for (const filename of stateFiles) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<GridState>;
      
      if (parsed.positions) {
        for (const [posId, newPos] of Object.entries(parsed.positions)) {
          const existingPos = merged.positions[posId];
          if (!existingPos) {
            merged.positions[posId] = newPos as LpPosition;
          } else {
            // 同じpositionIdが複数BOTのstateに存在する場合（BOT2/BOT3など）
            // オンチェーンデータ（amountA/B, tick情報など）は新しい方を優先
            // メタデータ（gridIndex, bandId, mode, openedAt）は非ゼロの値を優先
            const incoming = newPos as LpPosition;
            merged.positions[posId] = {
              ...existingPos,
              // オンチェーン由来の最新データで上書き
              tickLower: incoming.tickLower,
              tickUpper: incoming.tickUpper,
              currentTick: incoming.currentTick,
              side: incoming.side,
              amountA: incoming.amountA,
              amountB: incoming.amountB,
              uncollectedFeeA: incoming.uncollectedFeeA ?? existingPos.uncollectedFeeA,
              uncollectedFeeB: incoming.uncollectedFeeB ?? existingPos.uncollectedFeeB,
              isActive: incoming.isActive,
              // メタデータは非ゼロ値・より具体的な値を優先
              gridIndex: (incoming.gridIndex && incoming.gridIndex !== 0) ? incoming.gridIndex : existingPos.gridIndex,
              bandId: (incoming.bandId !== 0 && incoming.bandId != null) ? incoming.bandId : existingPos.bandId,
              mode: (incoming.mode && incoming.mode !== "grid") ? incoming.mode : existingPos.mode,
              openedAt: Math.min(existingPos.openedAt, incoming.openedAt || Date.now()),
            };
          }
        }
      }
      if (parsed.pendingOpens) {
        merged.pendingOpens.push(...parsed.pendingOpens);
      }
      if (parsed.realized) {
        for (const [token, val] of Object.entries(parsed.realized)) {
          merged.realized[token] = (merged.realized[token] ?? 0) + (val ?? 0);
        }
      }
      if (parsed.feesEarned) {
        for (const [token, val] of Object.entries(parsed.feesEarned)) {
          merged.feesEarned[token] = (merged.feesEarned[token] ?? 0) + (val ?? 0);
        }
      }
      if (parsed.swapFeesPaid) {
        for (const [token, val] of Object.entries(parsed.swapFeesPaid)) {
          merged.swapFeesPaid[token] = (merged.swapFeesPaid[token] ?? 0) + (val ?? 0);
        }
      }
      if (parsed.gasUsedSinceStart) merged.gasUsedSinceStart += parsed.gasUsedSinceStart;
      if (parsed.gasUsedCumulative) merged.gasUsedCumulative += parsed.gasUsedCumulative;
      if (parsed.restartCount) merged.restartCount += parsed.restartCount;
      
      if (parsed.lastCycleAt && parsed.lastCycleAt > latestLastCycleAt) {
        latestLastCycleAt = parsed.lastCycleAt;
      }
      
      if (parsed.importantEvents) {
        allEvents.push(...parsed.importantEvents);
      }
      if (parsed.fillHistory) {
        allFills.push(...parsed.fillHistory);
      }
      if (parsed.currentPrices) {
        Object.assign(merged.currentPrices, parsed.currentPrices);
      }
      
      if (parsed.lastCycleAt && parsed.lastCycleAt >= latestLastCycleAt) {
        if (parsed.autoConfig) merged.autoConfig = parsed.autoConfig;
        if (parsed.initParams) merged.initParams = parsed.initParams;
      }
    } catch (e) {
      // ignore
    }
  }

  allEvents.sort((a, b) => b.timestamp - a.timestamp);
  merged.importantEvents = allEvents.slice(0, 2000);

  allFills.sort((a, b) => b.timestamp - a.timestamp);
  merged.fillHistory = allFills.slice(0, 1000);

  if (latestLastCycleAt > 0) merged.lastCycleAt = latestLastCycleAt;

  return merged;
}

export function updateConfigAll(config: Partial<AutoConfig>): void {
  const stateFiles = ["state_BOT1.json", "state_BOT2.json", "state_BOT3.json", "state_BOT4.json", "state.json"];
  for (const filename of stateFiles) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as GridState;
      parsed.autoConfig = { ...parsed.autoConfig, ...config };
      fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf-8");
    } catch {}
  }
}

export function updateInitParamsAll(params: Partial<GridInitParams>): void {
  const stateFiles = ["state_BOT1.json", "state_BOT2.json", "state_BOT3.json", "state_BOT4.json", "state.json"];
  for (const filename of stateFiles) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as GridState;
      parsed.initParams = { ...parsed.initParams, ...params };
      fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf-8");
    } catch {}
  }
}

export function resetPerformanceAll(): void {
  const stateFiles = ["state_BOT1.json", "state_BOT2.json", "state_BOT3.json", "state_BOT4.json", "state.json"];
  for (const filename of stateFiles) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as GridState;
      parsed.realized = {};
      parsed.feesEarned = {};
      parsed.swapFeesPaid = {};
      parsed.fillHistory = [];
      parsed.gasUsedSinceStart = 0;
      parsed.restartCount = 0;
      fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf-8");
    } catch {}
  }
}

export function clearEventsAll(): void {
  const stateFiles = ["state_BOT1.json", "state_BOT2.json", "state_BOT3.json", "state_BOT4.json", "state.json"];
  for (const filename of stateFiles) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as GridState;
      parsed.importantEvents = [];
      fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf-8");
    } catch {}
  }
}

// ── ポジション操作 ────────────────────────────────────────

export function upsertPosition(state: GridState, pos: LpPosition): void {
  const existing = state.positions[pos.positionId];
  if (existing) {
    state.positions[pos.positionId] = {
      ...existing,
      ...pos,
      // オンチェーン側に存在しないカスタム属性を引き継ぐ
      // gridIndex/bandIdが0（デフォルト値）の場合は既存の値を維持する
      gridIndex: (pos.gridIndex !== 0 && pos.gridIndex != null) ? pos.gridIndex : existing.gridIndex,
      bandId: (pos.bandId !== 0 && pos.bandId != null) ? pos.bandId : existing.bandId,
      // modeはオンチェーンから取得できないため常に既存値を優先
      mode: (pos.mode && pos.mode !== "grid") ? pos.mode : existing.mode,
      // openedAtは既存のものを保持（オンチェーン取得時にDate.now()で上書きされるのを防ぐ）
      openedAt: existing.openedAt || pos.openedAt,
      usdValue: pos.usdValue || existing.usdValue,
    };
  } else {
    state.positions[pos.positionId] = pos;
  }
}

export function removePosition(state: GridState, positionId: string): void {
  delete state.positions[positionId];
}

export function getPosition(state: GridState, positionId: string): LpPosition | undefined {
  return state.positions[positionId];
}

export function getAllPositions(state: GridState): LpPosition[] {
  return Object.values(state.positions);
}

// ── 待機発注キュー操作 ────────────────────────────────────

export function enqueuePending(state: GridState, pending: PendingOpen): void {
  state.pendingOpens.push(pending);
}

export function dequeuePending(state: GridState, id: string): PendingOpen | undefined {
  const idx = state.pendingOpens.findIndex((p) => p.id === id);
  if (idx < 0) return undefined;
  const [item] = state.pendingOpens.splice(idx, 1);
  return item;
}

// ── 損益記録 ──────────────────────────────────────────────

export function addRealized(
  state: GridState,
  token: string,
  amount: number
): void {
  state.realized[token] = (state.realized[token] ?? 0) + amount;
}

export function addFees(
  state: GridState,
  token: string,
  amount: number
): void {
  state.feesEarned[token] = (state.feesEarned[token] ?? 0) + amount;
}

export function addSwapFees(
  state: GridState,
  token: string,
  amount: number
): void {
  state.swapFeesPaid[token] = (state.swapFeesPaid[token] ?? 0) + amount;
}

// ── 約定履歴 ──────────────────────────────────────────────

export function recordFill(state: GridState, event: FillEvent): void {
  state.fillHistory.unshift(event);
  // 最大1000件
  if (state.fillHistory.length > 1000) {
    state.fillHistory = state.fillHistory.slice(0, 1000);
  }
}

// ── 重要イベント ──────────────────────────────────────────

export function addImportantEvent(
  state: GridState,
  category: ImportantEvent["category"],
  message: string,
  detail?: Record<string, unknown>
): void {
  const event: ImportantEvent = {
    id: generateId(),
    timestamp: Date.now(),
    category,
    message,
    detail,
  };
  state.importantEvents.unshift(event);
  // 最大2000件
  if (state.importantEvents.length > 2000) {
    state.importantEvents = state.importantEvents.slice(0, 2000);
  }
  // コンソールにも出力
  console.log(`[EVENT][${category.toUpperCase()}] ${message}`);
}

// ── 1日カウンタリセット ───────────────────────────────────

export function resetDailyCountersIfNeeded(state: GridState): void {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  if (state.dailyOpenCountResetAt < todayStart.getTime()) {
    state.dailyOpenCount = 0;
    state.dailyOpenCountResetAt = now;
  }
  if (state.fundTransferDailyResetAt < todayStart.getTime()) {
    state.fundTransferDailyCount = 0;
    state.fundTransferDailyResetAt = now;
  }
}

// ── ガス記録 ──────────────────────────────────────────────

export function recordGas(state: GridState, amount: number): void {
  state.gasUsedSinceStart += amount;
  state.gasUsedCumulative += amount;
}

// ── パフォーマンスサマリー計算 ────────────────────────────

export function calcPerformanceSummary(state: GridState): import("./types.js").PerformanceSummary {
  const byToken: Record<string, number> = {};

  // 1. 実現損益（過去の履歴から）
  for (const [token, realized] of Object.entries(state.realized)) {
    byToken[token] = (byToken[token] ?? 0) + realized;
  }

  // 2. 確定済み手数料
  for (const [token, fee] of Object.entries(state.feesEarned)) {
    byToken[token] = (byToken[token] ?? 0) + fee;
  }

  // 3. 支払い済みSwap手数料（コスト）
  for (const [token, swapFee] of Object.entries(state.swapFeesPaid)) {
    byToken[token] = (byToken[token] ?? 0) - swapFee;
  }

  // 4. 現在の未回収LP手数料（オンチェーンからフェッチしたもの）
  for (const pos of Object.values(state.positions)) {
    if (!pos.isActive) continue;
    
    let coinDecA = 9;
    let coinDecB = 9;
    let coinNameA = "";
    let coinNameB = "";

    if (pos.pool === "SUI/USDC") {
      coinDecA = 6; // USDC
      coinDecB = 9; // SUI
      coinNameA = "USDC";
      coinNameB = "SUI";
    } else if (pos.pool === "DEEP/SUI") {
      coinDecA = 6; // DEEP
      coinDecB = 9; // SUI
      coinNameA = "DEEP";
      coinNameB = "SUI";
    } else {
      const parts = pos.pool.split("/");
      coinNameA = parts[0] || "";
      coinNameB = parts[1] || "";
      coinDecA = coinNameA === "USDC" || coinNameA === "DEEP" ? 6 : 9;
      coinDecB = coinNameB === "USDC" || coinNameB === "DEEP" ? 6 : 9;
    }

    if (pos.uncollectedFeeA && coinNameA) {
      byToken[coinNameA] = (byToken[coinNameA] ?? 0) + (Number(pos.uncollectedFeeA) / Math.pow(10, coinDecA));
    }
    if (pos.uncollectedFeeB && coinNameB) {
      byToken[coinNameB] = (byToken[coinNameB] ?? 0) + (Number(pos.uncollectedFeeB) / Math.pow(10, coinDecB));
    }
  }

  // 簡易USD換算 (SUIとUSDCのみ対応の簡易版)
  let totalNetProfitUsd = 0;
  const suiUsdcRaw = state.currentPrices["SUI/USDC"];
  const suiPriceUsd = suiUsdcRaw ? 1 / (suiUsdcRaw * 0.001) : 0;
  
  for (const [token, amount] of Object.entries(byToken)) {
    if (token === "USDC") {
      totalNetProfitUsd += amount;
    } else if (token === "SUI") {
      totalNetProfitUsd += amount * suiPriceUsd;
    } else if (token === "DEEP") {
      const deepSuiRaw = state.currentPrices["DEEP/SUI"];
      const deepPriceInSui = deepSuiRaw ? deepSuiRaw * 0.001 : 0;
      totalNetProfitUsd += amount * deepPriceInSui * suiPriceUsd;
    }
  }

  const roundTripsCompleted = state.fillHistory.filter((f) => f.roundTripCompleted).length;

  return {
    totalNetProfitUsd,
    byToken,
    today: {},
    cumulativeState: byToken,
    roundTripsCompleted,
    gasUsedSinceStart: state.gasUsedSinceStart,
    gasUsedCumulative: state.gasUsedCumulative,
    restartCountSinceStart: state.restartCount,
    restartCountCumulative: state.restartCount,
  };
}
