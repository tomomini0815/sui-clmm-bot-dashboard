import React, { useMemo, useState } from 'react';
import { Activity, ArrowRightLeft, Clock, TrendingUp, BarChart3, Play, Square, AlertTriangle } from 'lucide-react';

interface LogEntry {
  date?: string;
  time: string;
  action: string;
  price: number;
  range: string;
  fee?: string;
  status: string;
  details?: string;
  txDigest?: string;
}

interface ActivityLogProps {
  logs: LogEntry[];
}

type LogKind = 'rebalance' | 'lifecycle' | 'error' | 'adjust' | 'summary' | 'other';

const logKindOptions: { id: LogKind; label: string }[] = [
  { id: 'rebalance', label: 'リバランス' },
  { id: 'lifecycle', label: '起動/停止' },
  { id: 'error', label: 'エラー' },
  { id: 'adjust', label: '調整' },
  { id: 'summary', label: 'サマリー' },
  { id: 'other', label: 'その他' },
];

const getLogKind = (action: string): LogKind => {
  if (action.includes('失敗') || action.includes('エラー')) return 'error';
  if (
    action.includes('リバランス') ||
    action.includes('LP提供') ||
    action.includes('LP投入') ||
    action.includes('資産調整') ||
    action.includes('Rebalance')
  ) return 'rebalance';
  if (action.includes('起動') || action.includes('停止')) return 'lifecycle';
  if (action === 'DeltaAdjust') return 'adjust';
  if (action === '1hサマリー' || action.includes('サマリー')) return 'summary';
  return 'other';
};

