import { TrendingUp, TrendingDown, Minus, RotateCw, Layers, Sparkles } from 'lucide-react';

interface KpiBarProps {
  totalLpValue: number;
  netPnl: number;
  totalRebalances: number;
  marketCondition: string;
  estimatedApr: number;
  fees: number;
  isBotActive: boolean;
  currentPrice: number;
  pythPrice: number | null;
}

const MarketIcon = ({ condition }: { condition: string }) => {
  if (condition === 'uptrend') return <TrendingUp size={18} />;
  if (condition === 'downtrend') return <TrendingDown size={18} />;
  return <Minus size={18} />;
};

const marketLabel: Record<string, { label: string; color: string; bg: string }> = {
  uptrend:   { label: '上昇トレンド', color: '#3fb950', bg: 'rgba(63,185,80,0.12)' },
  downtrend: { label: '下降トレンド', color: '#f85149', bg: 'rgba(248,81,73,0.12)' },
  sideways:  { label: 'レンジ相場',   color: '#58a6ff', bg: 'rgba(88,166,255,0.12)' },
};

export const KpiBar = ({
  totalLpValue,
  netPnl,
  totalRebalances,
  marketCondition,
  estimatedApr,
  fees,
  isBotActive,
  currentPrice,
  pythPrice,
}: KpiBarProps) => {
  const market = marketLabel[marketCondition] ?? marketLabel.sideways;
  const isProfit = netPnl >= 0;

  const kpis = [
    {
      id: 'lp-value',
      icon: <Layers size={20} />,
      label: 'LP 評価額',
      value: `$${totalLpValue.toFixed(2)}`,
      sub: currentPrice > 0 ? `現在価格 ${currentPrice.toFixed(4)} USDC` : '価格取得中...',
      accent: '#58a6ff',
      bg: 'rgba(88,166,255,0.07)',
      border: 'rgba(88,166,255,0.18)',
      glow: 'rgba(88,166,255,0.15)',
    },
    {
      id: 'net-pnl',
      icon: isProfit ? <TrendingUp size={20} /> : <TrendingDown size={20} />,
      label: '純利益 (Net P&L)',
      value: `${isProfit ? '+' : ''}$${netPnl.toFixed(4)}`,
      sub: `手数料累計 +$${fees.toFixed(4)}`,
      accent: isProfit ? '#3fb950' : '#f85149',
      bg: isProfit ? 'rgba(63,185,80,0.07)' : 'rgba(248,81,73,0.07)',
      border: isProfit ? 'rgba(63,185,80,0.18)' : 'rgba(248,81,73,0.18)',
      glow: isProfit ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)',
    },
    {
      id: 'rebalances',
      icon: <RotateCw size={20} />,
      label: 'リバランス回数',
      value: `${totalRebalances}回`,
      sub: estimatedApr > 0 ? `推定 APR ${estimatedApr.toFixed(1)}%` : 'APR 計算中...',
      accent: '#d29922',
      bg: 'rgba(210,153,34,0.07)',
      border: 'rgba(210,153,34,0.18)',
      glow: 'rgba(210,153,34,0.15)',
    },
    {
      id: 'market',
      icon: <MarketIcon condition={marketCondition} />,
      label: '市場状況',
      value: market.label,
      sub: pythPrice ? `Pyth Oracle ${pythPrice.toFixed(4)}` : (isBotActive ? 'Bot稼働中' : 'Bot停止中'),
      accent: market.color,
      bg: market.bg,
      border: market.color.replace('rgb', 'rgba').replace(')', ',0.22)').replace('#3fb950', 'rgba(63,185,80,0.18)').replace('#f85149', 'rgba(248,81,73,0.18)').replace('#58a6ff', 'rgba(88,166,255,0.18)'),
      glow: market.bg,
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
          {isBotActive && kpi.id === 'lp-value' && (
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
