import { BarChart3, TrendingUp, TrendingDown, Zap, Fuel, RefreshCw } from 'lucide-react';

interface HourlySummaryCardProps {
  summary: {
    period?: string;
    lp_fee_earned?: number;
    hedge_pnl?: number;
    funding_paid?: number;
    gas_spent?: number;
    net_pnl?: number;
    rebalance_count?: number;
    hedge_adjust_count?: number;
    avg_delta_error?: number;
  } | null;
}

export function HourlySummaryCard({ summary }: HourlySummaryCardProps) {
  if (!summary) {
    return (
      <div className="glass-panel" style={{ padding: '16px', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <BarChart3 size={15} color="var(--accent)" />
          1時間サマリー
        </h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: '12px 0' }}>
          稼働開始から1時間後に表示されます
        </p>
      </div>
    );
  }

  const netPnl = summary.net_pnl ?? 0;
  const lpFee = summary.lp_fee_earned ?? 0;
  const hedgePnl = summary.hedge_pnl ?? 0;
  const fundingPaid = summary.funding_paid ?? 0;
  const gasSpent = summary.gas_spent ?? 0;
  const rebalanceCount = summary.rebalance_count ?? 0;
  const adjustCount = summary.hedge_adjust_count ?? 0;
  const avgDeltaError = summary.avg_delta_error ?? 0;

  const rows = [
    {
      label: 'LP手数料収益',
      value: `+$${lpFee.toFixed(4)}`,
      color: 'var(--success)',
      icon: <TrendingUp size={13} />,
    },
    {
      label: 'ヘッジPnL',
      value: `${hedgePnl >= 0 ? '+' : ''}$${hedgePnl.toFixed(4)}`,
      color: hedgePnl >= 0 ? 'var(--success)' : 'var(--danger)',
      icon: hedgePnl >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />,
    },
    {
      label: 'ファンディングコスト',
      value: `-$${fundingPaid.toFixed(4)}`,
      color: 'var(--danger)',
      icon: <Zap size={13} />,
    },
    {
      label: 'ガス消費',
      value: `-$${gasSpent.toFixed(4)}`,
      color: 'var(--text-muted)',
      icon: <Fuel size={13} />,
    },
  ];

  return (
    <div className="glass-panel" style={{ padding: '16px', marginBottom: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <BarChart3 size={15} color="var(--accent)" />
          1時間サマリー
        </h3>
        <div style={{
          fontSize: '0.85rem', fontWeight: 700,
          color: netPnl >= 0 ? 'var(--success)' : 'var(--danger)',
          background: netPnl >= 0 ? 'rgba(63,185,80,0.1)' : 'rgba(255,59,48,0.1)',
          padding: '3px 10px', borderRadius: '6px',
          border: `1px solid ${netPnl >= 0 ? 'rgba(63,185,80,0.3)' : 'rgba(255,59,48,0.3)'}`,
        }}>
          純利益: {netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)}
        </div>
      </div>

      {/* 内訳 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
        {rows.map((row) => (
          <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
              <span style={{ color: row.color }}>{row.icon}</span>
              {row.label}
            </div>
            <span style={{ fontSize: '0.82rem', fontWeight: 600, color: row.color }}>{row.value}</span>
          </div>
        ))}
      </div>

      {/* 区切り線 */}
      <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', marginBottom: '12px' }} />

      {/* 操作回数 & Deltaエラー */}
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
        {[
          { label: 'リバランス', value: `${rebalanceCount}回`, icon: <RefreshCw size={12} /> },
          { label: 'ヘッジ調整', value: `${adjustCount}回`, icon: <Zap size={12} /> },
          { label: '平均Δエラー', value: avgDeltaError.toFixed(3), icon: <BarChart3 size={12} /> },
        ].map((item) => (
          <div key={item.label} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            flex: '1', minWidth: '70px',
            background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '8px 6px',
          }}>
            <div style={{ color: 'var(--accent)', marginBottom: '4px' }}>{item.icon}</div>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>{item.value}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>{item.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
