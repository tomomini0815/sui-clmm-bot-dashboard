// ============================================================
// src/main.ts  — BOTエントリーポイント
// ============================================================

import "dotenv/config";
import { CetusGridAdapter } from "./cetus-grid.js";
import { TurbosGridAdapter } from "./turbos-grid.js";
import { loadState, saveState, addImportantEvent } from "./state.js";
import { runCycle } from "./grid.js";
import { autoRebalanceInventory, autoFundTransfer } from "./auto-tune.js";

// ── 環境変数 ──────────────────────────────────────────────

const GRID_WALLET = process.env.GRID_WALLET_PRIVATE_KEY ?? "";
const GAP_WALLET = process.env.GAP_WALLET_PRIVATE_KEY ?? "";
const GRID_POOLS = (process.env.GRID_POOLS ?? "DEEP/SUI")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CETUS_ENABLED = process.env.CETUS_ENABLED !== "false";
const TURBOS_ENABLED = process.env.TURBOS_ENABLED !== "false";

// SUI→トークン 自動補充設定
const AUTO_REFILL_ENABLED = process.env.AUTO_REFILL_DEEP_ENABLED === "true";
const REFILL_THRESHOLD_DEEP = BigInt(process.env.AUTO_REFILL_DEEP_THRESHOLD_MIST ?? "300000000"); // 300 DEEP
const REFILL_AMOUNT_SUI_DEEP = BigInt(process.env.AUTO_REFILL_DEEP_AMOUNT_SUI_MIST ?? "5000000000"); // 5 SUI
const REFILL_THRESHOLD_USDC = BigInt(process.env.AUTO_REFILL_USDC_THRESHOLD_MIST ?? "15000000"); // 15 USDC
const REFILL_AMOUNT_SUI_USDC = BigInt(process.env.AUTO_REFILL_USDC_AMOUNT_SUI_MIST ?? "2000000000"); // 2 SUI

// SUIガス自動補充設定（トークン→SUI）
const SUI_GAS_MIN_MIST = BigInt(500_000_000);      // 0.5 SUI（ガス最低残高）
const SUI_GAS_REFILL_TARGET_MIST = BigInt(2_000_000_000); // 2 SUI（補充目標）
const SUI_GAS_REFILL_USDC_MIST = BigInt(5_000_000); // 5 USDCをSUIに交換

// ── SUIガス自動補充（トークン→SUI） ─────────────────────

async function autoRefillSuiGas(
  adapters: any[],
  walletAddress: string,
  state: any,
  pool: string,
  tokenSymbol: string
): Promise<void> {
  const cetusAdapter = adapters.find((a) => a.dex === "cetus");
  if (!cetusAdapter) return;

  try {
    const balances = await cetusAdapter.getWalletBalances(walletAddress);
    const suiBalance = BigInt(balances["SUI"] ?? "0");
    const tokenBalance = BigInt(balances[tokenSymbol] ?? "0");

    if (suiBalance >= SUI_GAS_MIN_MIST) return;
    if (tokenBalance < SUI_GAS_REFILL_USDC_MIST) return;

    console.log(`[SuiGas] SUI残高 ${(Number(suiBalance) / 1e9).toFixed(4)} が不足。${tokenSymbol}→SUIスワップを実行...`);

    const { digest, suiReceived } = await cetusAdapter.swapTokenForSui(pool, tokenSymbol, SUI_GAS_REFILL_USDC_MIST);
    console.log(`[SuiGas] スワップ完了: Tx=${digest}, SUI受取=${(Number(suiReceived) / 1e9).toFixed(4)}`);

    addImportantEvent(
      state,
      "info",
      `SUIガス補充: ${tokenSymbol} ${Number(SUI_GAS_REFILL_USDC_MIST) / 1e6} → SUI ${(Number(suiReceived) / 1e9).toFixed(4)} (Tx: ${digest.slice(0, 16)}...)`
    );
  } catch (e) {
    console.error(`[SuiGas] ${tokenSymbol}→SUIスワップ失敗: ${e}`);
    addImportantEvent(state, "error", `SUIガス補充失敗 (${tokenSymbol}→SUI): ${e}`);
  }
}

// ── 自動補充共通ロジック ──────────────────────────────────

async function autoRefillToken(
  adapters: any[],
  walletAddress: string,
  state: any,
  pool: string,
  tokenSymbol: string,
  threshold: bigint,
  suiAmount: bigint
): Promise<void> {
  if (!AUTO_REFILL_ENABLED) return;

  const cetusAdapter = adapters.find((a) => a.dex === "cetus");
  if (!cetusAdapter) return;

  try {
    const balances = await cetusAdapter.getWalletBalances(walletAddress);
    const tokenBalance = BigInt(balances[tokenSymbol] ?? "0");
    const suiBalance = BigInt(balances["SUI"] ?? "0");

    if (tokenBalance >= threshold) return;

    // SUI残高チェック（スワップ量 + ガス代バッファ）
    const suiBuffer = BigInt(500_000_000); // 0.5 SUI ガスバッファ
    if (suiBalance < suiAmount + suiBuffer) {
      // SUI不足時はログのみ（importantEvents スパム防止）
      return;
    }

    console.log(`[AutoRefill] ${tokenSymbol}残高 ${tokenBalance} が閾値 ${threshold} を下回りました。SUI→${tokenSymbol}スワップを実行します...`);

    const { digest, tokenReceived } = await cetusAdapter.swapSuiForToken(pool, tokenSymbol, suiAmount);
    console.log(`[AutoRefill] スワップ完了: Tx=${digest}, ${tokenSymbol}受取=${tokenReceived}`);

    addImportantEvent(
      state,
      "info",
      `自動補充: SUI ${Number(suiAmount) / 1e9} → ${tokenSymbol} ${Number(tokenReceived) / 1e6} (Tx: ${digest.slice(0, 16)}...)`
    );
  } catch (e) {
    const msg = String(e);
    if (!msg.includes("Insufficient balance")) {
      console.error(`[AutoRefill] SUI→${tokenSymbol}スワップ失敗: ${e}`);
      addImportantEvent(state, "error", `自動補充失敗 (${tokenSymbol}): ${e}`);
    }
  }
}

