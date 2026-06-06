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
  isUnbalanced?: boolean;
}

interface MultiBotPanelProps {
  title: string;
  bot: Bot2Status | null;
  onStart?: () => void;
  onRebuild?: () => void;
}

export function MultiBotPanel({ title, bot: bot2, onStart, onRebuild }: MultiBotPanelProps) {
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
          <h3 className="bot2-title">{title}</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className={`bot2-status-badge ${isActive ? 'active' : 'inactive'}`}>
              <Circle size={7} fill="currentColor" />
              {isActive ? '稼働中' : '停止中'}
            </div>
            {!isActive && onStart && (
              <button 
                onClick={onStart}
                style={{ 
                  background: 'var(--accent)', 
                  border: 'none', 
                  borderRadius: '12px', 
                  color: 'white', 
                  padding: '4px 12px', 
                  fontSize: '0.75rem', 
                  fontWeight: 600, 
                  cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(88, 166, 255, 0.3)'
                }}
              >
                開始
              </button>
            )}
          </div>
        </div>
        {bot2?.phase && (
          <div className="bot2-phase">現在の工程: {bot2.phase}</div>
        )}
        {!isActive && bot2?.message && (
          <p className="bot2-message">{bot2.message}</p>
        )}
      </div>

      {isActive && (
        <>
          {/* 資金偏り警告 */}
          {bot2?.isUnbalanced && (
            <div style={{
              background: 'rgba(255, 159, 67, 0.12)',
              border: '1px solid rgba(255, 159, 67, 0.35)',
              borderRadius: '8px',
              padding: '12px',
              margin: '0 12px 16px 12px',
              color: '#ff9f43',
              fontSize: '0.75rem',
              fontWeight: 600,
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}>
              <div>⚠️ DEEP/SUI 資金偏り検知</div>
              <p style={{ margin: 0, fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 400, lineHeight: 1.4 }}>
                ポジション間の資金バランスに大きな偏りが発生しています。流動性を均等に再配分することをお勧めします。
              </p>
              {onRebuild && (
                <button
                  onClick={onRebuild}
                  style={{
                    alignSelf: 'flex-start',
                    background: '#ff9f43',
                    border: 'none',
                    borderRadius: '4px',
                    color: '#0d1117',
                    padding: '5px 10px',
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                    boxShadow: '0 2px 4px rgba(255, 159, 67, 0.25)',
                    marginTop: '2px'
                  }}
                >
                  今すぐ資金を均等化する
                </button>
              )}
            </div>
          )}

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
              <span className="bot2-stat-label">LP評価額</span>
              <span className="bot2-stat-val">${bot2?.pnl?.bot2LpValue?.toFixed(2) ?? '0.00'}</span>
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

          {/* 資金の均等化 (手動再配置) ボタン */}
          {isActive && onRebuild && (
            <div style={{ padding: '0 12px 12px 12px', marginTop: '12px' }}>
              <button
                onClick={onRebuild}
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '8px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  color: 'var(--text-muted)',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px'
                }}
              >
                🔄 資金の均等化 (再配置)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
