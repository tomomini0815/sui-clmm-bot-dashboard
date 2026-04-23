import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Area } from 'recharts';
import { TrendingDown, TrendingUp, ShieldCheck } from 'lucide-react';

interface HedgePerfChartProps {
  data: { time: string; poolPrice: number; entryPrice: number | null }[];
  currentPrice: number;
  entryPrice: number;
  active: boolean;
  direction?: 'SHORT' | 'LONG' | 'NONE' | string;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div style={{
      background: 'rgba(22, 27, 34, 0.95)',
      border: '1px solid rgba(88, 166, 255, 0.25)',
      borderRadius: '10px',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
      padding: '10px 14px',
      fontSize: '0.85rem',
    }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: '8px' }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color, fontWeight: 600, marginTop: '4px' }}>
          {p.name}：{Number(p.value).toFixed(4)} USDC
        </div>
      ))}
    </div>
  );
};

export const HedgePerfChart: React.FC<HedgePerfChartProps> = ({
  data, currentPrice, entryPrice, active, direction = 'SHORT'
}) => {
  const isLong   = direction === 'LONG';
  const isShort  = direction === 'SHORT';
  const isNone   = !isLong && !isShort;

  // SHORT: 価格下落 → 利益
  // LONG : 価格上昇 → 利益
  const rawPnlPct = entryPrice > 0
    ? isLong
      ? (currentPrice - entryPrice) / entryPrice * 100
      : (entryPrice - currentPrice) / entryPrice * 100
    : 0;
  const pnlPercent = rawPnlPct;

  // 色設定
  const entryLineColor = isLong ? '#3fb950' : '#ff4d4d';    // LONG=緑 / SHORT=赤
  const priceLineColorProfit  = isLong ? 'var(--success)' : 'var(--success)';
  const priceLineColorLoss    = isLong ? 'var(--danger)'  : 'var(--danger)';

  // 価格が利益方向かどうか
  const isInProfit = isLong
    ? currentPrice > entryPrice
    : currentPrice < entryPrice;

  const priceLineColor = isInProfit ? priceLineColorProfit : priceLineColorLoss;
  const areaFill       = isInProfit
    ? 'rgba(63, 185, 80, 0.1)'
    : 'rgba(248, 81, 73, 0.1)';

  // タイトル・説明文
  const titleLabel = isNone
    ? 'ヘッジパフォーマンス'
    : `ヘッジパフォーマンス (${isLong ? 'ロング' : 'ショート'}ポジション)`;

  const descLabel = isNone
    ? 'ヘッジポジション待機中'
    : isLong
    ? '価格上昇時にLPの評価損をカバーします'
    : '価格下落時にLPの評価損をカバーします';

  const entryLabel = isLong ? 'LONG ENTRY' : 'SHORT ENTRY';

  const legendText = isNone
    ? 'ヘッジポジションが開かれると詳細が表示されます。'
    : isLong
    ? `${isLong ? '緑' : '赤'}点線：建玉価格（ロングエントリー）を基準に、SUI価格が上がるほど利益が発生します。`
    : '赤点線：建玉価格（ショートエントリー）を基準に、SUI価格が下がるほど利益が発生します。';

  return (
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* ヘッダー */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldCheck size={20} color={isLong ? 'var(--success)' : 'var(--accent)'} />
            {titleLabel}
          </h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
            {descLabel}
          </p>
        </div>

        {/* ポジション方向バッジ */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {!isNone && (
            <div style={{
              padding: '4px 12px',
              borderRadius: '20px',
              fontSize: '0.78rem',
              fontWeight: 700,
              letterSpacing: '0.06em',
              background: isLong
                ? 'rgba(63, 185, 80, 0.15)'
                : 'rgba(248, 81, 73, 0.15)',
              border: `1px solid ${isLong ? 'rgba(63, 185, 80, 0.4)' : 'rgba(248, 81, 73, 0.4)'}`,
              color: isLong ? 'var(--success)' : 'var(--danger)',
              display: 'flex',
              alignItems: 'center',
              gap: '5px'
            }}>
              {isLong ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
              {isLong ? 'LONG' : 'SHORT'}
            </div>
          )}

          {/* 建玉価格 */}
          <div style={{
            background: 'rgba(255, 255, 255, 0.05)',
            padding: '8px 14px', borderRadius: '8px',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            textAlign: 'right'
          }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginBottom: '2px' }}>建玉価格</div>
            <div style={{ fontWeight: 700, fontSize: '1rem' }}>{entryPrice > 0 ? entryPrice.toFixed(4) : '-'}</div>
          </div>

          {/* ヘッジ損益 */}
          <div style={{
            background: pnlPercent >= 0 ? 'rgba(63, 185, 80, 0.1)' : 'rgba(248, 81, 73, 0.1)',
            padding: '8px 14px', borderRadius: '8px',
            border: `1px solid ${pnlPercent >= 0 ? 'rgba(63, 185, 80, 0.25)' : 'rgba(248, 81, 73, 0.25)'}`,
            textAlign: 'right'
          }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginBottom: '2px' }}>ヘッジ損益</div>
            <div style={{
              fontWeight: 700,
              fontSize: '1rem',
              color: pnlPercent >= 0 ? 'var(--success)' : 'var(--danger)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: '4px'
            }}>
              {pnlPercent >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
              {pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(2)}%
            </div>
          </div>
        </div>
      </div>

      {/* チャート */}
      <div style={{ height: '220px', width: '100%', position: 'relative' }}>
        {(!active && entryPrice <= 0) || data.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', opacity: 0.6 }}>
            待機中：ポジションが開かれるとチャートが表示されます
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 5, right: 30, left: 10, bottom: 0 }}>
              <XAxis dataKey="time" hide />
              <YAxis
                domain={[
                  (dataMin: number) => Number((Math.min(dataMin, entryPrice) * 0.99).toFixed(4)),
                  (dataMax: number) => Number((Math.max(dataMax, entryPrice) * 1.01).toFixed(4)),
                ]}
                hide
              />
              <Tooltip content={<CustomTooltip />} />

              {/* エントリー価格の基準線 */}
              <ReferenceLine
                y={entryPrice}
                stroke={entryLineColor}
                strokeDasharray="3 3"
                strokeWidth={2}
                label={{
                  value: entryLabel,
                  position: 'insideTopRight',
                  fill: entryLineColor,
                  fontSize: 11,
                  fontWeight: 800
                }}
              />

              {/* 現在価格の水平線 */}
              {currentPrice > 0 && (
                <ReferenceLine
                  y={currentPrice}
                  stroke="rgba(255,255,255,0.3)"
                  strokeDasharray="2 4"
                  strokeWidth={1}
                  label={{
                    value: 'NOW',
                    position: 'insideBottomRight',
                    fill: 'rgba(255,255,255,0.45)',
                    fontSize: 10,
                  }}
                />
              )}

              <Area
                type="monotone"
                dataKey="poolPrice"
                stroke="none"
                fill={areaFill}
              />

              <Line
                type="monotone"
                dataKey="poolPrice"
                name="SUI価格"
                stroke={priceLineColor}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* 凡例 */}
      <div style={{
        fontSize: '0.8rem',
        color: 'var(--text-muted)',
        background: 'rgba(255, 255, 255, 0.03)',
        padding: '10px 14px',
        borderRadius: '8px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
      }}>
        <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: entryLineColor, flexShrink: 0 }}></div>
        <span>{legendText}</span>
      </div>
    </div>
  );
};
