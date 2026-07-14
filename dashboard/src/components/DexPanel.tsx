import React from "react";
import type { BotProcess } from "../types";

interface Props {
  bots: BotProcess[];
  onStart: (botId: string) => void;
  onStop: (botId: string) => void;
}

export function DexPanel({ bots, onStart, onStop }: Props) {
  const runningCount = bots.filter((b) => b.status === "running").length;

  return (
    <div className="glass-card">
      <div className="panel-header">
        <span className="panel-title">⚙️ DEX管理</span>
        <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
          稼働中 {runningCount}/{bots.length}
        </span>
      </div>

      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {bots.map((bot) => (
          <div
            key={bot.botId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px",
              background: "rgba(255,255,255,0.03)",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
            }}
          >
            <span className={`badge badge-${bot.dex}`}>{bot.dex.toUpperCase()}</span>
            <span className={`badge badge-${bot.mode}`}>
              {bot.mode === "grid" ? "GRID" : "GAP"}
            </span>

            <span style={{ fontSize: "0.8rem", color: "var(--text-primary)", flex: 1 }}>
              {bot.label}
            </span>

            <span className={`badge badge-${bot.status}`}>
              {bot.status === "running" ? "稼働中" : "停止中"}
            </span>

            {bot.pid && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.68rem",
                  color: "var(--text-dim)",
                }}
              >
                pid {bot.pid}
              </span>
            )}

            {bot.status === "running" ? (
              <button
                className="btn btn-xs btn-red"
                onClick={() => onStop(bot.botId)}
              >
                停止
              </button>
            ) : (
              <button
                className="btn btn-xs btn-green"
                onClick={() => onStart(bot.botId)}
              >
                起動
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