// ── タイムアウト付きラッパー ─────────────────────────────

const CYCLE_TIMEOUT_MS = 60_000; // 60秒でタイムアウト

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[Timeout] ${label} が ${ms / 1000}秒でタイムアウトしました`)), ms)
    ),
  ]);
}

// ── 起動 ──────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Sui LP Rebalancer — gridBOT-standalone ===");
  console.log(`pools: ${GRID_POOLS.join(", ")}`);

  const state = loadState();
  state.restartCount++;

  addImportantEvent(state, "info", `BOT起動 restart#${state.restartCount} pools=${GRID_POOLS.join(",")}`);

  // アダプタ初期化
  const adapters = [];
  if (CETUS_ENABLED) adapters.push(new CetusGridAdapter(GRID_WALLET));
  if (TURBOS_ENABLED) adapters.push(new TurbosGridAdapter(GAP_WALLET));

  if (adapters.length === 0) {
    console.error("有効なアダプタがありません。CETUS_ENABLED または TURBOS_ENABLED を確認してください。");
    process.exit(1);
  }

  const priceHistory: Record<string, number[]> = {};

  saveState(state);

  let consecutiveStalls = 0;

  // メインループ
  while (true) {
    const pollSec = state.autoConfig.currentPollSec ?? 10;
    const cycleStart = Date.now();

    for (const adapter of adapters) {
      const addr = (adapter as any).walletAddress ?? GRID_WALLET;

      // まずSUIガス残高を確保（トークン→SUI）
      if (GRID_POOLS.includes("SUI/USDC")) {
        try {
          await withTimeout(autoRefillSuiGas(adapters, addr, state, "SUI/USDC", "USDC"), 30_000, "SUIガス補充");
        } catch (e) {
          console.error(`[Watchdog] ${e}`);
        }
      }

      // 各プールのトークン自動補充（サイクル前に実行）
      if (GRID_POOLS.includes("DEEP/SUI")) {
        try {
          await withTimeout(autoRefillToken(adapters, addr, state, "DEEP/SUI", "DEEP", REFILL_THRESHOLD_DEEP, REFILL_AMOUNT_SUI_DEEP), 30_000, "DEEP補充");
        } catch (e) {
          console.error(`[Watchdog] ${e}`);
        }
      }
      if (GRID_POOLS.includes("SUI/USDC")) {
        try {
          await withTimeout(autoRefillToken(adapters, addr, state, "SUI/USDC", "USDC", REFILL_THRESHOLD_USDC, REFILL_AMOUNT_SUI_USDC), 30_000, "USDC補充");
        } catch (e) {
          console.error(`[Watchdog] ${e}`);
        }
      }

      // サイクル実行（60秒タイムアウト付き）
      try {
        await withTimeout(runCycle(adapter, state, GRID_POOLS, addr, priceHistory), CYCLE_TIMEOUT_MS, `runCycle(${GRID_POOLS.join(",")})`);
        consecutiveStalls = 0;
      } catch (e) {
        console.error(`[Watchdog] ${e}`);
        addImportantEvent(state, "error", `サイクルタイムアウト/エラー: ${e}`);
        consecutiveStalls++;

        // 3回連続タイムアウト時は一時待機（RPC障害の可能性）
        if (consecutiveStalls >= 3) {
          const backoffMs = Math.min(60_000, consecutiveStalls * 15_000);
          console.log(`[Watchdog] 連続タイムアウト${consecutiveStalls}回。${backoffMs / 1000}秒待機します...`);
          addImportantEvent(state, "error", `連続タイムアウト${consecutiveStalls}回。${backoffMs / 1000}秒待機中`);
          await sleep(backoffMs);
        }
      }
    }

    // 自動リバランス（全アダプタ共通）
    if (state.autoConfig.autoRebalanceInventory) {
      try {
        await withTimeout(autoRebalanceInventory(state, 0n, 0n, 1.0), 30_000, "自動リバランス");
      } catch (e) {
        console.error(`[Watchdog] ${e}`);
      }
    }

    // サイクル間隔調整（タイムアウト分を補正）
    const elapsed = Date.now() - cycleStart;
    const waitMs = Math.max(1000, pollSec * 1000 - elapsed);
    await sleep(waitMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
