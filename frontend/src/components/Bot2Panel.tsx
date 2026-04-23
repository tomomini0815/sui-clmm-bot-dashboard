import { Activity, TrendingUp, Zap, BarChart2, Circle } from 'lucide-react';

interface Bot2Status {
  active: boolean;
  pool?: string;
  poolId?: string;
  maxCapitalUsdc?: number;
  currentPrice?: number;
  currentRange?: { lower: number; upper: number };
  tracker?: {
    rebalanceCount: number;
    totalFeesEarned: number;
    successfulRebalances: number;
    history: any[];
  };
  pnl?: any;
  gasStats?: any;
  phase?: string;
  message?: string;
}

interface Bot2PanelProps {
  bot2: Bot2Status | null;
}

export function Bot2Panel({ bot2 }: Bot2PanelProps) {
  const isActive = bot2?.active === true;

  const rangeInPct = bot2?.currentRange && bot2.currentPrice
    ? ((bot2.currentRange.upper - bot2.currentRange.lower) / bot2.currentPrice * 100).toFixed(2)
    : '—';

  const inRange = bot2?.currentPrice && bot2?.currentRange
    ? bot2.currentPrice >= bot2.currentRange.lower && bot2.currentPrice <= bot2.currentRange.upper
    : null;

  const netPnl = bot2?.pnl?.netPnl ?? bot2?.pnl?.cumulativeNetPnl ?? null;
  const feesEarned = bot2?.tracker?.totalFeesEarned ?? 0;
  const rebalances = bot2?.tracker?.rebalanceCount ?? 0;

  return (
    <div className="glass-panel bot2-panel">
      {/* ヘッダー */}
      <div className="bot2-header">
        <div className="bot2-title-row">
          <div className="bot2-icon">
            <Zap size={16} />
          </div>
          <h3 className="bot2-title">Bot2 — DEEP/SUI</h3>
          <div className={`bot2-status-badge ${isActive ? 'active' : 'inactive'}`}>
            <Circle size={7} fill="currentColor" />
            {isActive ? '稼働中' : '停止中'}
          </div>
        </div>
        {bot2?.phase && (
          <div className="bot2-phase">Phase: {bot2.phase}</div>
        )}
        {!isActive && bot2?.message && (
          <p className="bot2-message">{bot2.message}</p>
        )}
      </div>

      {isActive && (
        <>
          {/* 価格・レンジ */}
          <div className="bot2-price-section">
            <div className="bot2-price-row">
              <span className="bot2-label">現在価格</span>
              <span className="bot2-value">{bot2?.currentPrice?.toFixed(6) ?? '—'} SUI</span>
            </div>
            {bot2?.currentRange && (
              <>
                <div className="bot2-range-bar-wrapper">
                  <div className="bot2-range-label-row">
                    <span className="bot2-label-sm">{bot2.currentRange.lower.toFixed(6)}</span>
                    <span className={`bot2-inrange-badge ${inRange ? 'in' : 'out'}`}>
                      {inRange ? '✓ レンジ内' : '⚠ レンジ外'}
                    </span>
                    <span className="bot2-label-sm">{bot2.currentRange.upper.toFixed(6)}</span>
                  </div>
                  <div className="bot2-range-bar">
                    {(() => {
                      if (!bot2.currentPrice || !bot2.currentRange) return null;
                      const { lower, upper } = bot2.currentRange;
                      const pct = Math.max(0, Math.min(100,
                        ((bot2.currentPrice - lower) / (upper - lower)) * 100
                      ));
                      return (
                        <div className="bot2-range-fill">
                          <div className="bot2-range-thumb" style={{ left: `${pct}%` }} />
                        </div>
                      );
                    })()}
                  </div>
                  <div className="bot2-range-width">幅: {rangeInPct}%</div>
                </div>
              </>
            )}
          </div>

          {/* 統計 */}
          <div className="bot2-stats-grid">
            <div className="bot2-stat">
              <Activity size={13} className="bot2-stat-icon" />
              <span className="bot2-stat-label">リバランス</span>
              <span className="bot2-stat-val">{rebalances}回</span>
            </div>
            <div className="bot2-stat">
              <TrendingUp size={13} className="bot2-stat-icon" />
              <span className="bot2-stat-label">手数料収益</span>
              <span className="bot2-stat-val">${feesEarned.toFixed(4)}</span>
            </div>
            <div className="bot2-stat">
              <BarChart2 size={13} className="bot2-stat-icon" />
              <span className="bot2-stat-label">純利益</span>
              <span className={`bot2-stat-val ${netPnl !== null ? (netPnl >= 0 ? 'positive' : 'negative') : ''}`}>
                {netPnl !== null ? `${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(4)}` : '—'}
              </span>
            </div>
            <div className="bot2-stat">
              <Zap size={13} className="bot2-stat-icon" />
              <span className="bot2-stat-label">最大資金</span>
              <span className="bot2-stat-val">${bot2?.maxCapitalUsdc ?? 3} USDC</span>
            </div>
          </div>

          {/* 直近アクティビティ */}
          {bot2?.tracker?.history && bot2.tracker.history.length > 0 && (
            <div className="bot2-activity">
              <div className="bot2-activity-title">最近の動作</div>
              {bot2.tracker.history.slice(-3).reverse().map((h: any, i: number) => (
                <div key={i} className="bot2-activity-row">
                  <span className="bot2-activity-time">{h.time || '—'}</span>
                  <span className="bot2-activity-action">{h.action}</span>
                  {typeof h.pnl === 'number' && h.pnl !== 0 && (
                    <span className={`bot2-activity-pnl ${h.pnl >= 0 ? 'positive' : 'negative'}`}>
                      {h.pnl >= 0 ? '+' : ''}{h.pnl.toFixed(4)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
