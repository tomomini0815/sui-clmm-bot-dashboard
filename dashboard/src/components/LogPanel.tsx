import React, { useState, useEffect, useRef } from "react";
import type { LogEntry, LogLevel } from "../types";

const LEVEL_ICONS: Record<LogLevel, string> = {
  info: "ℹ️", warn: "⚠️", error: "🔴", debug: "🔧", important: "⭐",
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("ja-JP", { hour12: false });
}

interface Props {
  logs: LogEntry[];
}

export function LogPanel({ logs }: Props) {
  const [filters, setFilters] = useState<Record<LogLevel, boolean>>({
    info: true, warn: true, error: true, debug: false, important: true,
  });
  const [autoScroll, setAutoScroll] = useState(true);
  const [localLogs, setLocalLogs] = useState<LogEntry[]>(logs);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLocalLogs(logs);
  }, [logs]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [localLogs, autoScroll]);

  const toggle = (level: LogLevel) => {
    setFilters((f) => ({ ...f, [level]: !f[level] }));
  };

  const filtered = localLogs.filter((l) => filters[l.level]);

  return (
    <div className="glass-card">
      <div className="panel-header">
        <span className="panel-title">📋 ログ</span>
        <div className="filter-row" style={{ display: "flex", flexDirection: "row", flexWrap: "nowrap", gap: 12, flex: 1, overflowX: "auto" }}>
          {(["important", "info", "warn", "error", "debug"] as LogLevel[]).map((level) => (
            <label key={level} className="checkbox-wrap" style={{ margin: 0, padding: 0 }}>
              <input
                type="checkbox"
                checked={filters[level]}
                onChange={() => toggle(level)}
              />
              <span className="checkbox-label">
                {LEVEL_ICONS[level]} {level}
              </span>
            </label>
          ))}
        </div>
        <label className="checkbox-wrap" style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          <span className="checkbox-label">自動スクロール</span>
        </label>
        <button
          className="btn btn-xs"
          onClick={() => setLocalLogs([])}
        >
          クリア
        </button>
      </div>

      <div className="panel-body" style={{ padding: "8px 12px" }}>
        <div className="log-scroll" ref={scrollRef}>
          {filtered.length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: "0.78rem", textAlign: "center", padding: "20px 0" }}>
              ログはありません
            </div>
          ) : (
            filtered.map((entry) => (
              <div key={entry.id} className={`log-entry log-${entry.level}`}>
                <span className="log-time">{formatTime(entry.timestamp)}</span>
                <span style={{ fontSize: "0.9rem" }}>{LEVEL_ICONS[entry.level]}</span>
                <span className="log-tag">[{entry.tag}]</span>
                <span className="log-msg">{entry.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
