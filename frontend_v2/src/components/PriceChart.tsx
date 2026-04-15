import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

interface PriceChartProps {
  data: any[];
  lowerBound: number;
  upperBound: number;
}

export const PriceChart: React.FC<PriceChartProps> = ({ data, lowerBound, upperBound }) => {
  return (
    <div className="glass-panel" style={{ height: '400px', display: 'flex', flexDirection: 'column' }}>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '24px' }}>
        SUI / USDC 価格推移 & リバランス幅
      </h2>
      <div style={{ flex: 1, width: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 20, right: 20, left: -20, bottom: 0 }}>
            <XAxis dataKey="time" stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} />
            <YAxis 
              domain={[(dataMin: number) => Number((dataMin * 0.99).toFixed(4)), (dataMax: number) => Number((dataMax * 1.01).toFixed(4))]} 
              stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} 
            />
            <Tooltip 
              contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border-panel)', borderRadius: '8px' }}
              itemStyle={{ color: 'var(--neon-cyan)' }}
            />
            {/* 上限レンジ */}
            {upperBound > 0 && (
              <ReferenceLine y={upperBound} stroke="var(--neon-cetus)" strokeDasharray="3 3" label={{ position: 'top', value: '🚀 上限（利益確定）', fill: 'var(--neon-cetus)', fontSize: 12 }} />
            )}
            {/* 下限レンジ */}
            {lowerBound > 0 && (
              <ReferenceLine y={lowerBound} stroke="var(--neon-cyan)" strokeDasharray="3 3" label={{ position: 'bottom', value: '📉 下限（資金保護）', fill: 'var(--neon-cyan)', fontSize: 12 }} />
            )}
            
            <Line isAnimationActive={false} type="monotone" dataKey="price" name="SUI価格" stroke="var(--text-main)" strokeWidth={2} dot={{ fill: 'var(--neon-cyan)', strokeWidth: 2, r: 4 }} activeDot={{ r: 6, stroke: 'var(--neon-cyan)', strokeWidth: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
