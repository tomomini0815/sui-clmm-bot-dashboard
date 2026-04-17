import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Area } from 'recharts';
import { TrendingDown, TrendingUp, ShieldCheck } from 'lucide-react';

interface HedgePerfChartProps {
  data: { time: string; poolPrice: number; entryPrice: number | null }[];
  currentPrice: number;
  entryPrice: number;
  active: boolean;
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

export const HedgePerfChart: React.FC<HedgePerfChartProps> = ({ data, currentPrice, entryPrice, active }) => {
  const pnlPercent = entryPrice > 0 ? ((entryPrice - currentPrice) / entryPrice * 100) : 0;
  
  return (
    <div className="glass-panel" style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldCheck size={20} color="var(--accent)" />
            ヘッジパフォーマンス (ショートポジション)
          </h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
             価格下落時にLPの評価損をカバーします
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <div style={{
            background: 'rgba(255, 255, 255, 0.05)',
            padding: '8px 14px', borderRadius: '8px',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            textAlign: 'right'
          }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginBottom: '2px' }}>建玉価格</div>
            <div style={{ fontWeight: 700, fontSize: '1rem' }}>{entryPrice > 0 ? entryPrice.toFixed(4) : '-'}</div>
          </div>
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

      <div style={{ height: '220px', width: '100%', position: 'relative' }}>
        {!active || data.length === 0 ? (
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
              
              <ReferenceLine 
                y={entryPrice} 
                stroke="var(--accent)" 
                strokeDasharray="3 3" 
                label={{ 
                  value: 'SHORT ENTRY', 
                  position: 'insideTopRight', 
                  fill: 'var(--accent)', 
                  fontSize: 10,
                  fontWeight: 700
                }}
              />

              <Area
                type="monotone"
                dataKey="poolPrice"
                stroke="none"
                fill={currentPrice < entryPrice ? 'rgba(63, 185, 80, 0.1)' : 'rgba(248, 81, 73, 0.1)'}
              />

              <Line
                type="monotone"
                dataKey="poolPrice"
                name="SUI価格"
                stroke={currentPrice < entryPrice ? 'var(--success)' : 'var(--danger)'}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

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
        <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent)' }}></div>
        <span>青点線：建玉価格（ショートエントリー）を基準に、SUI価格が下がるほど利益が発生します。</span>
      </div>
    </div>
  );
};
