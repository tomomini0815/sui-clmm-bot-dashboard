import React from "react";
import type { AutoConfig, GridState } from "../types";

interface Props {
  config: AutoConfig;
  state: GridState;
  onConfigChange: (c: Partial<AutoConfig>) => void;
}

function Toggle({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="toggle-wrap">
      <span className="toggle-label">{label}</span>
      <label className="toggle">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <div className="toggle-track" />
        <div className="toggle-thumb" />
      </label>
    </div>
  );
}

export function MonitorBar({ config, state, onConfigChange }: Props) {
  const positions = Object.values(state.positions);
  const gridInRange = positions.filter(
    (p) => p.mode === "grid" && p.currentTick >= p.tickLower && p.currentTick <= p.tickUpper
  ).length;
  const gapCount = positions.filter((p) => p.mode === "gap").length;
  const gridTotal = positions.filter((p) => p.mode === "grid").length;
  const lastCheck = state.lastCycleAt
    ? new Date(state.lastCycleAt).toLocaleTimeString("ja-JP")
    : "---";

  // ステール判定: 最終サイクルから60秒以上経過していたら警告
  const nowSec = Date.now() / 1000;
  const lastCycleSec = (state.lastCycleAt ?? 0) / 1000;
  const staleSec = nowSec - lastCycleSec;
  const isStale = state.lastCycleAt > 0 && staleSec > 60;

  return (
    <div className="monitor-bar">
      {/* 監視間隔 */}
      <div className="monitor-item">
        <Toggle
          label="自動"
          checked={config.autoInterval}
          onChange={(v) => onConfigChange({ autoInterval: v })}
        />
        <span className="monitor-item-label">監視間隔(秒)</span>
        {config.autoInterval ? (
          <span className="monitor-auto-value">
            {config.currentPollSec ?? "--"}s
          </span>
        ) : (
          <input
            type="number"
            className="monitor-input"
            defaultValue={config.currentPollSec ?? 10}
            onBlur={(e) => onConfigChange({ currentPollSec: Number(e.target.value) })}
          />
        )}
      </div>

      <div className="monitor-divider" />

      {/* レンジ幅 */}
      <div className="monitor-item">
        <Toggle
          label="自動"
          checked={config.autoRangeWidth}
          onChange={(v) => onConfigChange({ autoRangeWidth: v })}
        />
        <span className="monitor-item-label">レンジ幅 ±(%)</span>
        {config.autoRangeWidth ? (
          <span className="monitor-auto-value">
            {config.currentRangeWidthPct?.toFixed(1) ?? "--"}%
          </span>
        ) : (
          <input
            type="number"
            className="monitor-input"
            step="0.1"
            defaultValue={config.currentRangeWidthPct ?? 2}
            onBlur={(e) => onConfigChange({ currentRangeWidthPct: Number(e.target.value) })}
          />
        )}
      </div>

      <div className="monitor-divider" />

      {/* グリッド帯本数 */}
      <div className="monitor-item">
        <Toggle
          label="自動"
          checked={config.autoGridBand}
          onChange={(v) => onConfigChange({ autoGridBand: v })}
        />
        <span className="monitor-item-label">グリッド帯(本)</span>
        {config.autoGridBand ? (
          <span className="monitor-auto-value">
            {config.currentGridBands ?? "--"}本
          </span>
        ) : (
          <input
            type="number"
            className="monitor-input"
            defaultValue={config.currentGridBands ?? 3}
            onBlur={(e) => onConfigChange({ currentGridBands: Number(e.target.value) })}
          />
        )}
        {!config.autoGridBand && (
          <button className="btn btn-sm btn-cyan">反映</button>
        )}
      </div>

      <div className="monitor-divider" />

      {/* 検出サマリー */}
      <div className="monitor-summary">
        <div className="monitor-stat">
          検出ポジション <span>{positions.length}</span>
        </div>
        <div className="monitor-stat">
          レンジ内 GRID <span>{gridInRange}</span>
        </div>
        <div className="monitor-stat">
          GAP <span>{gapCount}</span>
          ・GRID <span>{gridTotal}</span>
        </div>
        <div className="monitor-stat">
          最終チェック <span style={isStale ? { color: "#ff6b6b", fontWeight: 700 } : undefined}>{lastCheck}</span>
          {isStale && (
            <span style={{ marginLeft: 6, fontSize: 11, color: "#ff6b6b", fontWeight: 700 }}>
              ⚠ ステール ({Math.floor(staleSec)}秒前)
            </span>
          )}
        </div>
        <div className="monitor-stat">
          自動初期化:{" "}
          <span style={{ color: config.autoReinit ? "var(--accent-cyan)" : "var(--text-muted)" }}>
            {config.autoReinit ? "待機中" : "無効"}
          </span>
        </div>
      </div>
    </div>
  );
}
