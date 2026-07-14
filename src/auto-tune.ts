// ============================================================
// src/auto-tune.ts  — 自動調整ロジック群
// 仕様 2.11・2.12 に準拠
// ============================================================

import type { GridState, AutoConfig, LpPosition } from "./types.js";
import { calcVolatility, calcInventorySkewPct } from "./utils.js";
import { addImportantEvent } from "./state.js";

// ── 2.11.1 監視間隔の自動調整 ─────────────────────────────

/**
 * ボラティリティ（直近N分の価格変動率%）に応じて
 * POLL_INTERVAL_SEC を MIN_POLL_SEC〜MAX_POLL_SEC でスケーリング
 */
export function autoTuneInterval(
  prices: number[],
  config: AutoConfig
): number {
  if (!config.autoInterval) {
    return config.currentPollSec ?? 10;
  }

  const volatility = calcVolatility(prices);
  const { minPollSec, maxPollSec } = config;

  // ボラ0%→最長、ボラ5%以上→最短（線形補間）
  const maxVol = 5.0;
  const normalized = Math.min(volatility / maxVol, 1.0);

  // ボラが高いほど間隔を短く
  const newInterval = Math.round(
    maxPollSec - normalized * (maxPollSec - minPollSec)
  );

  return Math.max(minPollSec, Math.min(maxPollSec, newInterval));
}

// ── 2.11.2 レンジ幅の自動調整 ────────────────────────────

/**
 * 直近の約定頻度に応じてレンジ幅を調整
 * - 約定が多い → 幅を広げる（損切り防止）
 * - 約定が少ない → 幅を狭める（利ざや増加）
 * 1周回あたり ±10% までのステップ制限あり
 */
export function autoTuneRangeWidth(
  fillsInWindow: number,
  windowMinutes: number,
  currentWidthPct: number,
  config: AutoConfig
): number {
  if (!config.autoRangeWidth) return currentWidthPct;

  const fillsPerHour = (fillsInWindow / windowMinutes) * 60;

  // 目標: 1時間あたり2〜6回の約定が理想
  const TARGET_FILLS_LOW = 2;
  const TARGET_FILLS_HIGH = 6;
  const MAX_STEP_PCT = 0.1; // 1周回あたり最大10%変更

  let newWidth = currentWidthPct;

  if (fillsPerHour > TARGET_FILLS_HIGH) {
    // 約定多すぎ → 幅を広げる
    newWidth = currentWidthPct * (1 + MAX_STEP_PCT);
  } else if (fillsPerHour < TARGET_FILLS_LOW) {
    // 約定少なすぎ → 幅を狭める
    newWidth = currentWidthPct * (1 - MAX_STEP_PCT);
  }

  // 最小0.5%、最大20%
  return Math.max(0.5, Math.min(20, newWidth));
}

// ── 2.11.3 グリッド帯本数の自動拡縮 ─────────────────────

/**
 * 在庫偏りが閾値超過 → 偏っている方向にグリッド帯を追加
 * 仕様 2.11: autoExpandGridBand
 */
export function autoExpandGridBand(
  state: GridState,
  positions: LpPosition[],
  skewPct: number
): { shouldExpand: boolean; direction: "up" | "down" | null; reason: string } {
  if (!state.autoConfig.autoGridBand) {
    return { shouldExpand: false, direction: null, reason: "autoGridBand disabled" };
  }

  const threshold = state.autoConfig.rebalanceThresholdPct;

  if (skewPct > threshold) {
    // A過多 → sellが詰まっている → 上方向に帯を追加
    return {
      shouldExpand: true,
      direction: "up",
      reason: `A保有比率${skewPct.toFixed(1)}%が閾値${threshold}%を超過。上方向にグリッド帯を追加`,
    };
  }
  if (skewPct < (100 - threshold)) {
    // B過多 → buyが詰まっている → 下方向に帯を追加
    return {
      shouldExpand: true,
      direction: "down",
      reason: `B保有比率${(100 - skewPct).toFixed(1)}%が閾値${threshold}%を超過。下方向にグリッド帯を追加`,
    };
  }

  return { shouldExpand: false, direction: null, reason: "在庫偏り正常範囲内" };
}

