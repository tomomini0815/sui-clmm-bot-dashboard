import React, { useState } from 'react';
import { Settings, Play, Square, Edit3, Compass, Check, X, PlusCircle, Droplets } from 'lucide-react';

interface ConfigPanelProps {
  isBotActive: boolean;
  onToggleBot: () => void;
  onOpenSettings: () => void;
  onOpenWizard: () => void;
  config?: { lpAmountUsdc: number; rangeWidth: number; hedgeRatio: number };
  onUpdateCapital: (amount: number) => void;
  onOpenHelp: () => void;
}

export const ConfigPanel: React.FC<ConfigPanelProps> = ({
  isBotActive,
  onToggleBot,
  onOpenSettings,
  onOpenWizard,
  config,
  onUpdateCapital,
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
    <div className="glass-panel config-panel" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
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
        {/* 対象プール */}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          padding: '12px 14px', background: 'rgba(255, 255, 255, 0.03)',
          borderRadius: '10px', border: '1px solid var(--border-panel)'
        }}>
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>対象プール</span>
          <span style={{ fontWeight: 600, color: 'var(--accent)' }}>SUI / USDC</span>
        </div>

        {/* 運用資金（インライン編集） */}
        <div style={{
          padding: '12px 14px', background: isEditingCapital
            ? 'rgba(88, 166, 255, 0.08)'
            : 'rgba(255, 255, 255, 0.03)',
          borderRadius: '10px',
          border: isEditingCapital
            ? '1px solid rgba(88, 166, 255, 0.4)'
            : '1px solid var(--border-panel)',
          transition: 'all 0.2s'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-muted)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
              運用資金
            </span>
            {!isEditingCapital ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontWeight: 600 }}>
                  {config?.lpAmountUsdc || 0}
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginLeft: '4px' }}>USDC</span>
                </span>
                <button
                  onClick={handleEditCapital}
                  title="運用資金を変更"
                  style={{
                    background: 'rgba(88, 166, 255, 0.12)',
                    border: '1px solid rgba(88, 166, 255, 0.3)',
                    borderRadius: '6px',
                    padding: '4px 8px',
                    color: 'var(--accent)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: '0.78rem',
                    fontWeight: 500,
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(88, 166, 255, 0.25)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(88, 166, 255, 0.12)'; }}
                >
                  <PlusCircle size={12} /> 変更
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  type="number"
                  value={capitalInput}
                  onChange={(e) => setCapitalInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCapital(); if (e.key === 'Escape') handleCancelCapital(); }}
                  autoFocus
                  min="0.01"
                  step="0.01"
                  style={{
                    width: '90px',
                    background: 'rgba(22, 27, 34, 0.9)',
                    border: '1px solid rgba(88, 166, 255, 0.5)',
                    borderRadius: '6px',
                    padding: '4px 8px',
                    color: 'var(--text-main)',
                    fontSize: '0.9rem',
                    fontWeight: 600,
                    outline: 'none',
                    textAlign: 'right',
                  }}
                />
                <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>USDC</span>
                <button onClick={handleSaveCapital} title="保存" style={{
                  background: 'rgba(63, 185, 80, 0.15)', border: '1px solid rgba(63, 185, 80, 0.35)',
                  borderRadius: '6px', padding: '4px 6px', color: 'var(--success)',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', transition: 'all 0.2s',
                }}>
                  <Check size={14} />
                </button>
                <button onClick={handleCancelCapital} title="キャンセル" style={{
                  background: 'rgba(248, 81, 73, 0.1)', border: '1px solid rgba(248, 81, 73, 0.25)',
                  borderRadius: '6px', padding: '4px 6px', color: 'var(--danger)',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', transition: 'all 0.2s',
                }}>
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
          {isEditingCapital && (
            <div style={{ marginTop: '8px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              💡 Enter で保存 / Esc でキャンセル　※ボット再起動後に反映
            </div>
          )}
        </div>

        {/* リバランス幅 */}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          padding: '12px 14px', background: 'rgba(255, 255, 255, 0.03)',
          borderRadius: '10px', border: '1px solid var(--border-panel)'
        }}>
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>リバランス幅</span>
          <span style={{ fontWeight: 600, color: 'var(--success)' }}>±{(config?.rangeWidth || 0) * 100}%</span>
        </div>

        {/* ヘッジ比率 */}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          padding: '12px 14px', background: 'rgba(255, 255, 255, 0.03)',
          borderRadius: '10px', border: '1px solid var(--border-panel)'
        }}>
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>ヘッジ比率</span>
          <span style={{ fontWeight: 600, color: 'var(--accent)' }}>{(config?.hedgeRatio || 0) * 100}%</span>
        </div>

        <button
          style={{
            background: 'transparent', border: '1px dashed rgba(88, 166, 255, 0.25)',
            borderRadius: '10px', padding: '10px 14px', color: 'var(--text-muted)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: '8px', fontSize: '0.85rem', fontWeight: 500, transition: 'all 0.2s'
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

        <button
          style={{
            background: 'rgba(249, 115, 22, 0.1)', border: '1px solid rgba(249, 115, 22, 0.25)',
            borderRadius: '10px', padding: '10px 14px', color: '#f97316',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: '8px', fontSize: '0.85rem', fontWeight: 600, transition: 'all 0.2s'
          }}
          onClick={onOpenHelp}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(249, 115, 22, 0.15)';
            e.currentTarget.style.borderColor = 'rgba(249, 115, 22, 0.4)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(249, 115, 22, 0.1)';
            e.currentTarget.style.borderColor = 'rgba(249, 115, 22, 0.25)';
          }}
        >
          <Droplets size={14} /> Faucet / 資金追加
        </button>
      </div>

      {/* 操作ボタン */}
      <div style={{ marginTop: 'auto', paddingTop: '20px', borderTop: '1px solid var(--border-panel)' }}>
        <button
          className="primary-btn"
          onClick={onToggleBot}
          style={{
            background: isBotActive ? 'var(--danger)' : 'var(--success)',
            boxShadow: isBotActive ? '0 2px 8px rgba(248, 81, 73, 0.3)' : '0 2px 8px rgba(63, 185, 80, 0.3)'
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
