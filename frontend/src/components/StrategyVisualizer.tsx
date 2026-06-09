import React, { useState, useEffect } from 'react';
import { Layers, Info, ArrowUpDown, Check, RotateCw } from 'lucide-react';

interface StrategyVisualizerProps {
  totalCapital: number;
  config?: { 
    strategyMode?: 'balanced' | 'range_order';
    rangeWidth?: number;
    rangeOrderWidthPct?: number;
    hedgeEnabled?: boolean;
  };
  hedge?: { active?: boolean; direction?: string; size?: number };
  onUpdateStrategyMode: (mode: 'balanced' | 'range_order', hedgeEnabled: boolean) => void;
  onUpdateRangeWidth?: (newWidth: number) => void;
  onRestartRebuild?: (rangeWidth?: number) => void;
  isActionPending?: boolean;
}

export const StrategyVisualizer: React.FC<StrategyVisualizerProps> = ({ 
  totalCapital, 
  config, 
  hedge,
  onUpdateStrategyMode,
  onUpdateRangeWidth,
  onRestartRebuild,
  isActionPending = false
}) => {
  const effectiveRangeWidth = ((config?.rangeOrderWidthPct ?? config?.rangeWidth ?? 0.05) * 100);
  const [localRangeWidth, setLocalRangeWidth] = useState(effectiveRangeWidth);

  useEffect(() => {
    setLocalRangeWidth(effectiveRangeWidth);
  }, [effectiveRangeWidth]);
  // Delta-Neutral Flip 戦略
  // LP: ~100% (USDC 50% + SUI 50%)
  // ヘッジ: LP内SUI価値の ~50% (レバレッジ活用)

  const hedgeNotional = totalCapital * 0.25; // 表示用概算

  const hedgeDirection = hedge?.direction || 'NONE';
  const isShort = hedgeDirection === 'SHORT';
  const isLong = hedgeDirection === 'LONG';
  const isRangeDirty = Math.abs(localRangeWidth - effectiveRangeWidth) >= 0.01;

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
            onClick={() => onUpdateStrategyMode('balanced', true)}
            style={{
              flex: 1, padding: '8px 4px', borderRadius: '8px', border: 'none',
              fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s',
              background: (config?.strategyMode === 'balanced') ? 'var(--accent)' : 'transparent',
              color: (config?.strategyMode === 'balanced') ? 'white' : 'var(--text-muted)',
              boxShadow: (config?.strategyMode === 'balanced') ? '0 2px 6px rgba(88, 166, 255, 0.4)' : 'none'
            }}
          >
            ヘッジあり
          </button>
          <button
            onClick={() => onUpdateStrategyMode('range_order', false)}
            style={{
              flex: 1, padding: '8px 4px', borderRadius: '8px', border: 'none',
              fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s',
              background: (config?.strategyMode === 'range_order') ? 'var(--accent)' : 'transparent',
              color: (config?.strategyMode === 'range_order') ? 'white' : 'var(--text-muted)',
              boxShadow: (config?.strategyMode === 'range_order') ? '0 2px 6px rgba(88, 166, 255, 0.4)' : 'none'
            }}
          >
            ヘッジなし
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
          {config?.strategyMode === 'range_order'
            ? '指値レンジは保存後、次回の再配置から反映されます。すぐ反映したい場合は「この幅で8再配置」を実行します。'
            : 'デルタニュートラル・フリップ: 資産の100%をLPに投入し、レンジ逸脱時にヘッジ方向を自動反転します。'}
        </p>
      </div>

      {/* レンジ幅調整スライダー */}
      {config && (
        <div style={{
          marginTop: '20px',
          padding: '12px',
          background: 'rgba(255, 255, 255, 0.02)',
          borderRadius: '10px',
          border: '1px solid rgba(255, 255, 255, 0.04)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-main)', fontWeight: 600 }}>Cetus レンジ幅</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {isRangeDirty && (
                <span style={{
                  fontSize: '0.68rem',
                  color: '#ff9f43',
                  background: 'rgba(255, 159, 67, 0.12)',
                  border: '1px solid rgba(255, 159, 67, 0.25)',
                  borderRadius: '6px',
                  padding: '2px 6px',
                  whiteSpace: 'nowrap'
                }}>未保存</span>
              )}
              <span style={{ fontSize: '0.85rem', color: 'var(--accent)', fontWeight: 800 }}>
                {localRangeWidth.toFixed(1)}%
              </span>
            </div>
          </div>
          <input
            type="range"
            min="1.0"
            max="15.0"
            step="0.5"
            value={localRangeWidth}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              setLocalRangeWidth(val);
            }}
            style={{
              width: '100%',
              accentColor: 'var(--accent)',
              cursor: 'pointer',
              height: '4px',
              borderRadius: '2px',
              outline: 'none',
              background: 'rgba(255,255,255,0.1)'
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '4px' }}>
            <span>狭い (高APR / 高リスク)</span>
            <span>広い (低APR / 安定)</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '12px' }}>
            <button
              onClick={() => onUpdateRangeWidth?.(localRangeWidth)}
              disabled={isActionPending || !isRangeDirty}
              title="レンジ幅だけ保存します。既存ポジションは作り直しません。"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                minHeight: '36px',
                borderRadius: '8px',
                border: '1px solid rgba(88, 166, 255, 0.28)',
                background: isRangeDirty ? 'rgba(88, 166, 255, 0.14)' : 'rgba(255,255,255,0.04)',
                color: isRangeDirty ? 'var(--accent)' : 'var(--text-muted)',
                fontSize: '0.76rem',
                fontWeight: 700,
                cursor: isActionPending || !isRangeDirty ? 'not-allowed' : 'pointer',
                opacity: isActionPending || !isRangeDirty ? 0.65 : 1
              }}
            >
              <Check size={14} />
              幅を保存
            </button>
            <button
              onClick={() => onRestartRebuild?.(localRangeWidth)}
              disabled={isActionPending}
              title="このレンジ幅を保存して、Bot1/Bot2を各4ポジションに作り直します。"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                minHeight: '36px',
                borderRadius: '8px',
                border: '1px solid rgba(46, 213, 115, 0.30)',
                background: 'rgba(46, 213, 115, 0.11)',
                color: '#2ed573',
                fontSize: '0.76rem',
                fontWeight: 800,
                cursor: isActionPending ? 'not-allowed' : 'pointer',
                opacity: isActionPending ? 0.65 : 1
              }}
            >
              <RotateCw size={14} style={{ animation: isActionPending ? 'spin 1s linear infinite' : 'none' }} />
              この幅で8再配置
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
