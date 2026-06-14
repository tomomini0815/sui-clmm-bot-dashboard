import React, { useMemo, useEffect } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { TrendingUp, BarChart3 } from 'lucide-react';

interface PricePoint {
  price: number;
  timestamp?: number;
  time?: string;
}

interface PriceChartPanelProps {
  priceHistory: PricePoint[];
  currentPrice: number;
  bot1OuterRange: { lower: number; upper: number };
  bot2OuterRange: { lower: number; upper: number };
  bot2PriceHistory: PricePoint[];
  bot2CurrentPrice: number;
  isBotActive: boolean;
  marketCondition: string;
  chartMode: 'recharts' | 'tradingview';
  setChartMode: (mode: 'recharts' | 'tradingview') => void;
}

const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    return (
      <div
        style={{
          background: 'rgba(22,27,34,0.95)',
          border: '1px solid rgba(88,166,255,0.25)',
          borderRadius: '10px',
          padding: '10px 14px',
          backdropFilter: 'blur(12px)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ color: '#58a6ff', fontWeight: 700, fontSize: '0.95rem' }}>
          {payload[0].value.toFixed(4)}
        </div>
        <div style={{ color: '#8b949e', fontSize: '0.75rem', marginTop: '3px' }}>
          {payload[0].payload.time || ''}
        </div>
      </div>
    );
  }
  return null;
};

const formatTime = (timestamp: number | undefined, index: number, total: number): string => {
  if (!timestamp) return '';
  if (index % Math.max(1, Math.floor(total / 8)) !== 0) return '';
  const d = new Date(timestamp);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
};

