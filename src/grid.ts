// ============================================================
// src/grid.ts  — BOTコアロジック（状態機械・判定・約定処理）
// 仕様 2.1〜2.10 に準拠
// ============================================================

import type {
  GridState,
  LpPosition,
  PendingOpen,
  IGridAdapter,
  PositionRange,
  FillEvent,
  Side,
} from "./types.js";
import {
  isSellFilled,
  isBuyFilled,
  nextBuyRange,
  nextSellRange,
  buildInitRanges,
  allocateCapital,
  generateId,
  calcSide,
  isStrongDowntrend,
  tickToPrice,
  priceToTick,
  roundToTickSpacing,
} from "./utils.js";
import {
  upsertPosition,
  removePosition,
  getAllPositions,
  enqueuePending,
  recordFill,
  addImportantEvent,
  recordGas,
  saveState,
  resetDailyCountersIfNeeded,
} from "./state.js";
import {
  autoTuneInterval,
  autoTuneRangeWidth,
  autoExpandGridBand,
  autoRebalanceInventory,
  autoPromoteGapToGrid,
  autoDemoteGridToGap,
} from "./auto-tune.js";

// ポジションIDごとの未検出カウンタ (RPCのクエリ漏れによるダッシュボード画面明滅を防ぐための防壁)
const missingCounts = new Map<string, number>();

// 起動初回のフルスキャン制御: 起動後1サイクル目は既知IDを渡さずに全件スキャン
let startupFullScanDone = false;

// 定期フルスキャン用サイクルカウンタ（state外）
let cycleCounter = 0;

// ── ログユーティリティ ────────────────────────────────────