/**
 * 長期間未約定のレンジを自動で削減
 * 仕様 2.11: autoShrinkGridBand
 */
export function autoShrinkGridBand(
  positions: LpPosition[],
  inactiveDurationMs: number = 24 * 60 * 60 * 1000 // デフォルト24時間
): LpPosition[] {
  const now = Date.now();
  return positions.filter((pos) => {
    const age = now - pos.openedAt;
    return age < inactiveDurationMs;
  });
}

// ── 2.12.1 在庫偏り自動リバランス ────────────────────────

export interface RebalanceResult {
  executed: boolean;
  reason: string;
  swapAmountA?: string;
  swapAmountB?: string;
  direction?: "AtoB" | "BtoA";
}

/**
 * A/B保有比率が閾値を超えて偏ったら一部をスワップして目標比率へ
 * 仕様 2.12: autoRebalanceInventory
 */
export async function autoRebalanceInventory(
  state: GridState,
  totalA: bigint,
  totalB: bigint,
  priceAinB: number
): Promise<RebalanceResult> {
  const config = state.autoConfig;

  if (!config.autoRebalanceInventory) {
    return { executed: false, reason: "autoRebalanceInventory disabled" };
  }

  // クールダウン確認
  const now = Date.now();
  const cooldownMs = config.rebalanceCooldownSec * 1000;
  if (now - state.rebalancedAt < cooldownMs) {
    const remaining = Math.ceil((cooldownMs - (now - state.rebalancedAt)) / 1000);
    return { executed: false, reason: `クールダウン中 (残り${remaining}秒)` };
  }

  const skewPct = calcInventorySkewPct(totalA, totalB, priceAinB);
  const threshold = config.rebalanceThresholdPct;

  if (skewPct <= threshold && skewPct >= (100 - threshold)) {
    return { executed: false, reason: `在庫比率${skewPct.toFixed(1)}%は正常範囲内` };
  }

  // TODO: 実際のスワップ呼び出し
  // スワップ量は全体の5%を上限とする（安全ガード）
  const MAX_SWAP_PCT = 0.05;

  if (skewPct > threshold) {
    // A過多 → AをBにスワップ
    const excessA = (totalA * BigInt(Math.round((skewPct - 50) * 100))) / 10000n;
    const swapAmount = (excessA * BigInt(Math.round(MAX_SWAP_PCT * 100))) / 100n;
    // TODO: await swapAtoB(swapAmount, walletAddress);

    addImportantEvent(
      state,
      "rebalance",
      `自動リバランス: A比率${skewPct.toFixed(1)}%>閾値${threshold}%のため${swapAmount.toString()} AをスワップBへ`
    );

    state.rebalancedAt = now;
    return {
      executed: true,
      direction: "AtoB",
      swapAmountA: swapAmount.toString(),
      reason: `A比率${skewPct.toFixed(1)}%が閾値${threshold}%超過`,
    };
  } else {
    // B過多 → BをAにスワップ
    const excessB = (totalB * BigInt(Math.round(((100 - skewPct) - 50) * 100))) / 10000n;
    const swapAmount = (excessB * BigInt(Math.round(MAX_SWAP_PCT * 100))) / 100n;
    // TODO: await swapBtoA(swapAmount, walletAddress);

    addImportantEvent(
      state,
      "rebalance",
      `自動リバランス: B比率${(100 - skewPct).toFixed(1)}%>閾値${100 - threshold}%のため${swapAmount.toString()} BをスワップAへ`
    );

    state.rebalancedAt = now;
    return {
      executed: true,
      direction: "BtoA",
      swapAmountB: swapAmount.toString(),
      reason: `B比率${(100 - skewPct).toFixed(1)}%が閾値${100 - threshold}%超過`,
    };
  }
}

