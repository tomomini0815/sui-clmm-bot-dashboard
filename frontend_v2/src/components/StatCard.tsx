import React from 'react';

interface StatCardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  change?: string; // 変化率表示用
}

export const StatCard: React.FC<StatCardProps> = ({ title, value, subtitle, icon, trend, change }) => {
  const valueColor = trend === 'up' ? 'var(--success)' : trend === 'down' ? 'var(--danger)' : 'var(--text-main)';
  const trendIcon = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→';
  
  return (
    <div className="glass-panel" style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      gap: '12px',
      padding: '18px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <h3 style={{ 
          color: 'var(--text-muted)', 
          fontSize: '0.8rem', 
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.03em'
        }}>
          {title}
        </h3>
        <div style={{ 
          color: 'var(--accent)',
          background: 'rgba(88, 166, 255, 0.1)',
          padding: '6px',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          {icon}
        </div>
      </div>
      
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ 
          fontSize: '1.8rem', 
          fontWeight: 700, 
          color: valueColor,
          lineHeight: 1
        }}>
          {value}
        </span>
        {change && (
          <span style={{ 
            fontSize: '0.9rem', 
            color: valueColor,
            fontWeight: 600,
            background: trend === 'up' ? 'rgba(63, 185, 80, 0.15)' : trend === 'down' ? 'rgba(248, 81, 73, 0.15)' : 'transparent',
            padding: '3px 8px',
            borderRadius: '6px'
          }}>
            {trendIcon} {change}
          </span>
        )}
      </div>
      
      {subtitle && (
        <p style={{ 
          color: 'var(--text-muted)', 
          fontSize: '0.8rem',
          marginTop: '2px',
          paddingTop: '8px',
          borderTop: '1px solid var(--border-panel)'
        }}>
          {subtitle}
        </p>
      )}
    </div>
  );
};
