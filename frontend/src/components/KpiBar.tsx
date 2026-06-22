import { TrendingUp, TrendingDown, Gauge, Layers, Sparkles, Coins } from 'lucide-react';

interface KpiBarProps {
  totalAssetsSui: number;
  netPnlSui: number;
  rangeDistancePct: number | null;
  rangeDirection: string;
  netYieldSui: number;
  suiJpyPrice: number;
  isBotActive: boolean;
}

export const KpiBar = ({
  totalAssetsSui,
  netPnlSui,
  rangeDistancePct,
  rangeDirection,
  netYieldSui,
  suiJpyPrice,
  isBotActive,
}: KpiBarProps) => {
  const isProfit = netPnlSui >= 0;
  const isYieldPositive = netYieldSui >= 0;
  const formatJpy = (suiAmount: number, showSign = false) => {
    if (suiJpyPrice <= 0) return '円換算取得中...';
    const value = Math.round(suiAmount * suiJpyPrice);
    const formatted = new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: 'JPY',
      maximumFractionDigits: 0,
    }).format(Math.abs(value));
    return `${showSign ? (value >= 0 ? '+' : '-') : ''}${formatted}`;
  };

  const kpis = [
    {
      id: 'total-assets',
      icon: <Layers size={20} />,
      label: '総運用資産',
      value: `${totalAssetsSui.toFixed(4)} SUI`,
      sub: `${formatJpy(totalAssetsSui)} / LP・待機資金`,
      accent: '#58a6ff',
      bg: 'rgba(88,166,255,0.07)',
      border: 'rgba(88,166,255,0.18)',
      glow: 'rgba(88,166,255,0.15)',
    },
    {
      id: 'net-pnl',
      icon: isProfit ? <TrendingUp size={20} /> : <TrendingDown size={20} />,
      label: '資産増減（運用開始比）',
      value: `${isProfit ? '+' : ''}${netPnlSui.toFixed(4)} SUI`,
      sub: `${formatJpy(netPnlSui, true)} / LP評価変動などを含む`,
      accent: isProfit ? '#3fb950' : '#f85149',
      bg: isProfit ? 'rgba(63,185,80,0.07)' : 'rgba(248,81,73,0.07)',
      border: isProfit ? 'rgba(63,185,80,0.18)' : 'rgba(248,81,73,0.18)',
      glow: isProfit ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)',
    },
    {
      id: 'range-distance',
      icon: <Gauge size={20} />,
      label: 'レンジ余裕度',
      value: rangeDistancePct === null ? '計算中...' : `${rangeDistancePct.toFixed(2)}%`,
      sub: rangeDistancePct === null ? '有効レンジ待機中' : `${rangeDirection}までの距離`,
      accent: '#d29922',
      bg: 'rgba(210,153,34,0.07)',
      border: 'rgba(210,153,34,0.18)',
      glow: 'rgba(210,153,34,0.15)',
    },
    {
      id: 'net-yield',
      icon: <Coins size={20} />,
      label: '手数料収支',
      value: `${isYieldPositive ? '+' : ''}${netYieldSui.toFixed(4)} SUI`,
      sub: `${formatJpy(netYieldSui, true)} / 回収手数料 - ガス代`,
      accent: isYieldPositive ? '#3fb950' : '#f85149',
      bg: isYieldPositive ? 'rgba(63,185,80,0.07)' : 'rgba(248,81,73,0.07)',
      border: isYieldPositive ? 'rgba(63,185,80,0.18)' : 'rgba(248,81,73,0.18)',
      glow: isYieldPositive ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)',
    },
  ];

  return (
    <div className="kpi-bar" role="region" aria-label="KPI サマリー">
      {kpis.map((kpi) => (
        <div
          key={kpi.id}
          id={`kpi-${kpi.id}`}
          className="kpi-card"
          style={{
            background: kpi.bg,
            border: `1px solid ${kpi.border}`,
            boxShadow: `0 0 20px ${kpi.glow}`,
          }}
        >
          <div className="kpi-card-header">
            <div
              className="kpi-icon"
              style={{
                color: kpi.accent,
                background: `rgba(${kpi.accent.replace('#', '').match(/.{2}/g)?.map(h => parseInt(h, 16)).join(',') || '255,255,255'}, 0.12)`,
              }}
            >
              {kpi.icon}
            </div>
            <span className="kpi-label">{kpi.label}</span>
          </div>
          <div className="kpi-value" style={{ color: kpi.accent }}>
            {kpi.value}
          </div>
          <div className="kpi-sub">{kpi.sub}</div>
          {/* Sparkle accent for active bot */}
          {isBotActive && kpi.id === 'total-assets' && (
            <div className="kpi-active-badge">
              <Sparkles size={10} />
              稼働中
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
