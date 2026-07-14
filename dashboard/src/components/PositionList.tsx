import React, { useState } from "react";
import type { LpPosition, Dex, Mode } from "../types";

const TOKEN_ICONS: Record<string, string> = {
  SUI: "🔵", USDC: "💵", CETUS: "🐟", DEEP: "🌊", NS: "⚡", MAGMA: "🔥",
};

function formatAmount(amount: string, decimals = 9): string {
  const n = Number(amount) / Math.pow(10, decimals);
  if (n === 0) return "0";
  if (n < 0.0001) return n.toExponential(3);
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function getDecimals(pool: string) {
  if (pool === "SUI/USDC") return { decA: 6, decB: 9 };
  if (pool === "DEEP/SUI") return { decA: 6, decB: 9 };
  return { decA: 9, decB: 9 };
}

function formatPriceFromTick(tick: number, pool: string): string {
  const rawPrice = Math.pow(1.0001, tick);
  return formatPriceFromRaw(rawPrice, pool);
}

function formatPriceFromRaw(rawPrice: number, pool: string): string {
  if (rawPrice === 0) return "0";
  const { decA, decB } = getDecimals(pool);
  
  if (pool === "SUI/USDC") {
    // SUI/USDC: CoinA=USDC (decA=6), CoinB=SUI (decB=9)
    // rawPrice * 10^-3 = SUI per USDC (ドルベース / 1.37). 逆数で SUIのUSD価格 (コインベース / 0.73) に変換
    const p = 1 / (rawPrice * Math.pow(10, decA - decB));
    return p.toFixed(4);
  } else if (pool === "DEEP/SUI") {
    const p = rawPrice * Math.pow(10, decA - decB);
    return p.toFixed(6);
  }
  return rawPrice.toFixed(4);
}

function calcUsdValue(pos: LpPosition, prices: Record<string, number>): number {
  // SUI/USDCの価格からSUIのUSD価格を算出
  const suiUsdcRaw = prices["SUI/USDC"];
  const suiPriceUsd = suiUsdcRaw ? 1 / (suiUsdcRaw * 0.001) : 0;

  if (pos.pool === "SUI/USDC") {
    const amountAUsd = Number(pos.amountA) / 1e6;
    const amountBUsd = (Number(pos.amountB) / 1e9) * suiPriceUsd;
    return amountAUsd + amountBUsd;
  } else if (pos.pool === "DEEP/SUI") {
    const deepSuiRaw = prices["DEEP/SUI"];
    const deepPriceInSui = deepSuiRaw ? deepSuiRaw * 0.001 : 0;
    const amountASui = (Number(pos.amountA) / 1e6) * deepPriceInSui;
    const amountBSui = Number(pos.amountB) / 1e9;
    return (amountASui + amountBSui) * suiPriceUsd;
  }
  return pos.usdValue || 0; // fallback
}

function isActiveRow(pos: LpPosition): boolean {
  return pos.currentTick >= pos.tickLower && pos.currentTick <= pos.tickUpper;
}

// ── プール別・モード別グルーピング ────────────────────────

interface PoolGroup {
  pool: string;
  dex: Dex;
  mode: Mode;
  positions: LpPosition[];
  currentPrice: number;
}

function groupPositions(
  positions: LpPosition[],
  prices: Record<string, number>
): PoolGroup[] {
  const map = new Map<string, PoolGroup>();

  for (const pos of positions) {
    const key = `${pos.pool}-${pos.dex}-${pos.mode}`;
    if (!map.has(key)) {
      map.set(key, {
        pool: pos.pool,
        dex: pos.dex,
        mode: pos.mode,
        positions: [],
        currentPrice: prices[pos.pool] ?? 0,
      });
    }
    map.get(key)!.positions.push(pos);
  }

  return Array.from(map.values()).sort((a, b) => a.pool.localeCompare(b.pool));
}

// ── グリッド帯タブ ────────────────────────────────────────

function BandTabs({
  bands,
  activeBand,
  onSelect,
}: {
  bands: number[];
  activeBand: number | "all";
  onSelect: (b: number | "all") => void;
}) {
  return (
    <div className="band-tabs">
      <button
        className={`band-tab ${activeBand === "all" ? "active" : ""}`}
        onClick={() => onSelect("all")}
      >
        すべて
      </button>
      {bands.map((b) => (
        <button
          key={b}
          className={`band-tab ${activeBand === b ? "active" : ""}`}
          onClick={() => onSelect(b)}
        >
          帯 {b}
        </button>
      ))}
      <button className="band-tab band-tab-add">＋</button>
    </div>
  );
}

// ── ポジション行 ──────────────────────────────────────────

function PositionRow({ pos, index, tokenA, tokenB, prices }: {
  pos: LpPosition;
  index: number;
  tokenA: string;
  tokenB: string;
  prices: Record<string, number>;
}) {
  const active = isActiveRow(pos);

  // 逆数化したため、tickLower / tickUpper から得られる価格の大小が逆転するのを考慮してソートして表示
  const p1 = Number(formatPriceFromTick(pos.tickLower, pos.pool));
  const p2 = Number(formatPriceFromTick(pos.tickUpper, pos.pool));
  const minP = Math.min(p1, p2);
  const maxP = Math.max(p1, p2);
  const dec = pos.pool === "DEEP/SUI" ? 6 : 4;
  const lowerPrice = minP.toFixed(dec);
  const upperPrice = maxP.toFixed(dec);

  // プールごとの物理的な CoinA/B の decimals 定義
  let decA = 9;
  let decB = 9;
  if (pos.pool === "SUI/USDC") {
    decA = 6; // CoinA = USDC
    decB = 9; // CoinB = SUI
  } else if (pos.pool === "DEEP/SUI") {
    decA = 6; // CoinA = DEEP
    decB = 9; // CoinB = SUI
  }

  // 表示順（pool.split("/")）と物理 CoinA/B のマッピング
  const isReversed = pos.pool === "SUI/USDC";
  const displayAmountA = isReversed ? pos.amountB : pos.amountA;
  const displayAmountB = isReversed ? pos.amountA : pos.amountB;
  const displayDecA = isReversed ? decB : decA;
  const displayDecB = isReversed ? decA : decB;

  const amountA = formatAmount(displayAmountA, displayDecA);
  const amountB = formatAmount(displayAmountB, displayDecB);
  const usdValue = calcUsdValue(pos, prices);

  let color = "#C084FC";
  let bg = "rgba(139, 92, 246, 0.15)";
  let borderColor = "rgba(139, 92, 246, 0.4)";

  if (active) {
    color = "#34D399";
    bg = "rgba(16, 185, 129, 0.25)";
    borderColor = "1px solid #10B981";
  } else if (pos.mode === "center") {
    color = "#F472B6";
    bg = "rgba(244, 114, 182, 0.2)";
    borderColor = "1px solid #EC4899";
  } else if (pos.mode === "gap") {
    color = "#FBBF24";
    bg = "rgba(245, 158, 11, 0.2)";
    borderColor = "1px solid #F59E0B";
  } else if (pos.mode === "grid") {
    color = "#60A5FA";
    bg = "rgba(59, 130, 246, 0.2)";
    borderColor = "1px solid #3B82F6";
  }

  return (
    <tr className={active ? "pos-row-active" : ""}>
      <td style={{ textAlign: "center", padding: "8px 4px" }}>
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "20px",
          height: "20px",
          borderRadius: "50%",
          background: bg,
          border: borderColor,
          color: color,
          fontSize: "0.72rem",
          fontWeight: "bold",
          fontFamily: "monospace"
        }}>
          {index}
        </div>
      </td>
      <td>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {pos.origin === "bot" ? (
            <span className={`badge badge-bot${active ? " badge-bot-active" : ""}`}>BOT</span>
          ) : (
            <>
              <span className="badge badge-manual">手動</span>
              <span style={{ fontSize: "0.6rem", color: "var(--text-dim)" }}>レガシー</span>
            </>
          )}
        </div>
      </td>
      <td>
        <span className="mono" style={{ fontSize: "0.72rem", color: active ? "var(--accent-green)" : "var(--text-secondary)" }}>
          {lowerPrice}–{upperPrice}
        </span>
      </td>
      <td>
        {Number(displayAmountA) === 0 ? (
          <span className="zero-amount">—</span>
        ) : (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span>{TOKEN_ICONS[tokenA] ?? "💠"}</span>
            <span className="mono" style={{ fontSize: "0.75rem", color: active ? "var(--accent-green)" : "inherit" }}>{amountA}</span>
          </span>
        )}
      </td>
      <td>
        {Number(displayAmountB) === 0 ? (
          <span className="zero-amount">—</span>
        ) : (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span>{TOKEN_ICONS[tokenB] ?? "💠"}</span>
            <span className="mono" style={{ fontSize: "0.75rem", color: active ? "var(--accent-green)" : "inherit" }}>{amountB}</span>
          </span>
        )}
      </td>
      <td>
        <span style={{ color: active ? "var(--accent-green)" : (usdValue > 0 ? "var(--text-primary)" : "var(--text-dim)") }}>
          {usdValue > 0 ? `$${usdValue.toFixed(2)}` : "—"}
        </span>
      </td>
      <td>
        <a
          href={`https://suivision.xyz/object/${pos.positionId}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--text-muted)", textDecoration: "none", fontSize: "0.85rem" }}
          title="SuiVisionで確認"
        >
          ↗
        </a>
      </td>
    </tr>
  );
}

// ── プールセクション ──────────────────────────────────────

interface GridBarItem {
  label: string;
  indices: number[];
  isCurrent: boolean;
  isGap: boolean;
  isGrid: boolean;
  isEmpty: boolean;
  sortKey: number;
}

function PoolSection({ group, prices }: { group: PoolGroup; prices: Record<string, number> }) {
  const tokens = group.pool.split("/");
  const tokenA = tokens[0] ?? "A";
  const tokenB = tokens[1] ?? "B";

  const bands = [...new Set(group.positions.map((p) => p.bandId))].sort();
  const [activeBand, setActiveBand] = useState<number | "all">("all");

  const visiblePositions = (activeBand === "all"
    ? group.positions
    : group.positions.filter((p) => p.bandId === activeBand)
  ).sort((a, b) => b.tickLower - a.tickLower); // 上のレンジを先に表示

  const currentPriceStr = group.currentPrice > 0
    ? formatPriceFromRaw(group.currentPrice, group.pool)
    : "—";

  // ── グリッド俯瞰バーの構築 ──
  const barItems: GridBarItem[] = [];
  const tickGroups: { tickLower: number; tickUpper: number; positions: LpPosition[]; index: number }[] = [];
  const seenTicks = new Set<string>();
  let groupIndex = 1;

  for (const pos of visiblePositions) {
    const key = `${pos.tickLower}-${pos.tickUpper}`;
    if (seenTicks.has(key)) continue;
    seenTicks.add(key);
    const groupPositions = visiblePositions.filter(p => p.tickLower === pos.tickLower && p.tickUpper === pos.tickUpper);
    tickGroups.push({ tickLower: pos.tickLower, tickUpper: pos.tickUpper, positions: groupPositions, index: groupIndex });
    groupIndex++;
  }

  const activeIndices = new Set<number>();
  for (const tGroup of tickGroups) {
    activeIndices.add(tGroup.index);
    
    const label = String(tGroup.index);
    
    const currentTick = visiblePositions[0]?.currentTick ?? 0;
    const isCurrent = currentTick >= tGroup.tickLower && currentTick <= tGroup.tickUpper;
    const isGap = tGroup.positions.some(p => p.mode === "gap");
    const isGrid = tGroup.positions.some(p => p.mode === "grid");
    
    barItems.push({
      label,
      indices: [tGroup.index],
      isCurrent,
      isGap,
      isGrid,
      isEmpty: false,
      sortKey: tGroup.index,
    });
  }

  // 空のインデックスを空枠として挿入 (1から最大インデックスまで)
  const maxIndex = visiblePositions.length > 0 ? Math.max(...visiblePositions.map(p => p.gridIndex)) : 6;
  for (let i = 1; i <= maxIndex; i++) {
    if (!activeIndices.has(i)) {
      let alreadyRepresented = false;
      for (const item of barItems) {
        if (item.indices.includes(i)) {
          alreadyRepresented = true;
          break;
        }
      }
      if (alreadyRepresented) continue;

      barItems.push({
        label: String(i),
        indices: [i],
        isCurrent: false,
        isGap: false,
        isGrid: false,
        isEmpty: true,
        sortKey: i,
      });
    }
  }

  const sortedBarItems = barItems.sort((a, b) => a.sortKey - b.sortKey);

  return (
    <div className="pool-section">
      <div className="pool-section-header">
        <span className="pool-name">{group.pool}</span>
        <span className={`badge badge-${group.dex}`}>{group.dex.toUpperCase()}</span>
        <span className={`badge badge-${group.mode}`}>
          {group.mode === "grid" ? "GRID" : "GAP"}
        </span>
        <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
          {group.positions.length}本
        </span>
        <span className="price-display">現在 {currentPriceStr}</span>

        <div style={{ marginLeft: "auto" }}>
          <BandTabs
            bands={bands}
            activeBand={activeBand}
            onSelect={setActiveBand}
          />
        </div>
      </div>

      {/* グリッド俯瞰インジケーターバー */}
      {visiblePositions.length > 0 && (
        <div style={{ 
          margin: "8px 0 16px 0", 
          padding: "10px 14px", 
          background: "rgba(30, 30, 50, 0.45)", 
          borderRadius: "8px", 
          border: "1px solid rgba(255, 255, 255, 0.04)" 
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, fontSize: "0.7rem", color: "var(--text-muted)" }}>
            <span style={{ fontWeight: "bold", color: "var(--text-secondary)" }}>グリッド俯瞰</span>
            <span>(橙=空白BOTが充填、空枠=空白、緑=現在価格、青=通常稼働)</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
            <div style={{ padding: "3px 7px", background: "rgba(255, 255, 255, 0.04)", borderRadius: "4px", fontSize: "0.75rem", color: "var(--text-dim)" }}>+</div>
            
            {sortedBarItems.map((item, idx) => {
              let bg = "rgba(255, 255, 255, 0.02)";
              let border = "1px solid rgba(255, 255, 255, 0.08)";
              let color = "var(--text-muted)";
              let fontWeight = "normal";

              if (item.isCurrent) {
                bg = "rgba(16, 185, 129, 0.25)";
                border = "1px solid #10B981";
                color = "#34D399";
                fontWeight = "bold";
              } else if (item.isGap) {
                bg = "rgba(245, 158, 11, 0.2)";
                border = "1px solid #F59E0B";
                color = "#FBBF24";
              } else if (item.isGrid) {
                bg = "rgba(59, 130, 246, 0.2)";
                border = "1px solid #3B82F6";
                color = "#60A5FA";
              } else if (item.isEmpty) {
                bg = "transparent";
                border = "1px dashed rgba(255, 255, 255, 0.12)";
                color = "var(--text-dim)";
              }

              return (
                <div
                  key={idx}
                  style={{
                    padding: "3px 8px",
                    background: bg,
                    border: border,
                    borderRadius: "4px",
                    fontSize: "0.75rem",
                    color: color,
                    fontWeight: fontWeight as any,
                    minWidth: "26px",
                    textAlign: "center",
                    boxShadow: item.isCurrent ? "0 0 8px rgba(16, 185, 129, 0.25)" : "none",
                    transition: "all 0.15s ease"
                  }}
                >
                  {item.label}
                </div>
              );
            })}

            <div style={{ padding: "3px 7px", background: "rgba(255, 255, 255, 0.04)", borderRadius: "4px", fontSize: "0.75rem", color: "var(--text-dim)" }}>+</div>
          </div>
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table className="pos-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>#</th>
              <th>ラベル</th>
              <th>価格レンジ</th>
              <th>{tokenA}</th>
              <th>{tokenB}</th>
              <th>評価額</th>
              <th style={{ width: 28 }}></th>
            </tr>
          </thead>
          <tbody>
            {visiblePositions.map((pos) => {
              const group = tickGroups.find(tg => tg.tickLower === pos.tickLower && tg.tickUpper === pos.tickUpper);
              const displayIndex = group ? group.index : 0;
              return (
                <PositionRow
                  key={pos.positionId}
                  pos={pos}
                  index={displayIndex}
                  tokenA={tokenA}
                  tokenB={tokenB}
                  prices={prices}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── メインコンポーネント ──────────────────────────────────

interface Props {
  positions: Record<string, LpPosition>;
  prices: Record<string, number>;
}

export function PositionList({ positions, prices }: Props) {
  const posArr = Object.values(positions);
  const gridGroups = groupPositions(
    posArr.filter((p) => p.mode === "grid"),
    prices
  );
  const gapGroups = groupPositions(
    posArr.filter((p) => p.mode === "gap"),
    prices
  );
  const centerGroups = groupPositions(
    posArr.filter((p) => p.mode === "center"),
    prices
  );

  return (
    <div>
      {/* GRIDポジション */}
      {gridGroups.length > 0 && (
        <div className="glass-card" style={{ marginBottom: 12 }}>
          <div className="panel-header">
            <span className="panel-title">📐 ポジション一覧 — GRID</span>
            <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
              計 {posArr.filter((p) => p.mode === "grid").length}本
            </span>
          </div>
          <div style={{ padding: "8px" }}>
            {gridGroups.map((g) => (
              <PoolSection key={`${g.pool}-${g.dex}`} group={g} prices={prices} />
            ))}
          </div>
        </div>
      )}

      {/* GAPポジション */}
      {gapGroups.length > 0 && (
        <div className="glass-card">
          <div className="panel-header">
            <span className="panel-title">🕳️ ポジション一覧 — GAP（空白BOT）</span>
            <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
              計 {posArr.filter((p) => p.mode === "gap").length}本
            </span>
          </div>
          <div style={{ padding: "8px" }}>
            {gapGroups.map((g) => (
              <PoolSection key={`${g.pool}-${g.dex}`} group={g} prices={prices} />
            ))}
          </div>
        </div>
      )}

      {/* CENTERポジション（LP手数料稼働） */}
      {centerGroups.length > 0 && (
        <div className="glass-card" style={{ marginTop: 12 }}>
          <div className="panel-header">
            <span className="panel-title">🎯 ポジション一覧 — CENTER（LP手数料稼働）</span>
            <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
              計 {posArr.filter((p) => p.mode === "center").length}本
            </span>
          </div>
          <div style={{ padding: "8px" }}>
            {centerGroups.map((g) => (
              <PoolSection key={`${g.pool}-${g.dex}`} group={g} prices={prices} />
            ))}
          </div>
        </div>
      )}

      {posArr.length === 0 && (
        <div
          className="glass-card"
          style={{ padding: 40, textAlign: "center", color: "var(--text-dim)" }}
        >
          <div style={{ fontSize: "3rem", marginBottom: 12 }}>🔍</div>
          <div>ポジションが検出されていません</div>
          <div style={{ fontSize: "0.75rem", marginTop: 6 }}>
            BOTを起動するか、手動でLPを作成してください
          </div>
        </div>
      )}
    </div>
  );
}
