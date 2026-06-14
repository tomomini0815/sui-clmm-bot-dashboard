import React, { useState, useEffect } from 'react';
import { Layers, Info, Check, RotateCw } from 'lucide-react';

const MIN_CETUS_RANGE_WIDTH_PERCENT = 0.61;
const MAX_CETUS_RANGE_WIDTH_PERCENT = 15;

interface StrategyVisualizerProps {
  totalCapital: number;
  bot1LpValue?: number;
  bot2LpValue?: number;
  config?: { 
    strategyMode?: 'balanced' | 'range_order';
    rangeWidth?: number;
    rangeOrderWidthPct?: number;
    hedgeEnabled?: boolean;
  };
  onUpdateStrategyMode?: (mode: 'balanced' | 'range_order', hedgeEnabled: boolean) => void;
  onUpdateRangeWidth?: (newWidth: number) => void;
  onRestartRebuild?: (rangeWidth?: number) => void;
  isActionPending?: boolean;
  noPanel?: boolean;
}

export const StrategyVisualizer: React.FC<StrategyVisualizerProps> = ({ 
  totalCapital, 
  bot1LpValue = 0,
  bot2LpValue = 0,
  config, 
  onUpdateRangeWidth,
  onRestartRebuild,
  isActionPending = false,
  noPanel = false
}) => {
  const effectiveRangeWidth = ((config?.rangeOrderWidthPct ?? config?.rangeWidth ?? 0.05) * 100);
  const [localRangeWidth, setLocalRangeWidth] = useState(effectiveRangeWidth);

  useEffect(() => {
    setLocalRangeWidth(effectiveRangeWidth);
  }, [effectiveRangeWidth]);

  const isRangeDirty = Math.abs(localRangeWidth - effectiveRangeWidth) >= 0.01;
  const activeLpValue = bot1LpValue + bot2LpValue;
  const bot1AllocationPct = activeLpValue > 0 ? (bot1LpValue / activeLpValue) * 100 : 0;
  const bot2AllocationPct = activeLpValue > 0 ? (bot2LpValue / activeLpValue) * 100 : 0;
  const deploymentPct = totalCapital > 0 ? Math.min(100, (activeLpValue / totalCapital) * 100) : 0;

  const updateLocalRangeWidth = (value: number) => {
    if (!Number.isFinite(value)) return;
    setLocalRangeWidth(Math.min(MAX_CETUS_RANGE_WIDTH_PERCENT, Math.max(MIN_CETUS_RANGE_WIDTH_PERCENT, value)));
  };

  return (
    <div className={noPanel ? "" : "glass-panel"} style={{ }}>
      {/* 運用戦略エンジン */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px' }}>
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

      {/* 現在のLP稼働配分 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '8px', marginBottom: '12px'
      }}>
        <h3 style={{ fontSize: '0.85rem', fontWeight: 600, margin: 0, color: 'var(--text-muted)' }}>
          現在のLP稼働配分
        </h3>
        <span style={{
          fontSize: '0.68rem',
          color: deploymentPct > 0 ? 'var(--success)' : 'var(--text-muted)',
          background: deploymentPct > 0 ? 'rgba(63,185,80,0.10)' : 'rgba(255,255,255,0.04)',
          border: `1px solid ${deploymentPct > 0 ? 'rgba(63,185,80,0.25)' : 'rgba(255,255,255,0.08)'}`,
          borderRadius: '8px',
          padding: '3px 7px',
          fontWeight: 700,
          whiteSpace: 'nowrap'
        }}>
          LP稼働率 {deploymentPct.toFixed(1)}%
        </span>
      </div>

      <div style={{
        position: 'relative', height: '16px', display: 'flex',
        borderRadius: '20px', overflow: 'hidden', marginBottom: '16px',
        background: 'rgba(255,255,255,0.08)'
      }}>
        <div style={{ 
          width: `${bot1AllocationPct}%`,
          background: 'var(--accent)', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          fontSize: '0.6rem',
          fontWeight: 800,
          color: 'white',
          borderRight: '1px solid rgba(0,0,0,0.1)'
        }} title={`Bot1 SUI/USDC: ${bot1AllocationPct.toFixed(1)}%`}>
          {bot1AllocationPct >= 14 ? `${bot1AllocationPct.toFixed(0)}%` : ''}
        </div>
        
        <div style={{ 
          width: `${bot2AllocationPct}%`,
          background: '#2ed573',
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          fontSize: '0.6rem',
          fontWeight: 800,
          color: 'white',
        }} title={`Bot2 DEEP/SUI: ${bot2AllocationPct.toFixed(1)}%`}>
          {bot2AllocationPct >= 14 ? `${bot2AllocationPct.toFixed(0)}%` : ''}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Bot1 SUI/USDC</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>
            ${bot1LpValue.toFixed(2)}
            <span style={{ marginLeft: '4px', color: 'var(--accent)', fontSize: '0.68rem' }}>
              {bot1AllocationPct.toFixed(1)}%
            </span>
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Bot2 DEEP/SUI</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>
            ${bot2LpValue.toFixed(2)}
            <span style={{ marginLeft: '4px', color: '#2ed573', fontSize: '0.68rem' }}>
              {bot2AllocationPct.toFixed(1)}%
            </span>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <input
                  type="number"
                  min={MIN_CETUS_RANGE_WIDTH_PERCENT}
                  max={MAX_CETUS_RANGE_WIDTH_PERCENT}
                  step="0.01"
                  value={Number(localRangeWidth.toFixed(2))}
                  onChange={(e) => updateLocalRangeWidth(parseFloat(e.target.value))}
                  aria-label="Cetusレンジ幅"
                  style={{
                    width: '72px',
                    padding: '4px 6px',
                    borderRadius: '6px',
                    border: '1px solid rgba(88, 166, 255, 0.35)',
                    background: 'rgba(0, 0, 0, 0.22)',
                    color: 'var(--accent)',
                    fontSize: '0.82rem',
                    fontWeight: 800,
                    textAlign: 'right'
                  }}
                />
                <span style={{ fontSize: '0.82rem', color: 'var(--accent)', fontWeight: 800 }}>%</span>
              </div>
            </div>
          </div>
          <input
            type="range"
            min={MIN_CETUS_RANGE_WIDTH_PERCENT}
            max={MAX_CETUS_RANGE_WIDTH_PERCENT}
            step="0.01"
            value={localRangeWidth}
            onChange={(e) => {
              updateLocalRangeWidth(parseFloat(e.target.value));
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
            <span>最小 {MIN_CETUS_RANGE_WIDTH_PERCENT.toFixed(2)}%</span>
            <span>最大 {MAX_CETUS_RANGE_WIDTH_PERCENT.toFixed(0)}%</span>
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
