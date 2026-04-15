import React from 'react';
import { Settings, Play, Square, Edit3, Compass } from 'lucide-react';

interface ConfigPanelProps {
  isBotActive: boolean;
  onToggleBot: () => void;
  onOpenSettings: () => void;
  onOpenWizard: () => void;
  config?: { lpAmountUsdc: number, rangeWidth: number, hedgeRatio: number };
}

export const ConfigPanel: React.FC<ConfigPanelProps> = ({ 
  isBotActive, 
  onToggleBot, 
  onOpenSettings, 
  onOpenWizard, 
  config 
}) => {
  return (
    <div className="glass-panel" style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      gap: '24px',
    }}>
      {/* ヘッダー */}
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between',
        paddingBottom: '16px',
        borderBottom: '1px solid var(--border-panel)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            background: 'rgba(88, 166, 255, 0.15)',
            padding: '8px',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <Settings size={20} color="var(--accent)" />
          </div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Bot設定</h2>
        </div>
        <button 
          onClick={onOpenSettings} 
          style={{ 
            background: 'rgba(88, 166, 255, 0.1)', 
            border: '1px solid rgba(88, 166, 255, 0.25)', 
            borderRadius: '8px',
            padding: '6px 12px', 
            color: 'var(--text-main)', 
            cursor: 'pointer', 
            display: 'flex', 
            alignItems: 'center', 
            gap: '6px', 
            fontSize: '0.85rem',
            fontWeight: 500,
            transition: 'all 0.2s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(88, 166, 255, 0.2)';
            e.currentTarget.style.borderColor = 'rgba(88, 166, 255, 0.4)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(88, 166, 255, 0.1)';
            e.currentTarget.style.borderColor = 'rgba(88, 166, 255, 0.25)';
          }}
        >
          <Edit3 size={14} /> 編集
        </button>
      </div>

      {/* 設定項目 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between',
          padding: '12px 14px',
          background: 'rgba(255, 255, 255, 0.03)',
          borderRadius: '10px',
          border: '1px solid var(--border-panel)'
        }}>
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>対象プール</span>
          <span style={{ fontWeight: 600, color: 'var(--accent)' }}>SUI / USDC</span>
        </div>
        
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between',
          padding: '12px 14px',
          background: 'rgba(255, 255, 255, 0.03)',
          borderRadius: '10px',
          border: '1px solid var(--border-panel)'
        }}>
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>運用金額</span>
          <span style={{ fontWeight: 600 }}>{config?.lpAmountUsdc || 0} <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>USDC</span></span>
        </div>
        
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between',
          padding: '12px 14px',
          background: 'rgba(255, 255, 255, 0.03)',
          borderRadius: '10px',
          border: '1px solid var(--border-panel)'
        }}>
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>リバランス幅</span>
          <span style={{ fontWeight: 600, color: 'var(--success)' }}>±{(config?.rangeWidth || 0) * 100}%</span>
        </div>
        
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between',
          padding: '12px 14px',
          background: 'rgba(255, 255, 255, 0.03)',
          borderRadius: '10px',
          border: '1px solid var(--border-panel)'
        }}>
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>ヘッジ比率</span>
          <span style={{ fontWeight: 600, color: 'var(--accent)' }}>{(config?.hedgeRatio || 0) * 100}%</span>
        </div>
        
        <button 
          style={{ 
            background: 'transparent', 
            border: '1px dashed rgba(88, 166, 255, 0.25)', 
            borderRadius: '10px', 
            padding: '10px 14px', 
            color: 'var(--text-muted)', 
            cursor: 'pointer', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            gap: '8px', 
            fontSize: '0.85rem',
            fontWeight: 500,
            transition: 'all 0.2s'
          }} 
          onClick={onOpenWizard}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(88, 166, 255, 0.08)';
            e.currentTarget.style.borderColor = 'rgba(88, 166, 255, 0.4)';
            e.currentTarget.style.color = 'var(--text-main)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = 'rgba(88, 166, 255, 0.25)';
            e.currentTarget.style.color = 'var(--text-muted)';
          }}
        >
          <Compass size={14} /> 初回セットアップを開く
        </button>
      </div>

      {/* 操作ボタン */}
      <div style={{ 
        marginTop: 'auto', 
        paddingTop: '20px', 
        borderTop: '1px solid var(--border-panel)' 
      }}>
        <button 
          className="primary-btn" 
          onClick={onToggleBot}
          style={{ 
            background: isBotActive 
              ? 'var(--danger)' 
              : 'var(--success)',
            boxShadow: isBotActive 
              ? '0 2px 8px rgba(248, 81, 73, 0.3)' 
              : '0 2px 8px rgba(63, 185, 80, 0.3)'
          }}
        >
          {isBotActive ? (
            <><Square size={16} fill="currentColor" /> ボットを停止</>
          ) : (
            <><Play size={16} fill="currentColor" /> ボットを起動</>
          )}
        </button>
      </div>
    </div>
  );
};