function log(tag: string, msg: string, data?: unknown): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}][${tag}] ${msg}`, data ?? "");
}

// ── 2.10 初期グリッド自動生成 ─────────────────────────────

export async function initGrid(
  adapter: IGridAdapter,
  state: GridState,
  pool: string,
  walletAddress: string,
  priceHistory?: Record<string, number[]>
): Promise<void> {
  const params = state.initParams;
  const config = state.autoConfig;

  log("initGrid", `初期グリッド生成開始: pool=${pool}`);
  addImportantEvent(state, "init", `初期グリッド生成開始: pool=${pool} ${JSON.stringify(params)}`);

  // 安全ガード: 1日あたりの発注上限チェック
  resetDailyCountersIfNeeded(state);
  const totalLevels = params.gridLevelsUp + params.gridLevelsDown;
  if (state.dailyOpenCount + totalLevels > config.maxOpensPerDay) {
    log("initGrid", "本日の発注上限に達したため初期グリッド生成をスキップ");
    return;
  }

  // 1. 現在tickを取得
  const currentTick = await adapter.getCurrentTick(pool);
  state.currentPrices[pool] = await adapter.getCurrentPrice(pool);

  // 2. レンジ一覧を生成（pool情報から動的判定）
  let TICK_SPACING = 60;
  if (adapter.dex === "cetus") {
    try {
      TICK_SPACING = await (adapter as any).getPoolTickSpacing(pool);
    } catch {
      TICK_SPACING = pool === "SUI/USDC" ? 2 : 60;
    }
  } else {
    TICK_SPACING = pool === "SUI/USDC" ? 10 : 60;
  }

  // 自動グリッド幅が有効なら最新値を優先
  const gridWidth = config.autoRangeWidth
    ? (config.currentRangeWidthPct ?? params.gridWidthPct)
    : params.gridWidthPct;

  const ranges = buildInitRanges(
    currentTick,
    gridWidth,
    params.gridLevelsUp,
    params.gridLevelsDown,
    TICK_SPACING
  );

  // トレンドチェック
  const isDowntrend = priceHistory && priceHistory[pool] ? isStrongDowntrend(priceHistory[pool]) : false;
  if (isDowntrend) {
    log("initGrid", `[トレンド警告] 強い下落トレンドを検知したため、初期 buy レンジの発注を保留します。`);
  }

  // 3. アセット配分（通常モードと等価値モード）
  let capitalA = 0n;
  let capitalB = 0n;
  let useEquiAllocation = false;
  let equiPositionRanges: PositionRange[] = [];

  if (params.allocMode === "equal" || params.allocMode === "geometric") {
    if (state.autoConfig.autoRebalanceInventory) {
      try {
        const balances = await adapter.getWalletBalances(walletAddress);
        const { symbolA, symbolB } = (adapter as any).getPoolSymbols(pool);

        const rawA = BigInt(balances[symbolA] ?? "0");
        const rawB = BigInt(balances[symbolB] ?? "0");
        const currentPrice = state.currentPrices[pool] ?? 1.0;

        // ガス代保護バッファ
        const gasBuffer = BigInt(process.env.GAS_BUFFER_MIST ?? "100000000");
        const availB = symbolB === "SUI" && rawB > gasBuffer ? rawB - gasBuffer : rawB;
        const availA = symbolA === "SUI" && rawA > gasBuffer ? rawA - gasBuffer : rawA;

        // 等価値スワップフリー配分アルゴリズム
        const symbolA_decimals = symbolA === "USDC" || symbolA === "DEEP" ? 6 : 9;
        const symbolB_decimals = symbolB === "USDC" || symbolB === "DEEP" ? 6 : 9;

        const factor = currentPrice * Math.pow(10, symbolA_decimals - symbolB_decimals);
        const availBInA = Math.floor(Number(availB) / factor);

        const totalCapitalInA = BigInt(Math.floor(Number(availA) + availBInA));

        if (totalCapitalInA > 0n) {
          const totalLevels = params.gridLevelsUp + params.gridLevelsDown;
          const targetCapitalPerPositionInA = totalCapitalInA / BigInt(totalLevels);

          const maxPerPositionFromA = params.gridLevelsUp > 0 ? availA / BigInt(params.gridLevelsUp) : 0n;
          const maxPerPositionFromB = params.gridLevelsDown > 0 ? availB / BigInt(params.gridLevelsDown) : 0n;

          const targetAmountB = BigInt(Math.floor(Number(targetCapitalPerPositionInA) * factor));

          log("initGrid", `スワップフリー等価値配分完了: pool=${pool}, ${symbolA}上限/本=${maxPerPositionFromA.toString()}, ${symbolB}(A建)上限/本=${maxPerPositionFromB.toString()}, 採用目標(A建)/本=${targetCapitalPerPositionInA.toString()}`);

          equiPositionRanges = ranges.map((r) => {
            if (r.side === "sell") {
              return {
                tickLower: r.tickLower,
                tickUpper: r.tickUpper,
                side: "sell" as Side,
                amountA: targetCapitalPerPositionInA.toString(),
                amountB: "0",
              };
            } else {
              return {
                tickLower: r.tickLower,
                tickUpper: r.tickUpper,
                side: "buy" as Side,
                amountA: "0",
                amountB: targetAmountB.toString(),
              };
            }
          });
          useEquiAllocation = true;
        } else {
          capitalA = 0n;
          capitalB = 0n;
        }

        if (capitalA <= 0n && capitalB <= 0n && !useEquiAllocation) {
          log("initGrid", `エラー: 投入可能資金が両トークンとも0です。発注をスキップします。残高またはガス代用バッファ設定を確認してください。`);
          addImportantEvent(state, "error", `資金不足: 投入可能資金が0です。残高またはガスバッファ値を確認してください。`);
          return;
        }
      } catch (e) {
        log("initGrid", `ウォレット残高取得失敗のため、固定設定値を使用します: ${e}`);
      }
    }
  }

  const sellRanges = ranges.filter((r) => r.side === "sell");
  const buyRanges = ranges.filter((r) => r.side === "buy");

  const allocA = allocateCapital(capitalA, sellRanges.length, params.allocMode);
  const allocB = allocateCapital(capitalB, buyRanges.length, params.allocMode);

  // 4. PositionRange 配列の組み立て（下落トレンド時はbuyを保留）
  const immediateRanges: PositionRange[] = [];
  const pendingRanges: PositionRange[] = [];

  const rawRanges = useEquiAllocation ? equiPositionRanges : [
    ...sellRanges.map((r, i) => ({
      tickLower: r.tickLower,
      tickUpper: r.tickUpper,
      side: "sell" as Side,
      amountA: allocA[i]?.toString() ?? "0",
      amountB: "0",
    })),
    ...buyRanges.map((r, i) => ({
      tickLower: r.tickLower,
      tickUpper: r.tickUpper,
      side: "buy" as Side,
      amountA: "0",
      amountB: allocB[i]?.toString() ?? "0",
    })),
  ];

  for (const pr of rawRanges) {
    if (pr.side === "buy" && isDowntrend) {
      pendingRanges.push(pr);
    } else {
      immediateRanges.push(pr);
    }
  }

  // 5. 即時発注レンジの一括発注
  let positionIds: string[] = [];
  if (immediateRanges.length > 0) {
    try {
      positionIds = await adapter.multiOpenPositions(pool, immediateRanges, walletAddress);
      log("initGrid", `一括発注成功: ${positionIds.length}件`);
    } catch (e) {
      log("initGrid", `一括発注失敗、個別発注へフォールバック: ${e}`);
      // 失敗分はすべて保留中キュー（pendingOpens）に積む
      for (const pr of immediateRanges) {
        enqueuePending(state, {
          id: generateId(),
          dex: adapter.dex,
          pool,
          tickLower: pr.tickLower,
          tickUpper: pr.tickUpper,
          side: pr.side,
          amountA: pr.amountA,
          amountB: pr.amountB,
          origin: "bot",
          mode: "grid",
          bandId: 1,
          walletAddress,
          retriesLeft: 3,
          createdAt: Date.now(),
          reason: "initGrid fallback",
        });
      }
    }
  }

  // 6. 発注結果をstateに反映
  const now = Date.now();
  positionIds.forEach((posId, i) => {
    const pr = immediateRanges[i];
    if (!pr) return;
    const pos: LpPosition = {
      positionId: posId,
      dex: adapter.dex,
      pool,
      tickLower: pr.tickLower,
      tickUpper: pr.tickUpper,
      currentTick,
      side: pr.side,
      amountA: pr.amountA,
      amountB: pr.amountB,
      usdValue: 0,
      origin: "bot",
      mode: "grid",
      gridIndex: i + 1,
      bandId: 1,
      walletAddress,
      openedAt: now,
      isActive: true,
    };
    upsertPosition(state, pos);
    state.dailyOpenCount++;
  });

  // 7. 下落トレンドで保留された buy レンジを pendingOpens に登録
  if (pendingRanges.length > 0) {
    for (const pr of pendingRanges) {
      enqueuePending(state, {
        id: generateId(),
        dex: adapter.dex,
        pool,
        tickLower: pr.tickLower,
        tickUpper: pr.tickUpper,
        side: pr.side,
        amountA: pr.amountA,
        amountB: pr.amountB,
        origin: "bot",
        mode: "grid",
        bandId: 1,
        walletAddress,
        retriesLeft: 3,
        createdAt: Date.now(),
        reason: "initGrid downtrend filter",
      });
    }
    addImportantEvent(
      state,
      "info",
      `[トレンド待機] 下落トレンド検出のため、初期 buy グリッド ${pendingRanges.length}本のオープンを保留し、待機キューに積みました。`
    );
  }

  const gasEst = await adapter.estimateGas("multiOpenPositions");
  recordGas(state, gasEst);

  addImportantEvent(
    state,
    "init",
    `初期グリッド生成完了: ${positionIds.length}本のLPを発注 pool=${pool}`
  );
  log("initGrid", `初期グリッド生成完了: ${positionIds.length}本`);
}

// ── 2.4/2.5 約定後処理 ────────────────────────────────────

export async function processFill(
  filledPos: LpPosition,
  adapter: IGridAdapter,
  state: GridState,
  walletAddress: string,
  priceHistory?: Record<string, number[]>,
  preSyncAmounts?: Map<string, { amountA: string; amountB: string }>
): Promise<void> {
  let TICK_SPACING = 60;
  if (adapter.dex === "cetus") {
    try {
      TICK_SPACING = await (adapter as any).getPoolTickSpacing(filledPos.pool);
    } catch {
      TICK_SPACING = filledPos.pool === "SUI/USDC" ? 2 : 60;
    }
  } else {
    TICK_SPACING = filledPos.pool === "SUI/USDC" ? 10 : 60;
  }

  log(
    "processFill",
    `約定処理: ${filledPos.positionId} side=${filledPos.side} pool=${filledPos.pool} mode=${filledPos.mode} bandId=${filledPos.bandId}`
  );

  // センターposition (bandId=-1) は約定処理しない（手数料獲得用のためロール不要）
  if (filledPos.bandId === -1 || filledPos.mode === "center") {
    log("processFill", `センターposition (${filledPos.positionId}) は約定ロール対象外。スキップ`);
    return;
  }

  // 再処理防止: 既にclosedAtがセット済みならスキップ（movePosition失敗後の再サイクル対策）
  if (filledPos.closedAt && Date.now() - filledPos.closedAt < 300_000) {
    log("processFill", `closedAt済みポジション (${filledPos.positionId}) は再処理スキップ (${Math.floor((Date.now() - filledPos.closedAt) / 1000)}秒前)`);
    return;
  }

  // closedAtをセット（以降のサイクルで再検出されてもスキップされる）
  filledPos.closedAt = Date.now();
  upsertPosition(state, filledPos);

  // 仕様 2.8: 往復完了チェック（反対方向の約定でrealizedを計上）
  const roundTripCompleted = await checkRoundTrip(filledPos, state, adapter);

  // 約定記録（preSyncAmountsから円環開始時のA量を取得）
  const preSync = preSyncAmounts?.get(filledPos.positionId);
  const startingAmountA = preSync?.amountA ?? filledPos.amountA;

  const fillEvent: FillEvent = {
    positionId: filledPos.positionId,
    pool: filledPos.pool,
    dex: filledPos.dex,
    side: filledPos.side,
    filledAt: Date.now(),
    amountA: filledPos.amountA,
    amountB: filledPos.amountB,
    startingAmountA,
    roundTripCompleted,
  };
  recordFill(state, fillEvent);

  // 次のレンジを計算（仕様 2.5）— 既存ポジションと重複しない空きレンジを探す
  const allCurrentPositions = getAllPositions(state)
    .filter((p) => p.pool === filledPos.pool && p.isActive && p.positionId !== filledPos.positionId)
    .map((p) => ({ tickLower: p.tickLower, tickUpper: p.tickUpper }));

  let newRange: { tickLower: number; tickUpper: number };
  let newSide: Side;

  if (filledPos.side === "sell") {
    // 上抜け約定: AがBになった → 直下にbuy LP
    newRange = nextBuyRange(filledPos.tickLower, filledPos.tickUpper, TICK_SPACING, allCurrentPositions);
    newSide = "buy";
    addImportantEvent(
      state,
      "fill",
      `LP引き出し ${filledPos.pool} [${filledPos.tickLower}–${filledPos.tickUpper}] (sell約定)→ [${newRange.tickLower}–${newRange.tickUpper}] buy を発注`
    );
  } else {
    // 下抜け約定: BでAを買えた → 直上にsell LP
    newRange = nextSellRange(filledPos.tickLower, filledPos.tickUpper, TICK_SPACING, allCurrentPositions);
    newSide = "sell";
    addImportantEvent(
      state,
      "fill",
      `LP引き出し ${filledPos.pool} [${filledPos.tickLower}–${filledPos.tickUpper}] (buy約定)→ [${newRange.tickLower}–${newRange.tickUpper}] sell を発注`
    );
  }

  // 1日発注上限チェック
  resetDailyCountersIfNeeded(state);
  if (state.dailyOpenCount >= state.autoConfig.maxOpensPerDay) {
    log("processFill", "本日の発注上限に達したため置き直しをスキップ");
    removePosition(state, filledPos.positionId);
    return;
  }

  // トレンドフィルター：下落トレンド時の buy 注文（SUI購入レンジ）の発注を一時停止する
  if (
    newSide === "buy" &&
    priceHistory &&
    priceHistory[filledPos.pool] &&
    isStrongDowntrend(priceHistory[filledPos.pool])
  ) {
    log("processFill", `[トレンド警告] 強い下落トレンドを検知したため、新規 buy 発注を保留し、クローズのみ実行して pendingOpens に登録します。`);

    let closedAmounts = { amountA: "0", amountB: "0" };
    try {
      closedAmounts = await adapter.closePosition(filledPos.positionId, walletAddress);
      log("processFill", `クローズ成功: amountA=${closedAmounts.amountA}, amountB=${closedAmounts.amountB}`);
    } catch (closeErr) {
      log("processFill", `クローズ失敗: ${closeErr}`);
      // クローズ失敗時はオンチェーンに残っているため何もしない（stateからも削除しない）
      addImportantEvent(
        state,
        "error",
        `LPクローズ失敗: ポジション ${filledPos.positionId} はオンチェーンで開いたままです。: ${closeErr}`
      );
      return;
    }

    // クローズ成功したら、古いポジションを削除し、新規ポジションを保留中キュー（pendingOpens）へ登録
    removePosition(state, filledPos.positionId);

    // スワップなし: 受け取ったトークン量を pending に渡す
    const pendingAmountA = "0";
    const pendingAmountB = closedAmounts.amountA;

    enqueuePending(state, {
      id: generateId(),
      dex: adapter.dex,
      pool: filledPos.pool,
      tickLower: newRange.tickLower,
      tickUpper: newRange.tickUpper,
      side: "buy",
      amountA: pendingAmountA,
      amountB: pendingAmountB,
      origin: "bot",
      mode: "grid",
      bandId: filledPos.bandId ?? 1,
      walletAddress,
      retriesLeft: 3,
      createdAt: Date.now(),
      reason: "processFill downtrend filter",
    });

    addImportantEvent(
      state,
      "info",
      `[トレンド待機] 下落トレンド検出のため、約定後の新 buy レンジ [${newRange.tickLower}–${newRange.tickUpper}] の発注を保留し、待機キューに積みました。`
    );
    return;
  }

  const newPositionRange: PositionRange = {
    tickLower: newRange.tickLower,
    tickUpper: newRange.tickUpper,
    side: newSide,
    amountA: newSide === "sell" ? filledPos.amountB : "0", // スワップなし: 受け取ったトークンをそのまま使用
    amountB: newSide === "buy" ? filledPos.amountA : "0",
  };

  // 仕様 2.7: 1トランザクションで「引き出し＋新規LP作成」を試みる
  try {
    const moveResult = await adapter.movePosition(
      filledPos.pool,
      filledPos.positionId,
      newPositionRange,
      walletAddress
    );
    log("processFill", `movePosition成功: ${moveResult.positionId} (amountA=${moveResult.amountA}, amountB=${moveResult.amountB})`);

    // stateから旧ポジションを削除し、新規ポジションを追加
    removePosition(state, filledPos.positionId);
    const currentTick = await adapter.getCurrentTick(filledPos.pool);
    const newPos: LpPosition = {
      positionId: moveResult.positionId,
      dex: adapter.dex,
      pool: filledPos.pool,
      tickLower: newRange.tickLower,
      tickUpper: newRange.tickUpper,
      currentTick,
      side: newSide,
      amountA: moveResult.amountA,
      amountB: moveResult.amountB,
      usdValue: filledPos.usdValue,
      origin: "bot",
      mode: "grid",
      gridIndex: filledPos.gridIndex,
      bandId: filledPos.bandId,
      walletAddress,
      openedAt: Date.now(),
      isActive: true,
    };
    upsertPosition(state, newPos);
    state.dailyOpenCount++;

    const gasEst = await adapter.estimateGas("movePosition");
    recordGas(state, gasEst);

    addImportantEvent(
      state,
      "fill",
      `LP移動完了 ${filledPos.pool} → [${newRange.tickLower}–${newRange.tickUpper}] (${newSide})`
    );
  } catch (e: any) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (errMsg.startsWith("CLOSE_FAILED")) {
      log("processFill", `movePosition失敗（クローズ失敗のため何もしません）: ${errMsg}`);
      addImportantEvent(
        state,
        "error",
        `LPクローズ失敗: ポジション ${filledPos.positionId} はオンチェーンで開いたままです。: ${errMsg}`
      );
      return;
    }

    let recoveredA = newPositionRange.amountA;
    let recoveredB = newPositionRange.amountB;

    if (errMsg.startsWith("OPEN_FAILED")) {
      const parts = errMsg.split("|");
      if (parts.length >= 3) {
        recoveredA = newSide === "sell" ? parts[1] : "0";
        recoveredB = newSide === "buy" ? parts[2] : "0";
      }
    }

    log("processFill", `movePosition失敗（クローズ成功、オープン失敗のためpendingへ）: ${errMsg}`);
    enqueuePending(state, {
      id: generateId(),
      dex: adapter.dex,
      pool: filledPos.pool,
      tickLower: newRange.tickLower,
      tickUpper: newRange.tickUpper,
      side: newSide,
      amountA: recoveredA,
      amountB: recoveredB,
      origin: "bot",
      mode: "grid",
      bandId: filledPos.bandId,
      walletAddress,
      retriesLeft: 3,
      createdAt: Date.now(),
      reason: `processFill after ${filledPos.side} fill fallback`,
    });
    removePosition(state, filledPos.positionId);
  }
}

// ── 往復完了チェック（仕様 2.8）────────────────────────────

async function checkRoundTrip(
  filledPos: LpPosition,
  state: GridState,
  adapter: IGridAdapter
): Promise<boolean> {
  // 同じレンジ帯・同じプールで反対方向の約定履歴を探す
  const opposite: Side = filledPos.side === "sell" ? "buy" : "sell";
  const recentFills = state.fillHistory.slice(0, 50);

  const pairedFill = recentFills.find(
    (f) =>
      f.pool === filledPos.pool &&
      f.dex === filledPos.dex &&
      f.side === opposite &&
      !f.roundTripCompleted
  );

  if (pairedFill) {
    pairedFill.roundTripCompleted = true;
    if (filledPos.side === "buy") {
      const diff = BigInt(filledPos.amountA) - BigInt(pairedFill.startingAmountA ?? pairedFill.amountA);
      if (diff > 0n) {
        const { symbolA } = adapter.getPoolSymbols(filledPos.pool);
        const dec = symbolA === "USDC" || symbolA === "DEEP" ? 1e6 : 1e9;
        const diffFloat = Number(diff) / dec;
        state.realized[symbolA] = (state.realized[symbolA] ?? 0) + diffFloat;
        addImportantEvent(
          state,
          "fill",
          `往復完了 ${filledPos.pool}: 差益 +${diffFloat.toFixed(6)} ${symbolA} (realized)`
        );
      }
    }
    return true;
  }
  return false;
}

// ── センターposition（LP手数料稼働）の維持 ──────────────

/**
 * 現在tickを跨ぐポジションが無ければ、新しいセンターpositionを作成する。
 * センターpositionは現在価格に常に被り、LP手数料を獲得する。
 */
export async function ensureCenterPosition(
  adapter: IGridAdapter,
  state: GridState,
  pool: string,
  walletAddress: string,
  currentTick: number
): Promise<void> {
  // 現在tickを跨ぐポジションが既にあるか確認（grid + center 両方チェック）
  const allPos = getAllPositions(state).filter((p) => p.pool === pool && p.isActive);
  const coveringPos = allPos.find(
    (p) => p.tickLower < currentTick && p.tickUpper > currentTick
  );
  if (coveringPos) return;

  // 保留中キューにも同プールのセンター発注があればスキップ（grid発注は許可）
  const centerPending = state.pendingOpens.some(
    (p) => p.pool === pool && (p.mode === "center" || p.bandId === -1)
  );
  if (centerPending) return;

  // ★ 古いセンターpositionを自動クローズ（現在tickを跨いでいないものを回収）
  const staleCenters = allPos.filter(
    (p) => p.mode === "center" && (p.tickLower >= currentTick || p.tickUpper <= currentTick)
  );
  for (const stale of staleCenters) {
    try {
      log("centerLP", `古いセンターpositionを自動クローズ: ${stale.positionId} [${stale.tickLower}-${stale.tickUpper}]`);
      await adapter.closePosition(stale.positionId, walletAddress);
      removePosition(state, stale.positionId);
      addImportantEvent(state, "info", `センターposition自動クローズ: ${stale.positionId} (現在tick=${currentTick}から離れたため回収)`);
      log("centerLP", `クローズ成功: ${stale.positionId}`);
    } catch (e) {
      log("centerLP", `古いセンターpositionのクローズ失敗（スキップ）: ${stale.positionId} — ${e}`);
    }
  }

  // センターposition用のレンジを生成（現在tickを中心に1グリッド幅）
  let tickSpacing = 60;
  if (adapter.dex === "cetus") {
    try {
      tickSpacing = await (adapter as any).getPoolTickSpacing(pool);
    } catch {
      tickSpacing = pool === "SUI/USDC" ? 2 : 60;
    }
  }

  const gridWidth = state.autoConfig.currentRangeWidthPct ?? state.initParams.gridWidthPct;
  const currentPrice = tickToPrice(currentTick);
  const upperPrice = currentPrice * (1 + gridWidth / 100);
  const gridWidthInTicks = Math.abs(
    roundToTickSpacing(priceToTick(upperPrice), tickSpacing) -
    roundToTickSpacing(currentTick, tickSpacing)
  );
  const width = Math.max(gridWidthInTicks, tickSpacing);

  const centerHalf = Math.max(Math.floor(width / 2), tickSpacing);
  const tickLower = roundToTickSpacing(currentTick - centerHalf, tickSpacing);
  const tickUpper = roundToTickSpacing(currentTick + centerHalf, tickSpacing);

  // 現在tickを确实に跨ぐか確認
  if (tickLower >= currentTick || tickUpper <= currentTick) return;

  // トークン残高から少量を配分（全体の10%程度）
  try {
    const balances = await adapter.getWalletBalances(walletAddress);
    const { symbolA, symbolB } = adapter.getPoolSymbols(pool);
    const rawA = BigInt(balances[symbolA] ?? "0");
    const rawB = BigInt(balances[symbolB] ?? "0");
    const gasBuffer = BigInt(process.env.GAS_BUFFER_MIST ?? "100000000");

    const availA = symbolA === "SUI" && rawA > gasBuffer ? rawA - gasBuffer : rawA;
    const availB = symbolB === "SUI" && rawB > gasBuffer ? rawB - gasBuffer : rawB;

    // センター用に全体の10%を配分
    const centerA = (availA * 10n) / 100n;
    const centerB = (availB * 10n) / 100n;

    if (centerA === 0n && centerB === 0n) {
      log("centerLP", `トークン残高不足のためセンターposition作成スキップ: ${symbolA}=${rawA}, ${symbolB}=${rawB}`);
      return;
    }

    enqueuePending(state, {
      id: generateId(),
      dex: adapter.dex,
      pool,
      tickLower,
      tickUpper,
      side: "buy",
      amountA: String(centerA),
      amountB: String(centerB),
      origin: "bot",
      mode: "center",
      bandId: -1,
      walletAddress,
      retriesLeft: 3,
      createdAt: Date.now(),
      reason: "ensureCenterPosition: LP手数料稼働用センターposition",
    });

    addImportantEvent(
      state,
      "init",
      `センターposition作成: ${pool} [${tickLower}-${tickUpper}] (現在tick=${currentTick}, LP手数料獲得用)`
    );
    log("centerLP", `センターposition pending作成: pool=${pool} [${tickLower}-${tickUpper}]`);
  } catch (e) {
    log("centerLP", `センターposition作成失敗: ${e}`);
  }
}

// ── 2.10 自動再初期化判定 ─────────────────────────────────

export function checkReinit(
  state: GridState,
  pool: string,
  currentTick: number
): boolean {
  const config = state.autoConfig;
  if (!config.autoReinit) return false;

  // すでに発注処理がキューに積まれている場合は多重初期化を避けるためスキップ
  if (state.pendingOpens.some((p) => p.pool === pool)) return false;

  const positions = getAllPositions(state).filter((p) => p.pool === pool && p.isActive && p.bandId !== -1 && p.mode !== "center");
  if (positions.length >= config.autoReinitMinPositions) return false;

  // 現在価格を中心とした±レンジ幅内にLPが存在しないか確認
  const widthInTicks = 1000; // 暫定値
  const nearbyPositions = positions.filter(
    (p) =>
      p.tickLower < currentTick + widthInTicks &&
      p.tickUpper > currentTick - widthInTicks
  );

  if (nearbyPositions.length > 0) return false;

  addImportantEvent(
    state,
    "init",
    `自動初期化判定: pool=${pool} 検出ポジション${positions.length}件(<${config.autoReinitMinPositions})かつレンジ内LP0件のため再初期化実行`
  );
  return true;
}

// ── 2.2 毎周回のメイン処理 ────────────────────────────────

export async function runCycle(
  adapter: IGridAdapter,
  state: GridState,
  pools: string[],
  walletAddress: string,
  priceHistory: Record<string, number[]>
): Promise<void> {
  const cycleStart = Date.now();
  log("runCycle", `=== 周回開始: ${new Date().toISOString()} ===`);

  // 1日カウンタリセット
  resetDailyCountersIfNeeded(state);

  for (const pool of pools) {
    try {
      await processCycleForPool(adapter, state, pool, walletAddress, priceHistory);
    } catch (e) {
      log("runCycle", `プール ${pool} の処理でエラー: ${e}`);
      addImportantEvent(state, "error", `周回エラー pool=${pool}: ${e}`);
    }
  }

  // pendingOpens のリトライ処理
  await processPendingOpens(adapter, state, walletAddress, pools, priceHistory);

  state.lastCycleAt = Date.now();
  saveState(state);

  // サイクルカウントを増加
  cycleCounter++;

  // 初回フルスキャン完了フラグ（100サイクルごとにフルスキャンを再実行して孤立ポジションを発見）
  if (!startupFullScanDone) {
    startupFullScanDone = true;
  } else if (cycleCounter % 100 === 0) {
    startupFullScanDone = false;
    log("runCycle", `定期フルスキャンを実行します (cycle=${cycleCounter})`);
  }

  log("runCycle", `=== 周回完了: ${Date.now() - cycleStart}ms ===`);
}

async function processCycleForPool(
  adapter: IGridAdapter,
  state: GridState,
  pool: string,
  walletAddress: string,
  priceHistory: Record<string, number[]>
): Promise<void> {
  // 1. オンチェーンからLPを取得（オンチェーンを正とする）
  // 起動初回はフルス캔で全ポジションを発見し、以降は追跡IDのみ高速取得
  const knownIds = startupFullScanDone
    ? getAllPositions(state).filter((p) => p.pool === pool).map((p) => p.positionId)
    : []; // 起動初回: knownIdsを空にして全件スキャン
  const onchainPositions = await adapter.getAllPositions(walletAddress, knownIds, state.positions);

  // 2. 対象プールのみに絞り込む（GRID_POOLS フィルタ）
  const filtered = onchainPositions.filter((p) => p.pool === pool);

  // 3. 現在tickを取得
  const currentTick = await adapter.getCurrentTick(pool);
  const currentPrice = await adapter.getCurrentPrice(pool);
  state.currentPrices[pool] = currentPrice;

  // 価格履歴に追加
  if (!priceHistory[pool]) priceHistory[pool] = [];
  priceHistory[pool].push(currentPrice);
  if (priceHistory[pool].length > 120) priceHistory[pool].shift(); // 最新120件

  // tickSpacing取得
  let tickSpacing = 60;
  if (adapter.dex === "cetus") {
    try {
      tickSpacing = await (adapter as any).getPoolTickSpacing(pool);
    } catch {
      tickSpacing = pool === "SUI/USDC" ? 2 : 60;
    }
  } else {
    tickSpacing = pool === "SUI/USDC" ? 10 : 60;
  }

  // 4. stateとオンチェーン状態を同期（オンチェーン優先）
  const onchainIds = new Set(filtered.map((p) => p.positionId));
  const statePositions = getAllPositions(state).filter((p) => p.pool === pool);

  // 円環損益計算用: upsertPositionで上書きされる前の元量を保存
  const preSyncAmounts = new Map<string, { amountA: string; amountB: string }>();
  for (const sp of statePositions) {
    preSyncAmounts.set(sp.positionId, { amountA: sp.amountA, amountB: sp.amountB });
  }

  // stateに存在するがオンチェーンにないポジションを削除 (作成後60秒経過した安全なもののみ、かつ3回連続未検出時のみ削除実行)
  for (const sp of statePositions) {
    if (!onchainIds.has(sp.positionId)) {
      const ageMs = Date.now() - (sp.openedAt || 0);
      if (ageMs > 60 * 1000) {
        const count = (missingCounts.get(sp.positionId) ?? 0) + 1;
        missingCounts.set(sp.positionId, count);

        if (count >= 3) {
          log("runCycle", `オンチェーンから消えたポジションを完全に削除します: ${sp.positionId} (経過時間: ${Math.floor(ageMs / 1000)}秒)`);
          removePosition(state, sp.positionId);
          missingCounts.delete(sp.positionId);
        } else {
          log("runCycle", `[RPC遅延警告] ポジション ${sp.positionId} が未検出です。クエリ漏れの可能性があるため削除を一時猶予します (未検出カウント: ${count}/3, 経過時間: ${Math.floor(ageMs / 1000)}秒)`);
        }
      } else {
        log("runCycle", `[RPC遅延保護] 新規ポジション検出猶予中: ${sp.positionId} (経過時間: ${Math.floor(ageMs / 1000)}秒)`);
      }
    } else {
      // 検出された場合は未検出カウンタをゼロにリセット
      missingCounts.delete(sp.positionId);
    }
  }

  // オンチェーンポジションをstateに反映
  for (const pos of filtered) {
    const existing = state.positions[pos.positionId];
    const side = existing ? existing.side : calcSide(
      pos.tickLower,
      pos.tickUpper,
      currentTick,
      BigInt(pos.amountA),
      BigInt(pos.amountB)
    );
    // closedAtはオンチェーンにないため、既存stateの値を保持
    const closedAt = existing?.closedAt;
    upsertPosition(state, { ...pos, side, currentTick, isActive: true, ...(closedAt ? { closedAt } : {}) });
  }

  // 5. ダブルポジション解消:
  //    a) 完全重複: 同じtickLower:tickUpper → 最も新しいものだけ残す
  //    b) オーバーラップ: 同じtickLower+side → 幅が最もtargetGridWidthに近いものを残す
  const statePositionsAfterSync = getAllPositions(state).filter((p) => p.pool === pool);
  const targetWidth = state.autoConfig.currentRangeWidthPct
    ? (() => {
        const curPrice = tickToPrice(currentTick);
        const upperPrice = curPrice * (1 + state.autoConfig.currentRangeWidthPct / 100);
        const width = Math.abs(
          roundToTickSpacing(priceToTick(upperPrice), tickSpacing) -
          roundToTickSpacing(currentTick, tickSpacing)
        );
        return Math.max(width, tickSpacing);
      })()
    : null;

  // a) 完全重複削除
  const byTickRange = new Map<string, LpPosition[]>();
  for (const sp of statePositionsAfterSync) {
    const key = `${sp.tickLower}:${sp.tickUpper}`;
    const arr = byTickRange.get(key) ?? [];
    arr.push(sp);
    byTickRange.set(key, arr);
  }
  for (const [key, posArr] of byTickRange) {
    if (posArr.length > 1) {
      posArr.sort((a, b) => b.openedAt - a.openedAt);
      const [keep, ...dups] = posArr;
      for (const dup of dups) {
        log("runCycle", `重複ポジション削除(完全): ${dup.positionId} (${key}, openedAt=${dup.openedAt})`);
        removePosition(state, dup.positionId);
        try {
          await adapter.closePosition(dup.positionId, walletAddress);
          log("runCycle", `オンチェーンクローズ成功(完全重複): ${dup.positionId}`);
        } catch (closeErr) {
          log("runCycle", `オンチェーンクローズ失敗(完全重複): ${dup.positionId} — ${closeErr}`);
        }
      }
    }
  }

  // b) 同じtickLower+sideのオーバーラップ解消（grid幅が近い方を残す）
  if (targetWidth !== null) {
    const refreshedPositions = getAllPositions(state).filter((p) => p.pool === pool);
    const byLowerSide = new Map<string, LpPosition[]>();
    for (const sp of refreshedPositions) {
      const key = `${sp.tickLower}:${sp.side}`;
      const arr = byLowerSide.get(key) ?? [];
      arr.push(sp);
      byLowerSide.set(key, arr);
    }
    for (const [key, posArr] of byLowerSide) {
      if (posArr.length > 1) {
        posArr.sort((a, b) => {
          const diffA = Math.abs((a.tickUpper - a.tickLower) - targetWidth);
          const diffB = Math.abs((b.tickUpper - b.tickLower) - targetWidth);
          return diffA - diffB || b.openedAt - a.openedAt;
        });
        const [keep, ...dups] = posArr;
        for (const dup of dups) {
          log("runCycle", `重複ポジション削除(オーバーラップ): ${dup.positionId} (${key} width=${dup.tickUpper - dup.tickLower}, 保持width=${keep.tickUpper - keep.tickLower})`);
          removePosition(state, dup.positionId);
          try {
            await adapter.closePosition(dup.positionId, walletAddress);
            log("runCycle", `オンチェーンクローズ成功(オーバーラップ): ${dup.positionId}`);
          } catch (closeErr) {
            log("runCycle", `オンチェーンクローズ失敗(オーバーラップ): ${dup.positionId} — ${closeErr}`);
          }
        }
      }
    }
  }

  // 5. 約定判定
  const updatedPositions = getAllPositions(state).filter((p) => p.pool === pool);

  for (const pos of updatedPositions) {
    // 周回あたりの最大発注数ガード
    if (state.dailyOpenCount >= state.autoConfig.maxOpensPerDay) {
      log("runCycle", "本日の発注上限に達したため約定処理をスキップ");
      break;
    }

    let filled = false;
    if (pos.side === "sell" && isSellFilled(currentTick, pos.tickUpper)) {
      filled = true;
    } else if (pos.side === "buy" && isBuyFilled(currentTick, pos.tickLower)) {
      filled = true;
    }

    if (filled) {
      await processFill(pos, adapter, state, walletAddress, priceHistory, preSyncAmounts);
    }
  }

  // 5.5. センターpositionの維持（LP手数料稼働）
  await ensureCenterPosition(adapter, state, pool, walletAddress, currentTick);

  // 6. 自動再初期化判定
  if (checkReinit(state, pool, currentTick)) {
    await initGrid(adapter, state, pool, walletAddress, priceHistory);
  }

  // 7. 自動調整ロジック実行
  const prices = priceHistory[pool] ?? [];

  // 監視間隔自動調整
  if (state.autoConfig.autoInterval) {
    const newInterval = autoTuneInterval(prices, state.autoConfig);
    state.autoConfig.currentPollSec = newInterval;
  }

  // レンジ幅自動調整
  if (state.autoConfig.autoRangeWidth) {
    if (pool === "SUI/USDC") {
      state.autoConfig.currentRangeWidthPct = 0.61;
    } else {
      const recentFills = state.fillHistory.filter(
        (f) => f.pool === pool && f.filledAt > Date.now() - 60 * 60 * 1000
      ).length;
      const newWidth = autoTuneRangeWidth(
        recentFills,
        60,
        state.autoConfig.currentRangeWidthPct ?? 2,
        state.autoConfig
      );
      state.autoConfig.currentRangeWidthPct = newWidth;
    }
  }

  // GAP↔GRID 自動昇降格
  const allPositions = getAllPositions(state).filter((p) => p.pool === pool);
  const promoted = autoPromoteGapToGrid(state, allPositions, currentTick);
  const demoted = autoDemoteGridToGap(state, promoted, currentTick);
  for (const pos of demoted) {
    upsertPosition(state, pos);
  }

  log(
    "runCycle",
    `pool=${pool} tick=${currentTick} price=${currentPrice.toFixed(8)} positions=${updatedPositions.length}`
  );
}

// ── pendingOpens リトライ処理 ─────────────────────────────

async function processPendingOpens(
  adapter: IGridAdapter,
  state: GridState,
  walletAddress: string,
  pools: string[],
  priceHistory: Record<string, number[]>
): Promise<void> {
  // 担当プールのみをフィルタリング
  const pendingForThisBot = state.pendingOpens.filter((p) => pools.includes(p.pool));
  if (pendingForThisBot.length === 0) return;

  // 周回あたりの発注上限確認
  const maxThisCycle = Math.min(
    state.autoConfig.maxOpensPerCycle,
    state.autoConfig.maxOpensPerDay - state.dailyOpenCount
  );
  if (maxThisCycle <= 0) return;

  const toProcess = pendingForThisBot.slice(0, maxThisCycle);

  for (const pending of toProcess) {
    if (pending.side === "buy" && isStrongDowntrend(priceHistory[pending.pool] || [])) {
      log("pendingRetry", `[トレンド待機] 下落トレンド継続中のため、保留中の buy 発注をスキップします: pool=${pending.pool} ticks=[${pending.tickLower}, ${pending.tickUpper}]`);
      continue;
    }

    try {
      const posId = await adapter.openPosition(
        pending.pool,
        {
          tickLower: pending.tickLower,
          tickUpper: pending.tickUpper,
          side: pending.side,
          amountA: pending.amountA,
          amountB: pending.amountB,
        },
        walletAddress
      );

      // 成功: stateに追加、pendingから削除
      const currentTick = await adapter.getCurrentTick(pending.pool);
      const pos: LpPosition = {
        positionId: posId,
        dex: pending.dex,
        pool: pending.pool,
        tickLower: pending.tickLower,
        tickUpper: pending.tickUpper,
        currentTick,
        side: pending.side,
        amountA: pending.amountA,
        amountB: pending.amountB,
        usdValue: 0,
        origin: "bot",
        mode: pending.mode,
        gridIndex: 0,
        bandId: pending.bandId,
        walletAddress,
        openedAt: Date.now(),
        isActive: true,
      };
      upsertPosition(state, pos);
      state.dailyOpenCount++;

      const idx = state.pendingOpens.indexOf(pending);
      if (idx >= 0) state.pendingOpens.splice(idx, 1);

      log("pendingRetry", `成功: ${posId}`);
    } catch (e) {
      pending.retriesLeft--;
      if (pending.retriesLeft <= 0) {
        const idx = state.pendingOpens.indexOf(pending);
        if (idx >= 0) state.pendingOpens.splice(idx, 1);
        addImportantEvent(
          state,
          "error",
          `pending発注失敗・破棄: ${pending.pool} [${pending.tickLower},${pending.tickUpper}] ${e}`
        );
      }
      log("pendingRetry", `失敗 残りリトライ${pending.retriesLeft}: ${e}`);
    }
  }
}
