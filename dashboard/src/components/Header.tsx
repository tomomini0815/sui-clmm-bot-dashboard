import React from "react";
import type { BotProcess } from "../types";

interface Props {
  bots: BotProcess[];
  connected: boolean;
  onStartAll: () => void;
  onStopAll: () => void;
}

export function Header({ bots, connected, onStartAll, onStopAll }: Props) {
  const runningCount = bots.filter((b) => b.status === "running").length;

  return (
    <header className="header">
      <div>
        <div className="header-title">⚡ Sui LP Rebalancer</div>
        <div className="header-subtitle">逆張りグリッドBOT — レンジ相場特化型</div>
      </div>

      <div className="bot-badge">
        <div className="bot-badge-dot" />
        稼働 {runningCount}/{bots.length}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div className={`connection-dot ${connected ? "" : "offline"}`} />
        <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>
          {connected ? "接続中" : "切断"}
        </span>
      </div>

      <div className="header-spacer" />

      <div className="header-actions">
        <a
          href="https://suivision.xyz"
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-cyan"
        >
          <span>🔍</span> SuiVision
        </a>
        <button className="btn" title="通知オフ">🔔</button>
        <button className="btn btn-green" onClick={onStartAll}>▶ 全起動</button>
        <button className="btn btn-red" onClick={onStopAll}>■ 全停止</button>
      </div>
    </header>
  );
}