export const PriceChartPanel: React.FC<PriceChartPanelProps> = ({
  priceHistory,
  currentPrice,
  bot1OuterRange,
  bot2OuterRange,
  bot2PriceHistory,
  bot2CurrentPrice,
  isBotActive,
  marketCondition,
  chartMode,
  setChartMode,
}) => {
  const chartData1 = useMemo(() => {
    const source = priceHistory.slice(-200);
    return source.map((p, i) => ({
      price: p.price,
      timestamp: p.timestamp,
      time: p.timestamp ? formatTime(p.timestamp, i, source.length) : '',
      index: i,
    }));
  }, [priceHistory]);

  const yDomain1 = useMemo(() => {
    if (chartData1.length === 0) return ['auto', 'auto'];
    const prices = chartData1.map((d) => d.price);
    const min = Math.min(...prices, bot1OuterRange.lower > 0 ? bot1OuterRange.lower : Infinity);
    const max = Math.max(...prices, bot1OuterRange.upper > 0 ? bot1OuterRange.upper : 0);
    const padding = (max - min) * 0.05;
    return [min - padding, max + padding];
  }, [chartData1, bot1OuterRange]);

  const chartData2 = useMemo(() => {
    const source = bot2PriceHistory.slice(-200);
    return source.map((p, i) => ({
      price: p.price,
      timestamp: p.timestamp,
      time: p.timestamp ? formatTime(p.timestamp, i, source.length) : '',
      index: i,
    }));
  }, [bot2PriceHistory]);

  const yDomain2 = useMemo(() => {
    if (chartData2.length === 0) return ['auto', 'auto'];
    const prices = chartData2.map((d) => d.price);
    const min = Math.min(...prices, bot2OuterRange.lower > 0 ? bot2OuterRange.lower : Infinity);
    const max = Math.max(...prices, bot2OuterRange.upper > 0 ? bot2OuterRange.upper : 0);
    const padding = (max - min) * 0.05;
    return [min - padding, max + padding];
  }, [chartData2, bot2OuterRange]);

  const isUptrend = marketCondition === 'uptrend';
  const lineColor = isUptrend ? '#3fb950' : marketCondition === 'downtrend' ? '#f85149' : '#58a6ff';

  // SUI, DEEP, BTC の 3つのTradingViewウィジェットを初期化する useEffect
  useEffect(() => {
    if (chartMode !== 'tradingview') return;

    const scriptId = 'tradingview-widget-script';
    let script = document.getElementById(scriptId) as HTMLScriptElement;

    const initWidgets = () => {
      if (!(window as any).TradingView) return;

      const defaultOptions = (symbol: string, containerId: string) => ({
        autosize: true,
        symbol: symbol,
        interval: '240', // 4時間足
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
        locale: 'ja',
        enable_publishing: false,
        hide_side_toolbar: false,
        allow_symbol_change: true,
        container_id: containerId,
        studies: [
          {
            id: 'MASimple@tv-basicstudies',
            inputs: { length: 200 }
          },
          {
            id: 'BB@tv-basicstudies',
            inputs: { length: 20 }
          }
        ],
        studies_overrides: {
          // MA200: 2番目の太さ (plot もしくは ma の両方に適用)
          "moving average.ma.linewidth": 2,
          "moving average.plot.linewidth": 2,

          // ボリンジャーバンド (ミドル: 3番目の太さ, アッパー/ロワー: 1番目の太さで細かい点線)
          "bollinger bands.basis.linewidth": 3,
          "bollinger bands.median.linewidth": 3,
          "bollinger bands.upper.linewidth": 1,
          "bollinger bands.upper.style": 2,
          "bollinger bands.upper.linestyle": 2,
          "bollinger bands.lower.linewidth": 1,
          "bollinger bands.lower.style": 2,
          "bollinger bands.lower.linestyle": 2
        }
      });

      new (window as any).TradingView.widget(defaultOptions('OKX:SUIUSDC', 'tradingview-chart-container-sui'));
      new (window as any).TradingView.widget(defaultOptions('BYBIT:DEEPUSDT', 'tradingview-chart-container-deep'));
      new (window as any).TradingView.widget(defaultOptions('BINANCE:BTCUSDC', 'tradingview-chart-container-btc'));
    };

    if (!script) {
      script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://s3.tradingview.com/tv.js';
      script.type = 'text/javascript';
      script.async = true;
      script.onload = () => {
        initWidgets();
      };
      document.head.appendChild(script);
    } else {
      if ((window as any).TradingView) {
        initWidgets();
      } else {
        script.onload = () => initWidgets();
      }
    }
  }, [chartMode]);

  const showPlaceholder = chartMode === 'recharts' && (!isBotActive || (chartData1.length < 2 && chartData2.length < 2));
  const showBot1Placeholder = chartMode === 'recharts' && (!isBotActive || chartData1.length < 2);
  const showBot2Placeholder = chartMode === 'recharts' && (!isBotActive || chartData2.length < 2);

  return (
    <div className="glass-panel price-chart-panel" style={{ 
      display: 'flex', 
      flexDirection: 'column'
    }}>
      <div className="price-chart-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div className="section-icon-sm" style={{ color: lineColor }}>
            <TrendingUp size={18} />
          </div>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>
            {chartMode === 'recharts' ? (
              <>価格・LPレンジ監視 <span style={{ color: '#8b949e', fontWeight: 400, fontSize: '0.8rem' }}>(Bot1 / Bot2)</span></>
            ) : (
              <>TradingView チャート <span style={{ color: '#8b949e', fontWeight: 400, fontSize: '0.8rem' }}>(4H ローソク足)</span></>
            )}
          </h3>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          {/* チャートモード切替トグル */}
          <div className="chart-mode-toggle" style={{ display: 'flex', gap: '4px', background: 'rgba(255,255,255,0.03)', padding: '2px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
            <button
              onClick={() => setChartMode('recharts')}
              style={{
                background: chartMode === 'recharts' ? 'rgba(88, 166, 255, 0.12)' : 'transparent',
                border: 'none',
                color: chartMode === 'recharts' ? 'var(--accent)' : 'var(--text-muted)',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              LPレンジ
            </button>
            <button
              onClick={() => setChartMode('tradingview')}
              style={{
                background: chartMode === 'tradingview' ? 'rgba(88, 166, 255, 0.12)' : 'transparent',
                border: 'none',
                color: chartMode === 'tradingview' ? 'var(--accent)' : 'var(--text-muted)',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              TradingView (3ペア並び)
            </button>
          </div>

          {chartMode === 'recharts' && currentPrice > 0 && (
            <div className="current-price-badge" style={{ color: lineColor, borderColor: lineColor + '44' }}>
              SUI: {currentPrice.toFixed(4)} <span>USDC</span>
            </div>
          )}
          {chartMode === 'recharts' && bot2CurrentPrice > 0 && (
            <div className="current-price-badge" style={{ color: '#a855f7', borderColor: 'rgba(168, 85, 247, 0.3)' }}>
              DEEP: {bot2CurrentPrice.toFixed(4)} <span>SUI</span>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {showPlaceholder ? (
          <div key="placeholder" className="chart-placeholder" style={{ minHeight: '300px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <BarChart3 size={48} strokeWidth={1} />
            <p>Botが稼働を開始すると価格チャートが表示されます</p>
            <span className="chart-placeholder-sub">SUI / USDC & DEEP / SUI — リアルタイム更新</span>
          </div>
        ) : chartMode === 'recharts' ? (
          <div key="recharts" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', padding: '4px 0' }}>
            
            {/* Bot1 (SUI / USDC) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', padding: '0 4px' }}>
                <span>Bot1: SUI / USDC (配置レンジ端: {bot1OuterRange.lower > 0 ? bot1OuterRange.lower.toFixed(3) : '-'} - {bot1OuterRange.upper > 0 ? bot1OuterRange.upper.toFixed(3) : '-'})</span>
                <span style={{ color: lineColor }}>現在価格: {currentPrice.toFixed(4)} USDC</span>
              </div>
              <div style={{ height: '340px', width: '100%', background: 'rgba(0,0,0,0.15)', borderRadius: '12px', padding: '16px 12px 0 12px', border: '1px solid rgba(255,255,255,0.03)' }}>
                {showBot1Placeholder ? (
                  <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                    <BarChart3 size={36} strokeWidth={1} />
                    <p style={{ fontSize: '0.8rem', marginTop: '8px' }}>Bot1稼働開始後に表示されます</p>
                  </div>
                ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData1} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="priceGradient-bot1" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor={lineColor} stopOpacity={0.25} />
                        <stop offset="95%" stopColor={lineColor} stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="rgba(255,255,255,0.05)"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="time"
                      tick={{ fill: '#8b949e', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={yDomain1 as [number, number]}
                      tick={{ fill: '#8b949e', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={72}
                      tickFormatter={(v) => v.toFixed(3)}
                    />
                    <Tooltip content={<CustomTooltip />} />

                    {bot1OuterRange.upper > 0 && (
                      <ReferenceLine
                        y={bot1OuterRange.upper}
                        stroke="#3fb950"
                        strokeDasharray="6 3"
                        strokeWidth={1.5}
                        label={{
                          value: `上限 ${bot1OuterRange.upper.toFixed(3)}`,
                          fill: '#3fb950',
                          fontSize: 11,
                          position: 'right',
                        }}
                      />
                    )}
                    {bot1OuterRange.lower > 0 && (
                      <ReferenceLine
                        y={bot1OuterRange.lower}
                        stroke="#f85149"
                        strokeDasharray="6 3"
                        strokeWidth={1.5}
                        label={{
                          value: `下限 ${bot1OuterRange.lower.toFixed(3)}`,
                          fill: '#f85149',
                          fontSize: 11,
                          position: 'right',
                        }}
                      />
                    )}
                    {currentPrice > 0 && (
                      <ReferenceLine
                        y={currentPrice}
                        stroke={lineColor}
                        strokeWidth={1.5}
                        strokeOpacity={0.7}
                      />
                    )}

                    <Area
                      type="monotone"
                      dataKey="price"
                      stroke={lineColor}
                      strokeWidth={2}
                      fill="url(#priceGradient-bot1)"
                      dot={false}
                      activeDot={{ r: 4, fill: lineColor, stroke: '#0f1117', strokeWidth: 2 }}
                      animationDuration={300}
                    />
                  </AreaChart>
                </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Bot2 (DEEP / SUI) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', padding: '0 4px' }}>
                <span>Bot2: DEEP / SUI (配置レンジ端: {bot2OuterRange.lower > 0 ? bot2OuterRange.lower.toFixed(4) : '-'} - {bot2OuterRange.upper > 0 ? bot2OuterRange.upper.toFixed(4) : '-'})</span>
                <span style={{ color: '#a855f7' }}>現在価格: {bot2CurrentPrice.toFixed(4)} SUI</span>
              </div>
              <div style={{ height: '340px', width: '100%', background: 'rgba(0,0,0,0.15)', borderRadius: '12px', padding: '16px 12px 0 12px', border: '1px solid rgba(255,255,255,0.03)' }}>
                {showBot2Placeholder ? (
                  <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                    <BarChart3 size={36} strokeWidth={1} />
                    <p style={{ fontSize: '0.8rem', marginTop: '8px' }}>Bot2稼働開始後に表示されます</p>
                  </div>
                ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData2} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="priceGradient-bot2" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#a855f7" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#a855f7" stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="rgba(255,255,255,0.05)"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="time"
                      tick={{ fill: '#8b949e', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={yDomain2 as [number, number]}
                      tick={{ fill: '#8b949e', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={72}
                      tickFormatter={(v) => v.toFixed(4)}
                    />
                    <Tooltip content={<CustomTooltip />} />

                    {bot2OuterRange.upper > 0 && (
                      <ReferenceLine
                        y={bot2OuterRange.upper}
                        stroke="#3fb950"
                        strokeDasharray="6 3"
                        strokeWidth={1.5}
                        label={{
                          value: `上限 ${bot2OuterRange.upper.toFixed(4)}`,
                          fill: '#3fb950',
                          fontSize: 11,
                          position: 'right',
                        }}
                      />
                    )}
                    {bot2OuterRange.lower > 0 && (
                      <ReferenceLine
                        y={bot2OuterRange.lower}
                        stroke="#f85149"
                        strokeDasharray="6 3"
                        strokeWidth={1.5}
                        label={{
                          value: `下限 ${bot2OuterRange.lower.toFixed(4)}`,
                          fill: '#f85149',
                          fontSize: 11,
                          position: 'right',
                        }}
                      />
                    )}
                    {bot2CurrentPrice > 0 && (
                      <ReferenceLine
                        y={bot2CurrentPrice}
                        stroke="#a855f7"
                        strokeWidth={1.5}
                        strokeOpacity={0.7}
                      />
                    )}

                    <Area
                      type="monotone"
                      dataKey="price"
                      stroke="#a855f7"
                      strokeWidth={2}
                      fill="url(#priceGradient-bot2)"
                      dot={false}
                      activeDot={{ r: 4, fill: '#a855f7', stroke: '#0f1117', strokeWidth: 2 }}
                      animationDuration={300}
                    />
                  </AreaChart>
                </ResponsiveContainer>
                )}
              </div>
            </div>

          </div>
        ) : (
          <div key="tradingview" style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%', marginTop: '8px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                <span>SUI / USDC</span>
                <span>4時間足 (OKX)</span>
              </div>
              <div id="tradingview-chart-container-sui" style={{ height: '460px', borderRadius: '12px', overflow: 'hidden' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                <span>DEEP / USDT</span>
                <span>4時間足 (Bybit)</span>
              </div>
              <div id="tradingview-chart-container-deep" style={{ height: '460px', borderRadius: '12px', overflow: 'hidden' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                <span>BTC / USDC</span>
                <span>4時間足 (Binance)</span>
              </div>
              <div id="tradingview-chart-container-btc" style={{ height: '460px', borderRadius: '12px', overflow: 'hidden' }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
