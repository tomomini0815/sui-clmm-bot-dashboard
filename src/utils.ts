// ============================================================
// src/utils.ts  — tick計算・LP向き判定などユーティリティ
// ============================================================

import type { Side } from "./types.js";

// ── Tick ↔ Price 変換 ─────────────────────────────────────

/**
 * tick から price を計算 (Uniswap V3 式)
 * price = 1.0001^tick
 */
export function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

/**
 * price から tick を計算
 * tick = log(price) / log(1.0001)
 */
export function priceToTick(price: number): number {
  return Math.log(price) / Math.log(1.0001);
}

/**
 * tickSpacing の倍数に丸める（切り下げ）
 */
export function roundToTickSpacing(tick: number, tickSpacing: number): number {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

/**
 * 現在価格から % 変動後の tick を計算し tickSpacing に丸める
 * direction: 1=上方向, -1=下方向
 */
export function pctToTick(
  pct: number,
  currentTick: number,
  tickSpacing: number,
  direction: 1 | -1
): number {
  const currentPrice = tickToPrice(currentTick);
  const targetPrice = currentPrice * (1 + (direction * pct) / 100);
  const rawTick = priceToTick(targetPrice);
  return roundToTickSpacing(rawTick, tickSpacing);
}

// ── LP向き判定 ────────────────────────────────────────────

/**
 * currentTick とレンジから LP の向き（side）を判定する
 * 仕様 2.3 に従う
 */
export function calcSide(
  tickLower: number,
  tickUpper: number,
  currentTick: number,
  amountA: bigint,
  amountB: bigint
): Side {
  if (tickLower >= currentTick) {
    // 価格より上 → 片側A（sell）
    return "sell";
  }
  if (tickUpper <= currentTick) {
    // 価格より下 → 片側B（buy）
    return "buy";
  }
  // 現在価格がレンジをまたぐ → 保有量の多い方で仮分類
  return amountA >= amountB ? "sell" : "buy";
}

// ── 約定判定 ──────────────────────────────────────────────

/**
 * sell LP が上抜け約定したか（仕様 2.4）
 */
export function isSellFilled(currentTick: number, tickUpper: number): boolean {
  return currentTick >= tickUpper;
}

/**
 * buy LP が下抜け約定したか（仕様 2.4）
 */
export function isBuyFilled(currentTick: number, tickLower: number): boolean {
  return currentTick < tickLower;
}

// ── グリッド幅計算 ────────────────────────────────────────

/**
 * 約定したLPの帯幅を返す（tick数）
 * 仕様 2.6: 次のグリッド幅 = 約定したLP自身の tickUpper - tickLower
 */
export function calcGridWidth(tickLower: number, tickUpper: number): number {
  return tickUpper - tickLower;
}

/**
 * sell LP が約定したとき、次の buy LP のレンジを計算
 * → 約定した sell の直下にbuyを置く
 * → 既存ポジションと重複しないよう、空きレンジを探す
 */
export function nextBuyRange(
  filledTickLower: number,
  filledTickUpper: number,
  tickSpacing: number,
  existingPositions?: { tickLower: number; tickUpper: number }[]
): { tickLower: number; tickUpper: number } {
  const width = calcGridWidth(filledTickLower, filledTickUpper);
  let newTickUpper = roundToTickSpacing(filledTickLower, tickSpacing);
  let newTickLower = roundToTickSpacing(newTickUpper - width, tickSpacing);

  if (existingPositions && existingPositions.length > 0) {
    const occupied = new Set(
      existingPositions.map((p) => `${p.tickLower}:${p.tickUpper}`)
    );
    // 重複するレンジが見つかる限り下方向にシフト
    let maxIter = 50;
    while (occupied.has(`${newTickLower}:${newTickUpper}`) && maxIter-- > 0) {
      newTickUpper = newTickLower;
      newTickLower = roundToTickSpacing(newTickUpper - width, tickSpacing);
    }
  }

  return { tickLower: newTickLower, tickUpper: newTickUpper };
}

/**
 * buy LP が約定したとき、次の sell LP のレンジを計算
 * → 約定した buy の直上にsellを置く
 * → 既存ポジションと重複しないよう、空きレンジを探す
 */
export function nextSellRange(
  filledTickLower: number,
  filledTickUpper: number,
  tickSpacing: number,
  existingPositions?: { tickLower: number; tickUpper: number }[]
): { tickLower: number; tickUpper: number } {
  const width = calcGridWidth(filledTickLower, filledTickUpper);
  let newTickLower = roundToTickSpacing(filledTickUpper, tickSpacing);
  let newTickUpper = roundToTickSpacing(newTickLower + width, tickSpacing);

  if (existingPositions && existingPositions.length > 0) {
    const occupied = new Set(
      existingPositions.map((p) => `${p.tickLower}:${p.tickUpper}`)
    );
    // 重複するレンジが見つかる限り上方向にシフト
    let maxIter = 50;
    while (occupied.has(`${newTickLower}:${newTickUpper}`) && maxIter-- > 0) {
      newTickLower = newTickUpper;
      newTickUpper = roundToTickSpacing(newTickLower + width, tickSpacing);
    }
  }

  return { tickLower: newTickLower, tickUpper: newTickUpper };
}

// ── グリッド初期レンジ生成 ────────────────────────────────

export interface GridRangeSpec {
  tickLower: number;
  tickUpper: number;
  side: Side;
  level: number;  // 0が現在価格に最も近い
}

/**
 * initGrid 用: 現在tick・%幅からレンジ一覧を生成
 * 仕様 2.10 アルゴリズム step 2-3
 */
export function buildInitRanges(
  currentTick: number,
  gridWidthPct: number,
  levelsUp: number,
  levelsDown: number,
  tickSpacing: number
): GridRangeSpec[] {
  const ranges: GridRangeSpec[] = [];

  // 現在価格から1グリッド幅のtick数を算出
  const currentPrice = tickToPrice(currentTick);
  const upperPrice = currentPrice * (1 + gridWidthPct / 100);
  const gridWidthInTicks = Math.abs(
    roundToTickSpacing(priceToTick(upperPrice), tickSpacing) -
    roundToTickSpacing(currentTick, tickSpacing)
  );
  // 最低でもticksSpacing分は確保
  const width = Math.max(gridWidthInTicks, tickSpacing);

  // 現在tickをticksSpacingに丸めた基準点
  const baseUpper = roundToTickSpacing(currentTick, tickSpacing);

  // LP手数料を稼ぐセンターposition（現在tickを跨ぐ）
  // 現在tickを中心に、1グリッド幅のレンジを配置
  const centerHalf = Math.max(Math.floor(width / 2), tickSpacing);
  const centerLower = roundToTickSpacing(currentTick - centerHalf, tickSpacing);
  const centerUpper = roundToTickSpacing(currentTick + centerHalf, tickSpacing);
  // 現在tickを确实に跨ぐように保証
  if (centerLower < currentTick && centerUpper > currentTick) {
    ranges.push({ tickLower: centerLower, tickUpper: centerUpper, side: "buy", level: -1 });
  }

  // 現在価格直上のsell LPを生成（level 0 が最も近い）
  for (let i = 0; i < levelsUp; i++) {
    const tickLower = baseUpper + width * i;
    const tickUpper = baseUpper + width * (i + 1);
    ranges.push({ tickLower, tickUpper, side: "sell", level: i });
  }

  // 現在価格直下のbuy LPを生成
  for (let i = 0; i < levelsDown; i++) {
    const tickUpper = baseUpper - width * i;
    const tickLower = baseUpper - width * (i + 1);
    ranges.push({ tickLower, tickUpper, side: "buy", level: i });
  }

  return ranges;
}

// ── 資産配分 ──────────────────────────────────────────────

/**
 * 資本を levels 本のレンジへ配分する
 * allocMode="equal" → 均等分割
 * allocMode="geometric" → 価格から離れるほど多く（比率: level+1 合計で割る）
 */
export function allocateCapital(
  totalAmount: bigint,
  levels: number,
  allocMode: "equal" | "geometric"
): bigint[] {
  if (levels === 0) return [];

  if (allocMode === "equal") {
    const perLevel = totalAmount / BigInt(levels);
    const alloc = Array(levels).fill(perLevel);
    // 端数は最初のレンジに加算
    alloc[0] += totalAmount - perLevel * BigInt(levels);
    return alloc;
  }

  // geometric: 0番が一番多く（現在価格に近い方が厚い）
  const weights = Array.from({ length: levels }, (_, i) => levels - i);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const alloc = weights.map((w) => (totalAmount * BigInt(w)) / BigInt(totalWeight));
  // 端数補正
  const allocated = alloc.reduce((s, a) => s + a, 0n);
  alloc[0] += totalAmount - allocated;
  return alloc;
}

// ── UUID生成 ──────────────────────────────────────────────

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── 数値フォーマット ──────────────────────────────────────

export function formatAmount(amount: string, decimals = 9): string {
  try {
    const n = BigInt(amount);
    const d = BigInt(10 ** decimals);
    const int = n / d;
    const frac = n % d;
    const fracStr = frac.toString().padStart(decimals, "0").slice(0, 6);
    return `${int}.${fracStr}`;
  } catch {
    return amount;
  }
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}

// ── 在庫偏り計算 ──────────────────────────────────────────

/**
 * A/B の保有量から偏り度（A側の割合%）を返す
 */
export function calcInventorySkewPct(
  totalA: bigint,
  totalB: bigint,
  priceAinB: number   // 1A = ? B の価格
): number {
  if (totalA === 0n && totalB === 0n) return 50;
  const aInB = Number(totalA) * priceAinB;
  const bTotal = aInB + Number(totalB);
  if (bTotal === 0) return 50;
  return (aInB / bTotal) * 100;
}

// ── ボラティリティ計算 ────────────────────────────────────

/**
 * 直近の価格サンプルから標準偏差ベースのボラティリティ(%)を計算
 */
export function calcVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;
  const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
  const variance =
    prices.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / prices.length;
  return (Math.sqrt(variance) / mean) * 100;
}

// ── トレンドフィルター計算 ────────────────────────────────

export function calculateEma(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

export function isStrongDowntrend(prices: number[]): boolean {
  if (process.env.TREND_FILTER_ENABLED !== "true") {
    return false;
  }
  const period = parseInt(process.env.TREND_FILTER_EMA_PERIOD ?? "20");
  if (!prices || prices.length < period + 5) {
    // 履歴データが十分に蓄積されるまでは安全のため判定をスキップ
    return false;
  }

  const emaToday = calculateEma(prices, period);
  const emaYesterday = calculateEma(prices.slice(0, -1), period);
  const currentPrice = prices[prices.length - 1];

  // 現在価格がEMAを下回り、かつEMAの方向が下向きの場合を強い下落トレンドと見なす
  return currentPrice < emaToday && emaToday < emaYesterday;
}
