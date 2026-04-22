import React from 'react';
import { Layers, Info, ArrowUpDown } from 'lucide-react';

interface StrategyVisualizerProps {
  totalCapital: number;
  config?: { strategyMode?: 'balanced' | 'range_order' };
  hedge?: { active?: boolean; direction?: string; size?: number };
  onUpdateStrategyMode: (mode: 'balanced' | 'range_order') => void;
}

export const StrategyVisualizer: React.FC<StrategyVisualizerProps> = ({ 
  totalCapital, 
  config, 
  hedge,
  onUpdateStrategyMode 
}) => {
  // Delta-Neutral Flip 戦略
  // LP: ~100% (USDC 50% + SUI 50%)
  // ヘッジ: LP内SUI価値の ~50% (レバレッジ活用)

  const hedgeNotional = totalCapital * 0.25; // 表示用概算

  const hedgeDirection = hedge?.direction || 'NONE';
  const isShort = hedgeDirection === 'SHORT';
  const isLong = hedgeDirection === 'LONG';

  return (
    <div className="glass-panel" style={{ }}>
      {/* 運用戦略エンジン */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ 
            background: 'rgba(88, 166, 255, 0.15)', 
            padding: '6px', 
            borderRadius: '8px',
            color: 'var(--accent)'
          }}>
            <Layers size={18} />
          </div>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>運用戦略エンジン</h3>
        </div>
        
        <div style={{ 
          display: 'flex', background: 'rgba(255, 255, 255, 0.05)', 
          padding: '4px', borderRadius: '10px', gap: '4px' 
        }}>
          <button
            onClick={() => onUpdateStrategyMode('balanced')}
            style={{
              flex: 1, padding: '8px 4px', borderRadius: '8px', border: 'none',
              fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s',
              background: config?.strategyMode === 'balanced' ? 'var(--accent)' : 'transparent',
              color: config?.strategyMode === 'balanced' ? 'white' : 'var(--text-muted)',
              boxShadow: config?.strategyMode === 'balanced' ? '0 2px 6px rgba(88, 166, 255, 0.4)' : 'none'
            }}
          >
            DN Flip
          </button>
          <button
            onClick={() => onUpdateStrategyMode('range_order')}
            style={{
              flex: 1, padding: '8px 4px', borderRadius: '8px', border: 'none',
              fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s',
              background: config?.strategyMode === 'range_order' ? 'var(--accent)' : 'transparent',
              color: config?.strategyMode === 'range_order' ? 'white' : 'var(--text-muted)',
              boxShadow: config?.strategyMode === 'range_order' ? '0 2px 6px rgba(88, 166, 255, 0.4)' : 'none'
            }}
          >
            指値レンジ
          </button>
        </div>
      </div>

      {/* ヘッジ方向インジケーター */}
      {config?.strategyMode !== 'range_order' && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
          marginBottom: '16px', padding: '10px', borderRadius: '10px',
          background: isShort 
            ? 'rgba(239, 68, 68, 0.08)' 
            : isLong 
              ? 'rgba(34, 197, 94, 0.08)' 
              : 'rgba(255, 255, 255, 0.03)',
          border: `1px solid ${
            isShort ? 'rgba(239, 68, 68, 0.2)' : isLong ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255,255,255,0.06)'
          }`
        }}>
          <ArrowUpDown size={16} style={{ 
            color: isShort ? '#ef4444' : isLong ? '#22c55e' : 'var(--text-muted)'
          }} />
          <span style={{ 
            fontSize: '0.85rem', fontWeight: 700,
            color: isShort ? '#ef4444' : isLong ? '#22c55e' : 'var(--text-muted)'
          }}>
            {isShort ? '🔴 ショートヘッジ' : isLong ? '🟢 ロングヘッジ' : '⏸️ ヘッジなし'}
          </span>
          {hedge?.size && hedge.size > 0 && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              (${hedge.size.toFixed(1)})
            </span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '0.85rem', fontWeight: 600, margin: 0, color: 'var(--text-muted)' }}>
          {config?.strategyMode === 'range_order' ? '指値レンジ配分' : '資金配分 (LP全力 + レバレッジヘッジ)'}
        </h3>
      </div>

      <div style={{ position: 'relative', height: '16px', display: 'flex', borderRadius: '20px', overflow: 'hidden', marginBottom: '16px' }}>
        {/* LP USDC (50%) */}
        <div style={{ 
          width: '50%', 
          background: 'var(--accent)', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          fontSize: '0.6rem',
          fontWeight: 800,
          color: 'white',
          borderRight: '1px solid rgba(0,0,0,0.1)'
        }} title="LP (USDC)">50%</div>
        
        {/* LP SUI (50%) */}
        <div style={{ 
          width: '50%', 
          background: 'rgba(88, 166, 255, 0.6)', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          fontSize: '0.6rem',
          fontWeight: 800,
          color: 'white',
        }} title="LP (SUI)">50%</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>LP (USDC)</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>${(totalCapital * 0.50).toFixed(1)}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>LP (SUI)</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>${(totalCapital * 0.50).toFixed(1)}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>ヘッジ</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700, color: isShort ? '#ef4444' : isLong ? '#22c55e' : 'inherit' }}>
            ${hedgeNotional.toFixed(1)}
          </div>
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
        <Info size={14} style={{ marginTop: '2px', color: 'var(--text-muted)', flexShrink: 0 }} />
        <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>
          Delta-Neutral Flip: 資産の100%をLPに投入し、レンジ逸脱時にヘッジ方向を自動反転（SHORT↔LONG）。トレンドフォロー型のデルタニュートラル戦略です。
        </p>
      </div>
    </div>
  );
};
