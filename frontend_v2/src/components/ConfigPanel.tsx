import React from 'react';
import { Settings, Play, Square, Edit3, Compass } from 'lucide-react';

interface ConfigPanelProps {
  isBotActive: boolean;
  onToggleBot: () => void;
  onOpenSettings: () => void;
  onOpenWizard: () => void;
  config?: { lpAmountUsdc: number, rangeWidth: number, hedgeRatio: number };
}

export const ConfigPanel: React.FC<ConfigPanelProps> = ({ isBotActive, onToggleBot, onOpenSettings, onOpenWizard, config }) => {
  return (
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Settings size={24} color="var(--neon-cetus)" />
          <h2 style={{ fontSize: '1.2rem', fontWeight: 600 }}>現在のBot設定</h2>
        </div>
        <button 
          onClick={onOpenSettings} 
          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem' }}
        >
          <Edit3 size={16} /> 変更
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-muted)' }}>1. 対象プール</span>
          <span style={{ fontWeight: 500 }}>SUI / USDC</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-muted)' }}>2. 運用金額</span>
          <span style={{ fontWeight: 500 }}>{config?.lpAmountUsdc || 0} USDC</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-muted)' }}>3. リバランス幅 (利益確定ライン)</span>
          <span style={{ fontWeight: 500 }}>±{(config?.rangeWidth || 0) * 100}%</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-muted)' }}>4. 価格下落の保護 (ヘッジ)</span>
          <span style={{ fontWeight: 500 }}>{(config?.hedgeRatio || 0) * 100}% (空売り)</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button style={{ background: 'transparent', border: '1px solid var(--border-panel)', borderRadius: '8px', padding: '6px 12px', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem' }} onClick={onOpenWizard}>
            <Compass size={14} /> 初回セットアップを開く
          </button>
        </div>
      </div>

      <div style={{ marginTop: 'auto', paddingTop: '24px', borderTop: '1px solid var(--border-panel)' }}>
        <button 
          className="primary-btn" 
          onClick={onToggleBot}
          style={{ 
            background: isBotActive 
              ? 'linear-gradient(135deg, rgba(255, 61, 0, 0.2), rgba(255, 61, 0, 0.1))' 
              : undefined,
            borderColor: isBotActive ? 'rgba(255, 61, 0, 0.5)' : undefined,
            color: isBotActive ? '#ffb3a7' : undefined,
            boxShadow: isBotActive ? '0 0 15px rgba(255, 61, 0, 0.2)' : undefined
          }}
        >
          {isBotActive ? (
            <><Square size={18} /> Stop Bot</>
          ) : (
            <><Play size={18} /> Resume Bot</>
          )}
        </button>
      </div>
    </div>
  );
};
