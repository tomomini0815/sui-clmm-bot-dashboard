import React, { useState } from 'react';
import { Settings, Play, Square, Edit3, Compass, Check, X, PlusCircle, Droplets } from 'lucide-react';

interface ConfigPanelProps {
  isBotActive: boolean;
  onToggleBot: () => void;
  onOpenSettings: () => void;
  onOpenWizard: () => void;
  config?: { lpAmountUsdc: number; rangeWidth: number; hedgeRatio: number; configMode?: 'auto' | 'manual'; strategyMode?: 'balanced' | 'range_order' };
  onUpdateCapital: (amount: number) => void;
  onUpdateStrategyMode: (mode: 'balanced' | 'range_order') => void;
  onOpenHelp: () => void;
}

export const ConfigPanel: React.FC<ConfigPanelProps> = ({
  isBotActive,
  onToggleBot,
  onOpenSettings,
  onOpenWizard,
  config,
  onUpdateCapital,
  onUpdateStrategyMode,
  onOpenHelp,
}) => {
  const [isEditingCapital, setIsEditingCapital] = useState(false);
  const [capitalInput, setCapitalInput] = useState('');

  const handleEditCapital = () => {
    setCapitalInput(String(config?.lpAmountUsdc || 0));
    setIsEditingCapital(true);
  };

  const handleSaveCapital = () => {
    const val = parseFloat(capitalInput);
    if (!isNaN(val) && val > 0) {
      onUpdateCapital(val);
      setIsEditingCapital(false);
    }
  };

  const handleCancelCapital = () => {
    setIsEditingCapital(false);
    setCapitalInput('');
  };

  return (
    <div className="glass-panel config-panel" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* ヘッダー */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingBottom: '16px', borderBottom: '1px solid var(--border-panel)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            background: 'rgba(88, 166, 255, 0.15)', padding: '8px', borderRadius: '8px',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Settings size={20} color="var(--accent)" />
          </div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Bot設定</h2>
        </div>
        <button
          onClick={onOpenSettings}
          style={{
            background: 'rgba(88, 166, 255, 0.1)', border: '1px solid rgba(88, 166, 255, 0.25)',
            borderRadius: '8px', padding: '6px 12px', color: 'var(--text-main)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
            fontSize: '0.85rem', fontWeight: 500, transition: 'all 0.2s'
          }}
        >
          <Edit3 size={14} /> 編集
        </button>
      </div>

      {/* 戦略選択（タグ形式） */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          運用戦略エンジン
        </span>
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
            バランス (25/25/50)
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
            指値レンジ (B)
          </button>
        </div>
      </div>

      {/* モード表示バッジ */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '4px 10px', borderRadius: '20px', fontSize: '0.7rem', fontWeight: 600,
          background: config?.configMode === 'manual' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(88, 166, 255, 0.15)',
          color: config?.configMode === 'manual' ? 'var(--text-muted)' : 'var(--accent)',
          border: config?.configMode === 'manual' ? '1px solid rgba(255, 255, 255, 0.1)' : '1px solid rgba(88, 166, 255, 0.3)'
        }}>
          {config?.configMode === 'manual' ? 'MOD: カスタム' : 'MOD: お任せ設定'}
        </div>
      </div>

      {/* 設定項目 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {/* 対象プール */}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          padding: '10px 14px', background: 'rgba(255, 255, 255, 0.02)',
          borderRadius: '10px', border: '1px solid var(--border-panel)'
        }}>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>対象プール</span>
          <span style={{ fontWeight: 600, color: 'var(--accent)', fontSize: '0.85rem' }}>SUI / USDC</span>
        </div>

        {/* 運用資金（インライン編集） */}
        <div style={{
          padding: '10px 14px', background: isEditingCapital
            ? 'rgba(88, 166, 255, 0.06)'
            : 'rgba(255, 255, 255, 0.02)',
          borderRadius: '10px',
          border: isEditingCapital
            ? '1px solid rgba(88, 166, 255, 0.4)'
            : '1px solid var(--border-panel)',
          transition: 'all 0.2s'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
              運用資金
            </span>
            {!isEditingCapital ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                  {config?.lpAmountUsdc || 0} USDC
                </span>
                <button
                  onClick={handleEditCapital}
                  style={{
                    background: 'rgba(88, 166, 255, 0.1)', border: '1px solid rgba(88, 166, 255, 0.2)',
                    borderRadius: '4px', padding: '2px 6px', color: 'var(--accent)',
                    cursor: 'pointer', fontSize: '0.75rem'
                  }}
                >
                  変更
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <input
                  type="number"
                  value={capitalInput}
                  onChange={(e) => setCapitalInput(e.target.value)}
                  style={{ width: '60px', padding: '2px', fontSize: '0.8rem' }}
                  autoFocus
                />
                <button onClick={handleSaveCapital} style={{ color: 'var(--success)' }}><Check size={14}/></button>
                <button onClick={handleCancelCapital} style={{ color: 'var(--danger)' }}><X size={14}/></button>
              </div>
            )}
          </div>
        </div>

        {/* リバランス幅（指値モード時は非表示にするなどの調整も可能だが、一旦表示） */}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          padding: '10px 14px', background: 'rgba(255, 255, 255, 0.02)',
          borderRadius: '10px', border: '1px solid var(--border-panel)'
        }}>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {config?.strategyMode === 'range_order' ? '指値オフセット' : 'リバランス幅'}
          </span>
          <span style={{ fontWeight: 600, color: 'var(--success)', fontSize: '0.85rem' }}>
            ±{(config?.rangeWidth || 0) * 100}%
          </span>
        </div>

        <button
          style={{
            background: 'transparent', border: '1px dashed rgba(88, 166, 255, 0.2)',
            borderRadius: '10px', padding: '10px', color: 'var(--text-muted)',
            cursor: 'pointer', fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
          }}
          onClick={onOpenWizard}
        >
          <Compass size={14} /> 初回セットアップ
        </button>

        <button
          style={{
            background: 'rgba(249, 115, 22, 0.08)', border: '1px solid rgba(249, 115, 22, 0.2)',
            borderRadius: '10px', padding: '10px', color: '#f97316',
            cursor: 'pointer', fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
          }}
          onClick={onOpenHelp}
        >
          <Droplets size={14} /> Faucet / 資金追加
        </button>
      </div>

      {/* 操作ボタン */}
      <div style={{ marginTop: 'auto', paddingTop: '16px', borderTop: '1px solid var(--border-panel)' }}>
        <button
          className="primary-btn"
          onClick={onToggleBot}
          style={{
            background: isBotActive ? 'var(--danger)' : 'var(--success)',
            padding: '12px', fontSize: '0.9rem'
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



