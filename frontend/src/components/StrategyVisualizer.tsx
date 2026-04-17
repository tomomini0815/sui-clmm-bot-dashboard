import React from 'react';
import { PieChart, Layers, Info } from 'lucide-react';

interface StrategyVisualizerProps {
  totalCapital: number;
}

export const StrategyVisualizer: React.FC<StrategyVisualizerProps> = ({ totalCapital }) => {
  // 25/25/50 戦略
  // 25% USDC (LP用)
  // 25% SUI (LP用)
  // 50% USDC (Bluefin 証拠金用)
  
  const lpUsdc = totalCapital * 0.25;
  const lpSui = totalCapital * 0.25;
  const hedgeMargin = totalCapital * 0.50;

  return (
    <div className="glass-panel" style={{ marginBottom: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
        <div style={{ 
          background: 'rgba(210, 153, 34, 0.1)', 
          padding: '6px', 
          borderRadius: '8px',
          color: 'var(--warning)'
        }}>
          <Layers size={18} />
        </div>
        <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>運用資金配分 (25/25/50)</h3>
      </div>

      <div style={{ position: 'relative', height: '32px', display: 'flex', borderRadius: '8px', overflow: 'hidden', marginBottom: '12px' }}>
        {/* LP USDC (25%) */}
        <div style={{ 
          width: '25%', 
          background: 'var(--accent)', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          fontSize: '0.7rem',
          fontWeight: 700,
          color: 'white',
          borderRight: '1px solid rgba(0,0,0,0.1)'
        }} title="LP (USDC)">25%</div>
        
        {/* LP SUI (25%) */}
        <div style={{ 
          width: '25%', 
          background: 'rgba(88, 166, 255, 0.6)', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          fontSize: '0.7rem',
          fontWeight: 700,
          color: 'white',
          borderRight: '1px solid rgba(0,0,0,0.1)'
        }} title="LP (SUI)">25%</div>
        
        {/* Bluefin Margin (50%) */}
        <div style={{ 
          width: '50%', 
          background: 'var(--success)', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          fontSize: '0.7rem',
          fontWeight: 700,
          color: 'white'
        }} title="Bluefin Margin">50%</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>LP (USDC)</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>${lpUsdc.toFixed(1)}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>LP (SUI)</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>${lpSui.toFixed(1)}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Bluefin</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>${hedgeMargin.toFixed(1)}</div>
        </div>
      </div>

      <div style={{ 
        marginTop: '16px', 
        padding: '10px', 
        background: 'rgba(255, 255, 255, 0.02)', 
        borderRadius: '8px',
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-start'
      }}>
        <Info size={14} style={{ marginTop: '2px', color: 'var(--text-muted)' }} />
        <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>
          この戦略では、資産の50%をLPに、残りの50%をヘッジの証拠金に使用することで、市場の急変によるロスカットを防ぎつつ手数料を稼ぎます。
        </p>
      </div>
    </div>
  );
};
