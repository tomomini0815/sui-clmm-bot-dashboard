import React from 'react';

interface StatCardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ReactNode;
  trend?: 'up' | 'down' | 'neutral';
}

export const StatCard: React.FC<StatCardProps> = ({ title, value, subtitle, icon, trend }) => {
  return (
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ color: 'var(--text-muted)', fontSize: '0.9rem', fontWeight: 500 }}>{title}</h3>
        <div style={{ color: 'var(--neon-cyan)' }}>{icon}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <span style={{ fontSize: '2rem', fontWeight: 600, color: 'var(--text-main)' }}>{value}</span>
        {trend === 'up' && <span style={{ color: '#00e676', fontSize: '0.85rem' }}>+5.2%</span>}
        {trend === 'down' && <span style={{ color: '#ff3d00', fontSize: '0.85rem' }}>-1.4%</span>}
      </div>
      {subtitle && <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{subtitle}</p>}
    </div>
  );
};