export const ActivityLog = React.memo<ActivityLogProps>(({ logs }) => {
  const [enabledKinds, setEnabledKinds] = useState<Record<LogKind, boolean>>({
    rebalance: true,
    lifecycle: true,
    error: true,
    adjust: true,
    summary: true,
    other: true,
  });

  const filteredLogs = useMemo(
    () => logs.filter((log) => enabledKinds[getLogKind(log.action)]),
    [logs, enabledKinds]
  );

  const stats = useMemo(() => {
    const rebalances = filteredLogs.filter(log => getLogKind(log.action) === 'rebalance');

    const successfulRebalances = rebalances.filter(log =>
      log.status.includes('+') || (log.status === '完了' && !log.action.includes('失敗'))
    );

    const totalRebalances = rebalances.length;
    const successRate = totalRebalances > 0
      ? (successfulRebalances.length / totalRebalances * 100).toFixed(1)
      : '-';

    return { totalRebalances, successRate };
  }, [filteredLogs]);

  const toggleKind = (kind: LogKind) => {
    setEnabledKinds(prev => ({ ...prev, [kind]: !prev[kind] }));
  };

  return (
    <div className="glass-panel activity-log-panel" style={{ 
      display: 'flex',
      flexDirection: 'column',
      gap: '18px',
      flex: 1,
      minHeight: 0,
      overflow: 'hidden'
    }}>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '12px',
        flexShrink: 0
      }}>
        <h2 style={{ 
          fontSize: '1.1rem', 
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          実行履歴
          {logs.length > 0 && (
            <span style={{
              fontSize: '0.75rem',
              fontWeight: 500,
              color: 'var(--text-muted)',
              background: 'rgba(88, 166, 255, 0.1)',
              padding: '2px 8px',
              borderRadius: '20px',
              border: '1px solid rgba(88, 166, 255, 0.2)',
            }}>{filteredLogs.length}/{logs.length}件</span>
          )}
        </h2>
        
        {/* 統計情報バッジ - ログがある場合のみ表示 */}
        {logs.length > 0 && (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <div style={{
              background: 'rgba(88, 166, 255, 0.1)',
              padding: '6px 12px',
              borderRadius: '8px',
              border: '1px solid rgba(88, 166, 255, 0.2)',
              fontSize: '0.8rem',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}>
              <ArrowRightLeft size={14} color="var(--accent)" />
              <span style={{ color: 'var(--text-muted)' }}>リバランス: </span>
              <strong style={{ color: 'var(--accent)' }}>{stats.totalRebalances}回</strong>
            </div>
            {stats.successRate !== '-' && (
              <div style={{
                background: parseFloat(stats.successRate) >= 80 ? 'rgba(63, 185, 80, 0.1)' : 'rgba(210, 153, 34, 0.1)',
                padding: '6px 12px',
                borderRadius: '8px',
                border: parseFloat(stats.successRate) >= 80 ? '1px solid rgba(63, 185, 80, 0.2)' : '1px solid rgba(210, 153, 34, 0.2)',
                fontSize: '0.8rem',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}>
                <TrendingUp size={14} color={parseFloat(stats.successRate) >= 80 ? 'var(--success)' : 'var(--warning)'} />
                <span style={{ color: 'var(--text-muted)' }}>成功率: </span>
                <strong style={{ 
                  color: parseFloat(stats.successRate) >= 80 ? 'var(--success)' : 'var(--warning)'
                }}>{stats.successRate}%</strong>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        padding: '10px 12px',
        borderRadius: '12px',
        background: 'rgba(255,255,255,0.025)',
        border: '1px solid rgba(255,255,255,0.06)'
      }}>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontWeight: 700, marginRight: '2px' }}>
          実行種類
        </span>
        {logKindOptions.map(option => (
          <label
            key={option.id}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 9px',
              borderRadius: '8px',
              border: enabledKinds[option.id] ? '1px solid rgba(88,166,255,0.28)' : '1px solid rgba(255,255,255,0.08)',
              background: enabledKinds[option.id] ? 'rgba(88,166,255,0.1)' : 'rgba(255,255,255,0.02)',
              color: enabledKinds[option.id] ? 'var(--text-main)' : 'var(--text-muted)',
              fontSize: '0.78rem',
              fontWeight: 650,
              cursor: 'pointer',
              userSelect: 'none'
            }}
          >
            <input
              type="checkbox"
              checked={enabledKinds[option.id]}
              onChange={() => toggleKind(option.id)}
              style={{ accentColor: 'var(--accent)' }}
            />
            {option.label}
          </label>
        ))}
      </div>
      
      <div className="activity-log-table-wrapper" style={{ 
        overflowX: 'auto', 
        overflowY: 'auto', 
        position: 'relative', 
        flex: 1, 
        height: 0,
        minHeight: 0
      }}>
        {filteredLogs.length > 0 ? (
          <table className="log-table" style={{ minWidth: '760px' }}>
            <thead>
              <tr>
                <th style={{ width: '90px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Clock size={14} />
                    時刻
                  </div>
                </th>
                <th style={{ width: '150px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Activity size={14} />
                    アクション
                  </div>
                </th>
                <th style={{ width: '110px' }}>実行価格</th>
                <th style={{ width: '160px' }}>設定レンジ</th>
                <th style={{ minWidth: '150px' }}>詳細</th>
                <th style={{ 
                  width: '110px', 
                  textAlign: 'right', 
                  position: 'sticky', 
                  right: 0, 
                  top: 0,
                  background: 'var(--bg-panel)',
                  zIndex: 20,
                  boxShadow: '-10px 0 10px -5px rgba(0,0,0,0.3)'
                }}>ステータス</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log, idx) => {
              // アクション別アイコンと色
              const getActionStyle = (action: string) => {
                if (action.includes('リバランス') && !action.includes('失敗')) {
                  return { icon: <ArrowRightLeft size={14} color="var(--accent)" />, bg: 'rgba(88, 166, 255, 0.1)', color: 'var(--accent)' };
                } else if (action.includes('失敗') || action.includes('エラー')) {
                  return { icon: <AlertTriangle size={14} color="var(--danger)" />, bg: 'rgba(248, 81, 73, 0.1)', color: 'var(--danger)' };
                } else if (action.includes('起動') || action === 'Bot起動') {
                  return { icon: <Play size={14} color="var(--success)" />, bg: 'rgba(63, 185, 80, 0.1)', color: 'var(--success)' };
                } else if (action.includes('停止') || action === 'Bot停止') {
                  return { icon: <Square size={14} color="var(--text-muted)" />, bg: 'rgba(139, 148, 158, 0.1)', color: 'var(--text-muted)' };
                } else if (action === 'DeltaAdjust') {
                  return { icon: <Activity size={14} color="#f59e0b" />, bg: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b' };
                } else if (action === '1hサマリー') {
                  return { icon: <BarChart3 size={14} color="#a855f7" />, bg: 'rgba(168, 85, 247, 0.1)', color: '#a855f7' };
                } else {
                  return { icon: <Activity size={14} color="var(--accent)" />, bg: 'rgba(88, 166, 255, 0.1)', color: 'var(--accent)' };
                }
              };
              const actionStyle = getActionStyle(log.action);

              return (
                <tr key={idx} style={{
                  transition: 'background 0.2s'
                }}>
                  <td style={{
                    color: 'var(--text-muted)',
                    fontFamily: 'monospace',
                    fontSize: '0.85rem'
                  }}>
                    <div style={{
                      background: 'rgba(88, 166, 255, 0.1)',
                      padding: '4px 8px',
                      borderRadius: '6px',
                      display: 'inline-block',
                    }}>
                      {log.date && (
                        <span style={{ fontSize: '0.75rem', opacity: 0.7, marginRight: '4px' }}>{log.date}</span>
                      )}
                      {log.date ? ` ${log.time}` : log.time}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                      <div style={{
                        background: actionStyle.bg,
                        padding: '5px',
                        borderRadius: '6px',
                        display: 'inline-flex'
                      }}>
                        {actionStyle.icon}
                      </div>
                      <span style={{ color: actionStyle.color }}>{log.action}</span>
                    </div>
                  </td>
                  <td>
                    <strong style={{ color: 'var(--text-main)', fontSize: '0.9rem' }}>
                      {log.price ? `${log.price.toFixed(4)}` : '-'} USDC
                    </strong>
                  </td>
                  <td>
                    <span style={{ 
                      fontFamily: 'monospace',
                      fontSize: '0.8rem',
                      background: 'rgba(255, 255, 255, 0.03)',
                      padding: '4px 8px',
                      borderRadius: '6px',
                      display: 'inline-block'
                    }}>
                      {log.range || '-'}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-muted)', lineHeight: 1.6, fontSize: '0.85rem' }}>
                    {(() => {
                      if (!log.details) return <div>-</div>;
                      try {
                        const parsed = JSON.parse(log.details);
                        if (log.action === 'DeltaAdjust') {
                          return (
                            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '6px', fontSize: '0.8rem' }}>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                                <div><span style={{opacity: 0.6}}>ドリフト:</span> <strong style={{color:'var(--accent)'}}>{parsed.delta_before} → {parsed.delta_after}</strong></div>
                                <div><span style={{opacity: 0.6}}>ヘッジ:</span> {parsed.hedge_direction} ${parsed.hedge_usd}</div>
                                <div style={{gridColumn: '1 / -1'}}><span style={{opacity: 0.6}}>Funding:</span> {parsed.funding_rate_hourly}%/h</div>
                              </div>
                            </div>
                          );
                        } else if (log.action === '1hサマリー') {
                          return (
                            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '6px', fontSize: '0.8rem' }}>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                                <div><span style={{opacity: 0.6}}>純利益:</span> <strong style={{color: parsed.net_pnl >= 0 ? 'var(--success)' : 'var(--danger)'}}>${parsed.net_pnl}</strong></div>
                                <div><span style={{opacity: 0.6}}>HedgePnL:</span> <span style={{color: parsed.hedge_pnl >= 0 ? 'var(--success)' : 'var(--danger)'}}>${parsed.hedge_pnl}</span></div>
                                <div><span style={{opacity: 0.6}}>リバランス:</span> {parsed.rebalance_count}回</div>
                              </div>
                            </div>
                          );
                        }
                        return <div>{log.details}</div>;
                      } catch {
                        return <div>{log.details}</div>;
                      }
                    })()}
                    {log.txDigest && (
                      <div style={{ marginTop: '6px' }}>
                        <a 
                          href={`https://suivision.xyz/txblock/${log.txDigest}`} 
                          target="_blank" 
                          rel="noreferrer" 
                          style={{ 
                            color: 'var(--accent)', 
                            textDecoration: 'none',
                            fontSize: '0.8rem',
                            fontWeight: 500,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: '3px 8px',
                            background: 'rgba(88, 166, 255, 0.1)',
                            borderRadius: '6px',
                            transition: 'all 0.2s'
                          }}
                        >
                          🔗 エクスプローラー
                        </a>
                      </div>
                    )}
                  </td>
                  <td style={{ 
                    textAlign: 'right',
                    position: 'sticky',
                    right: 0,
                    background: 'var(--bg-panel)',
                    zIndex: 1,
                    boxShadow: '-10px 0 10px -5px rgba(0,0,0,0.3)'
                  }}>
                    <span style={{
                      display: 'inline-block',
                      padding: '5px 10px',
                      borderRadius: '6px',
                      fontSize: '0.825rem',
                      fontWeight: 600,
                      background: log.status.includes('+')
                        ? 'rgba(63, 185, 80, 0.12)'
                        : log.status === '失敗'
                          ? 'rgba(248, 81, 73, 0.12)'
                          : 'rgba(88, 166, 255, 0.12)',
                      color: log.status.includes('+')
                        ? 'var(--success)'
                        : log.status === '失敗'
                          ? 'var(--danger)'
                          : 'var(--accent)',
                      border: log.status.includes('+')
                        ? '1px solid rgba(63, 185, 80, 0.25)'
                        : log.status === '失敗'
                          ? '1px solid rgba(248, 81, 73, 0.25)'
                          : '1px solid rgba(88, 166, 255, 0.25)',
                      whiteSpace: 'nowrap'
                    }}>
                      {log.status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div style={{ 
          height: '100%',
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          justifyContent: 'center',
          gap: '16px',
          padding: '40px',
          background: 'rgba(255, 255, 255, 0.02)',
          borderRadius: '12px',
          border: '1px dashed rgba(255, 255, 255, 0.1)'
        }}>
          <div style={{
            width: '60px',
            height: '60px',
            borderRadius: '30px',
            background: 'rgba(88, 166, 255, 0.05)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '8px'
          }}>
            <BarChart3 size={32} color="var(--text-muted)" opacity={0.5} />
          </div>
          <div style={{ textAlign: 'center' }}>
            <p style={{ 
              fontSize: '1rem', 
              fontWeight: 600, 
              color: 'var(--text-main)',
              marginBottom: '4px'
            }}>
              {logs.length > 0 ? '選択中の種類に一致する履歴はありません' : '実行履歴はまだありません'}
            </p>
            <p style={{ 
              fontSize: '0.85rem', 
              color: 'var(--text-muted)',
              maxWidth: '300px',
              lineHeight: 1.5
            }}>
              {logs.length > 0
                ? 'チェックボックスを切り替えると表示する実行種類を変更できます。'
                : 'Botが稼働を開始すると、ここに自動リバランスや調整ログがリアルタイムに表示されます。'}
            </p>
          </div>
          <div style={{
            fontSize: '0.75rem',
            color: 'var(--accent)',
            background: 'rgba(88, 166, 255, 0.1)',
            padding: '4px 12px',
            borderRadius: '20px',
            border: '1px solid rgba(88, 166, 255, 0.2)',
            marginTop: '8px'
          }}>
            監視モード待機中...
          </div>
        </div>
      )}
      </div>
    </div>
  );
});
