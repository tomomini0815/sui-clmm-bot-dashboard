import React from "react";
import type { LpPosition, Dex, Mode, BotProcess } from "../types";

interface StrategyData {
  botId: string;
  label: string;
  dex: Dex;
  mode: Mode;
  netProfitUsd: number;
  gridProfit: number;
  lpFees: number;
  swapFees: number;
  roundTrips: number;
  byToken: Record<string, number>;
}

const TOKEN_ICONS: Record<string, string> = {
  SUI: "🔵", USDC: "💵", CETUS: "🐟", DEEP: "🌊", NS: "⚡", MAGMA: "🔥",
};

interface Props {
  bots: BotProcess[];
  positions: LpPosition[];
  realized: Record<string, number>;
  feesEarned: Record<string, number>;
  swapFeesPaid: Record<string, number>;
  prices: Record<string, number>;
  roundTripsCompleted?: number;
}

function buildStrategyData(
  bot: BotProcess,
  share: number,
  realized: Record<string, number>,
  feesEarned: Record<string, number>,
  swapFeesPaid: Record<string, number>,
  positions: LpPosition[],
  prices: Record<string, number>
): StrategyData {
  const byToken: Record<string, number> = {};
  for (const [token, v] of Object.entries(realized)) {
    byToken[token] = (byToken[token] ?? 0) + v * share;
  }
  for (const [token, v] of Object.entries(feesEarned)) {
    byToken[token] = (byToken[token] ?? 0) + v * share;
  }
  for (const [token, v] of Object.entries(swapFeesPaid)) {
    byToken[token] = (byToken[token] ?? 0) - v * share;
  }

  // ボットが担当しているプールの未回収手数料を加算する
  // labelからプールを推測 (例: "Grid・Cetus (DEEP/SUI)")
  const match = bot.label.match(/\((.*?)\)/);
  const targetPool = match ? match[1] : null;

    const botPositions = positions.filter((p) => p.pool === targetPool && p.isActive);
    for (const pos of botPositions) {
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
  let netProfitUsd = 0;
  const suiUsdcRaw = prices["SUI/USDC"];
  const suiPriceUsd = suiUsdcRaw ? 1 / (suiUsdcRaw * 0.001) : 0;
  
  for (const [token, amount] of Object.entries(byToken)) {
    if (token === "USDC") {
      netProfitUsd += amount;
    } else if (token === "SUI") {
      netProfitUsd += amount * suiPriceUsd;
    } else if (token === "DEEP") {
      const deepSuiRaw = prices["DEEP/SUI"];
      const deepPriceInSui = deepSuiRaw ? deepSuiRaw * 0.001 : 0;
      netProfitUsd += amount * deepPriceInSui * suiPriceUsd;
    }
  }

  return {
    botId: bot.botId,
    label: bot.label,
    dex: bot.dex,
    mode: bot.mode,
    netProfitUsd,
    gridProfit: Object.values(realized).reduce((s, v) => s + v, 0) * share,
    // lpFees は表示の都合上 USD 換算か、とりあえず全体の netProfitUsd と同等に扱うか
    // ここでは簡易的に byToken の USD価値から gridProfit と swapFees の(シェア分USD概算)を除いたものとするのが理想だが、
    // 複雑なので byToken全体のうちの未回収・確定分をざっくり netProfitUsd にしているため、lpFeesはnetProfitUsdからgridProfit・swapFeesを引いた額とする
    lpFees: netProfitUsd - (Object.values(realized).reduce((s, v) => s + v, 0) * share) + (Object.values(swapFeesPaid).reduce((s, v) => s + v, 0) * share),
    swapFees: Object.values(swapFeesPaid).reduce((s, v) => s + v, 0) * share,
    roundTrips: 0, // will be overridden below
    byToken,
  };
}

function StrategyCard({ data }: { data: StrategyData }) {
  const sign = data.netProfitUsd >= 0 ? "+" : "";
  const profitColor = data.netProfitUsd >= 0 ? "var(--profit-pos)" : "var(--profit-neg)";

  return (
    <div className="strategy-card">
      <div className="strategy-card-header">
        <span className={`badge badge-${data.dex}`}>{data.dex.toUpperCase()}</span>
        <span className={`badge badge-${data.mode}`}>
          {data.mode === "grid" ? "GRID" : "GAP"}
        </span>
        <span className="badge badge-running" style={{ marginLeft: "auto" }}>稼働中</span>
      </div>

      <div className="strategy-card-title" style={{ marginBottom: 6 }}>{data.label}</div>

      <div
        className="strategy-profit"
        style={{ color: profitColor }}
      >
        {sign}${Math.abs(data.netProfitUsd).toFixed(2)}
      </div>

      <div className="strategy-detail">
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>グリッド差益</span>
          <span className="value-pos mono">+${data.gridProfit.toFixed(2)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>LP手数料</span>
          <span className="value-pos mono">+${data.lpFees.toFixed(2)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>swap手数料</span>
          <span className="value-neg mono">-${data.swapFees.toFixed(2)}</span>
        </div>
        {Object.entries(data.byToken).map(([token, v]) => (
          <div key={token} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{TOKEN_ICONS[token] ?? "💠"}</span>
            <span>{token}</span>
            <span className={`mono ${v >= 0 ? "value-pos" : "value-neg"}`} style={{ marginLeft: "auto" }}>
              {v >= 0 ? "+" : ""}{v.toFixed(4)}
            </span>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
          <span>往復成功</span>
          <span style={{ color: "var(--accent-cyan)", fontWeight: 600 }}>{data.roundTrips}回</span>
        </div>
      </div>
    </div>
  );
}

export function StrategyCards({ bots, positions, realized, feesEarned, swapFeesPaid, prices, roundTripsCompleted }: Props) {
  const activeBots = bots.filter((b) => b.status === "running");
  const displayBots = activeBots.length > 0 ? activeBots : bots; // 何も動いてなければ全Bot出す
  
  const share = activeBots.length > 0 ? 1 / activeBots.length : 1 / bots.length;

  const totalRoundTrips = roundTripsCompleted ?? 0;

  const cards = displayBots.map((bot) => {
    const data = buildStrategyData(bot, share, realized, feesEarned, swapFeesPaid, positions, prices);
    // ボットごとのラウンドトリップ数を推定（プール別のフィル履歴がないため全体を均等割り）
    data.roundTrips = Math.round(totalRoundTrips * share);
    return data;
  });

  return (
    <div className="glass-card">
      <div className="panel-header">
        <span className="panel-title">🎯 戦略別成績</span>
      </div>
      <div className="panel-body">
        <div className="strategy-grid">
          {cards.map((data) => (
            <StrategyCard key={data.botId} data={data} />
          ))}
        </div>
      </div>
    </div>
  );
}
