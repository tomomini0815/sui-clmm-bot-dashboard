import React, { useState } from "react";
import type { PerformanceSummary } from "../types";

const TOKEN_ICONS: Record<string, string> = {
  SUI: "🔵", USDC: "💵", CETUS: "🐟", DEEP: "🌊", NS: "⚡", MAGMA: "🔥",
};

interface Props {
  performance: PerformanceSummary;
  onReset: () => void;
}

export function PerformancePanel({ performance, onReset }: Props) {
  const [showAll, setShowAll] = useState(false);

  const sign = performance.totalNetProfitUsd >= 0 ? "+" : "";
  const colorClass = performance.totalNetProfitUsd >= 0 ? "value-pos" : "value-neg";

  return (
    <div className="glass-card">
      <div className="panel-header">
        <span className="panel-title">📊 成績</span>
        <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", flex: 1 }}>
          純利益 = 差益 + LP手数料 − swap手数料
        </span>
        <button className="btn btn-sm btn-red" onClick={onReset}>リセット</button>
      </div>

      <div className="panel-body">
        {/* 総合純利益 */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: 4 }}>
            総合純利益（起動後・リセット後）
          </div>
          <div className={`big-profit ${colorClass}`}>
            {sign}${Math.abs(performance.totalNetProfitUsd).toFixed(2)}
          </div>
        </div>

        {/* トークン別内訳 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {Object.entries(performance.byToken).map(([token, amount]) => (
            <div
              key={token}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 0",
                borderBottom: "1px solid rgba(120,80,255,0.08)",
              }}
            >
              <span style={{ fontSize: "1rem" }}>{TOKEN_ICONS[token] ?? "💠"}</span>
              <span style={{ color: "var(--text-secondary)", fontSize: "0.8rem", minWidth: 50 }}>
                {token}
              </span>
              <span
                className={`mono ${amount >= 0 ? "value-pos" : "value-neg"}`}
                style={{ fontSize: "0.82rem", fontWeight: 600 }}
              >
                {amount >= 0 ? "+" : ""}{amount.toFixed(6)}
              </span>
            </div>
          ))}
        </div>

        {/* 往復成功回数 */}
        <div
          style={{
            marginTop: 12,
            padding: "8px 12px",
            background: "rgba(0,212,255,0.06)",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border-cyan)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>往復成功</span>
          <span style={{ color: "var(--accent-cyan)", fontWeight: 700 }}>
            {performance.roundTripsCompleted}回
          </span>
        </div>

        {/* ガス */}
        <div style={{ marginTop: 10 }}>
          <div className="gas-row">
            <span className="gas-label">起動後ガス</span>
            <span className="gas-value">
              {(performance.gasUsedSinceStart / 1e9).toFixed(4)} SUI
              <span style={{ color: "var(--text-muted)", marginLeft: 4 }}>
                / {performance.restartCountSinceStart}回
              </span>
            </span>
          </div>
          <div className="gas-row">
            <span className="gas-label">state累計ガス</span>
            <span className="gas-value">
              {(performance.gasUsedCumulative / 1e9).toFixed(4)} SUI
              <span style={{ color: "var(--text-muted)", marginLeft: 4 }}>
                / {performance.restartCountCumulative}回
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
