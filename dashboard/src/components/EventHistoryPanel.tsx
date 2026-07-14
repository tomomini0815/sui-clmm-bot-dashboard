import React, { useState } from "react";
import type { ImportantEvent } from "../types";

const CATEGORY_ICONS: Record<ImportantEvent["category"], string> = {
  init: "🚀", fill: "✅", rebalance: "⚖️", fund_transfer: "💸",
  promote: "⬆️", demote: "⬇️", error: "🔴", info: "ℹ️",
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("ja-JP", {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

interface Props {
  events: ImportantEvent[];
  onClear: () => void;
}

export function EventHistoryPanel({ events, onClear }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="glass-card">
      <div className="panel-header">
        <span className="panel-title">⭐ 重要イベント履歴</span>
        <span
          style={{
            background: "rgba(59,130,246,0.15)",
            border: "1px solid rgba(59,130,246,0.3)",
            borderRadius: 20,
            padding: "1px 8px",
            fontSize: "0.72rem",
            color: "var(--accent-blue)",
            fontWeight: 700,
          }}
        >
          {events.length}
        </span>
        <button className="btn btn-xs" onClick={onClear}>履歴クリア</button>
        <button
          className="btn btn-xs"
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? "展開" : "折りたたむ"}
        </button>
      </div>

      {!collapsed && (
        <div className="panel-body" style={{ padding: "8px 12px" }}>
          <div className="event-scroll">
            {events.length === 0 ? (
              <div style={{ color: "var(--text-dim)", fontSize: "0.78rem", textAlign: "center", padding: "20px 0" }}>
                イベントはありません
              </div>
            ) : (
              events.map((ev) => (
                <div
                  key={ev.id}
                  className={`event-item event-${ev.category}`}
                >
                  <span className="event-icon">{CATEGORY_ICONS[ev.category]}</span>
                  <span className="event-time">{formatTime(ev.timestamp)}</span>
                  <span className="event-msg">{ev.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