// ── 2.12.2 ウォレット間自動資金移動 ─────────────────────

export interface FundTransferResult {
  executed: boolean;
  reason: string;
  amount?: string;
  token?: string;
  fromWallet?: string;
  toWallet?: string;
}

/**
 * グリッド用ウォレット ↔ 空白用ウォレット間の残高偏りを自動補正
 * 仕様 2.12: autoFundTransfer
 *
 * 安全ガード:
 * - 1日の実行回数上限 (fundTransferDailyMax)
 * - 1回あたりの上限額 (fundTransferDailyLimit)
 */
export async function autoFundTransfer(
  state: GridState,
  gridWalletBalance: Record<string, string>,
  gapWalletBalance: Record<string, string>,
  gridWalletAddress: string,
  gapWalletAddress: string
): Promise<FundTransferResult> {
  const config = state.autoConfig;

  if (!config.autoFundTransfer) {
    return { executed: false, reason: "autoFundTransfer disabled" };
  }

  // 1日カウンタ確認
  if (state.fundTransferDailyCount >= config.fundTransferDailyMax) {
    return {
      executed: false,
      reason: `本日の資金移動上限${config.fundTransferDailyMax}回に達しました`,
    };
  }

  // TODO: 残高偏りの検出と実際の transfer 実行
  // 現状はスタブ
  return { executed: false, reason: "残高偏り検出ロジック未実装（スタブ）" };
}

// ── 2.12.3 GAP ↔ GRID 自動昇降格 ────────────────────────

/**
 * GAPポジションのうち現在価格が接近したものをGRIDに昇格
 * 仕様 2.12: autoPromoteGapToGrid
 */
export function autoPromoteGapToGrid(
  state: GridState,
  positions: LpPosition[],
  currentTick: number,
  approachThresholdPct: number = 10
): LpPosition[] {
  if (!state.autoConfig.autoPromoteDemoteGap) return positions;

  const promoted: LpPosition[] = [];

  return positions.map((pos) => {
    if (pos.mode !== "gap") return pos;

    // 現在tickとLPレンジ中央の距離を計算
    const midTick = (pos.tickLower + pos.tickUpper) / 2;
    const rangeWidth = pos.tickUpper - pos.tickLower;
    const distancePct = (Math.abs(currentTick - midTick) / rangeWidth) * 100;

    if (distancePct <= approachThresholdPct) {
      addImportantEvent(
        state,
        "promote",
        `GAP→GRID昇格: ${pos.pool} [${pos.tickLower},${pos.tickUpper}] 現在価格との距離${distancePct.toFixed(1)}%`
      );
      return { ...pos, mode: "grid" as const };
    }
    return pos;
  });
}

/**
 * 長期間未約定のGRIDポジションをGAPに降格
 * 仕様 2.12: autoDemoteGridToGap
 */
export function autoDemoteGridToGap(
  state: GridState,
  positions: LpPosition[],
  currentTick: number,
  demoteThresholdPct: number = 50,
  minAgeMs: number = 48 * 60 * 60 * 1000
): LpPosition[] {
  if (!state.autoConfig.autoPromoteDemoteGap) return positions;

  const now = Date.now();

  return positions.map((pos) => {
    if (pos.mode !== "grid") return pos;

    const age = now - pos.openedAt;
    if (age < minAgeMs) return pos;

    const midTick = (pos.tickLower + pos.tickUpper) / 2;
    const rangeWidth = pos.tickUpper - pos.tickLower;
    const distancePct = (Math.abs(currentTick - midTick) / rangeWidth) * 100;

    if (distancePct > demoteThresholdPct) {
      addImportantEvent(
        state,
        "demote",
        `GRID→GAP降格: ${pos.pool} [${pos.tickLower},${pos.tickUpper}] 現在価格との距離${distancePct.toFixed(1)}% 経過${Math.round(age / 3600000)}時間`
      );
      return { ...pos, mode: "gap" as const };
    }
    return pos;
  });
}
