import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

const mockData = [
  { time: '10:00', price: 1.250 },
  { time: '10:05', price: 1.258 },
  { time: '10:10', price: 1.265 },
  { time: '10:15', price: 1.261 },
  { time: '10:20', price: 1.270 },
  { time: '10:25', price: 1.282 },
  { time: '10:30', price: 1.278 },
  { time: '10:35', price: 1.255 },
];

export const PriceChart: React.FC = () => {
  return (
    <div className="glass-panel" style={{ height: '400px', display: 'flex', flexDirection: 'column' }}>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '24px' }}>
        SUI / USDC Price & Range Tracker
      </h2>
      <div style={{ flex: 1, width: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={mockData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <XAxis dataKey="time" stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} />
            <YAxis domain={['auto', 'auto']} stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} />
            <Tooltip 
              contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border-panel)', borderRadius: '8px' }}
              itemStyle={{ color: 'var(--neon-cyan)' }}
            />
            {/* 上限レンジ */}
            <ReferenceLine y={1.285} stroke="var(--neon-cetus)" strokeDasharray="3 3" label={{ position: 'top', value: 'Upper Bound', fill: 'var(--neon-cetus)', fontSize: 12 }} />
            {/* 下限レンジ */}
            <ReferenceLine y={1.240} stroke="var(--neon-cyan)" strokeDasharray="3 3" label={{ position: 'bottom', value: 'Lower Bound', fill: 'var(--neon-cyan)', fontSize: 12 }} />
            
            <Line type="monotone" dataKey="price" stroke="var(--text-main)" strokeWidth={2} dot={{ fill: 'var(--neon-cyan)', strokeWidth: 2, r: 4 }} activeDot={{ r: 6, stroke: 'var(--neon-cyan)', strokeWidth: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
