import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, Save, X, Zap, Settings as SettingsIcon, Info, Copy, Check } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  apiUrl: string;
  sessionId?: string;
  currentConfig?: { 
    rangeWidth: number; 
    hedgeRatio: number; 
    configMode?: 'auto' | 'manual';
    lpAmountUsdc: number;
    totalOperationalCapitalUsdc: number;
  };
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, apiUrl, sessionId, currentConfig }) => {
  const [showTelegramToken, setShowTelegramToken] = useState(false);
  
  const [configMode, setConfigMode] = useState<'auto' | 'manual'>('auto');
  const [rangeWidth, setRangeWidth] = useState('5.0');
  const [hedgeRatio, setHedgeRatio] = useState('50');
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [showRecoveryKey, setShowRecoveryKey] = useState(false);
  const [recoveryData, setRecoveryData] = useState<{key?: string, mnemonic?: string, address?: string} | null>(null);
  const [isLoadingKey, setIsLoadingKey] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [totalCapital, setTotalCapital] = useState('200');

  // 初期値の同期
  useEffect(() => {
    if (isOpen && currentConfig) {
      setConfigMode(currentConfig.configMode || 'auto');
      setRangeWidth((currentConfig.rangeWidth * 100).toFixed(1));
      setHedgeRatio((currentConfig.hedgeRatio * 100).toFixed(0));
      setTotalCapital((currentConfig.totalOperationalCapitalUsdc ?? 200).toString());
    }
  }, [isOpen, currentConfig]);

  // モード変更時の同期
  useEffect(() => {
    if (configMode === 'auto') {
      setRangeWidth('5.0');
      setHedgeRatio('50');
    }
  }, [configMode]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const response = await fetch(`${apiUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          rangeWidth,
          hedgeRatio,
          lpAmountUsdc: currentConfig?.lpAmountUsdc || 0.10,
          totalOperationalCapitalUsdc: parseFloat(totalCapital),
          telegramToken,
          telegramChatId,
          configMode
        })
      });
      const data = await response.json();
      if (data.success) {
        console.log('Settings Saved!');
      }
    } catch (err) {
      console.error('Failed to save settings to backend:', err);
    } finally {
      setIsSaving(false);
      onClose();
    }
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleFetchKey = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    
    if (recoveryData) {
      setShowRecoveryKey(!showRecoveryKey);
      return;
    }
    
    if (!backupPassword) {
      setAuthError('パスワードを入力してください。');
      return;
    }
    
    setIsLoadingKey(true);
    setAuthError(null);
    try {
      const response = await fetch(`${apiUrl}/api/export-key?sessionId=${sessionId}&password=${encodeURIComponent(backupPassword)}`);
      const data = await response.json();
      if (data.success) {
        setRecoveryData({
          key: data.secretKey,
          mnemonic: data.mnemonic,
          address: data.address
        });
        setShowRecoveryKey(true);
      } else {
        setAuthError(data.error || '認証に失敗しました。');
      }
    } catch (err) {
      console.error('Failed to fetch recovery key:', err);
      setAuthError('通信エラーが発生しました。');
    } finally {
      setIsLoadingKey(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="glass-panel modal-content" style={{ width: '450px', padding: '28px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '28px' }}>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <SettingsIcon size={24} color="var(--accent)" />
            Bot Configuration
          </h2>
          <button style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px' }} onClick={onClose}>
            <X size={24} />
          </button>
        </div>

        {/* モード選択タブ */}
        <div style={{ 
          display: 'flex', 
          background: 'rgba(255,255,255,0.05)', 
          borderRadius: '12px', 
          padding: '4px', 
          marginBottom: '24px',
          border: '1px solid var(--border-panel)'
        }}>
          <button 
            onClick={() => setConfigMode('auto')}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              padding: '10px',
              borderRadius: '8px',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.9rem',
              fontWeight: 600,
              transition: 'all 0.2s',
              background: configMode === 'auto' ? 'var(--accent)' : 'transparent',
              color: configMode === 'auto' ? '#fff' : 'var(--text-muted)',
              boxShadow: configMode === 'auto' ? '0 4px 12px rgba(88, 166, 255, 0.3)' : 'none'
            }}
          >
            <Zap size={16} fill={configMode === 'auto' ? 'currentColor' : 'none'} />
            お任せモード
          </button>
          <button 
            onClick={() => setConfigMode('manual')}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              padding: '10px',
              borderRadius: '8px',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.9rem',
              fontWeight: 600,
              transition: 'all 0.2s',
              background: configMode === 'manual' ? 'var(--border-panel)' : 'transparent',
              color: configMode === 'manual' ? 'var(--text-main)' : 'var(--text-muted)',
            }}
          >
            <SettingsIcon size={16} />
            カスタム設定
          </button>
        </div>

        {configMode === 'auto' && (
          <div style={{ 
            padding: '14px', 
            background: 'rgba(88, 166, 255, 0.08)', 
            borderRadius: '12px', 
            border: '1px solid rgba(88, 166, 255, 0.2)',
            marginBottom: '24px',
            display: 'flex',
            gap: '12px'
          }}>
            <Info size={18} color="var(--accent)" style={{ flexShrink: 0, marginTop: '2px' }} />
            <p style={{ fontSize: '0.85rem', color: 'var(--text-main)', lineHeight: 1.5 }}>
              推奨値（リバランス幅 5% / ヘッジ 50%）が自動適用されます。ボラティリティに最適化された最も安定した設定です。
            </p>
          </div>
        )}

        <div className="form-group" style={{ marginBottom: '24px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Zap size={14} color="var(--neon-cetus)" /> 総運用資金 (Total USDC)
          </label>
          <div style={{ position: 'relative' }}>
            <input 
              type="number" 
              className="input-glass" 
              value={totalCapital} 
              onChange={(e) => setTotalCapital(e.target.value)} 
              placeholder="e.g. 200"
              style={{ fontSize: '1.2rem', fontWeight: 'bold', color: 'var(--accent)', paddingRight: '60px' }}
            />
            <span style={{ 
              position: 'absolute', 
              right: '16px', 
              top: '50%', 
              transform: 'translateY(-50%)', 
              fontSize: '0.9rem', 
              color: 'var(--text-muted)',
              fontWeight: 'bold'
            }}>USDC</span>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '8px' }}>
             入力額の 50% を LP、残りの 50% をヘッジ担保として運用します。
          </p>
        </div>

        <div style={{ display: 'flex', gap: '16px' }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label style={{ opacity: configMode === 'auto' ? 0.6 : 1 }}>Rebalance Range (%)</label>
            <input 
              type="number" 
              className="input-glass" 
              value={rangeWidth} 
              onChange={(e) => setRangeWidth(e.target.value)} 
              step="0.1" 
              disabled={configMode === 'auto'}
              style={{ 
                opacity: configMode === 'auto' ? 0.6 : 1,
                cursor: configMode === 'auto' ? 'not-allowed' : 'text'
              }}
            />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label style={{ opacity: configMode === 'auto' ? 0.6 : 1 }}>Hedge Ratio (%)</label>
            <input 
              type="number" 
              className="input-glass" 
              value={hedgeRatio} 
              onChange={(e) => setHedgeRatio(e.target.value)} 
              step="10" 
              disabled={configMode === 'auto'}
              style={{ 
                opacity: configMode === 'auto' ? 0.6 : 1,
                cursor: configMode === 'auto' ? 'not-allowed' : 'text'
              }}
            />
          </div>
        </div>

        <div className="form-group">
          <label>Telegram Bot Token</label>
          <div className="input-wrapper">
            <input 
              type={showTelegramToken ? "text" : "password"} 
              className="input-glass" 
              placeholder="e.g. 123456:ABC-DEF1234ghIkl..." 
              value={telegramToken}
              onChange={(e) => setTelegramToken(e.target.value)}
            />
            <div className="input-icon-right" onClick={() => setShowTelegramToken(!showTelegramToken)}>
              {showTelegramToken ? <EyeOff size={18} /> : <Eye size={18} />}
            </div>
          </div>
        </div>

        <div className="form-group">
          <label>Telegram Chat ID</label>
          <input type="text" className="input-glass" placeholder="Your Chat ID" value={telegramChatId} onChange={(e) => setTelegramChatId(e.target.value)} />
        </div>

        <div style={{ 
          marginTop: '24px', 
          padding: '16px', 
          background: 'rgba(255, 122, 127, 0.05)', 
          borderRadius: '12px', 
          border: '1px solid rgba(255, 122, 127, 0.2)' 
        }}>
          <label style={{ color: '#ff7a7f', fontSize: '0.8rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
            <Zap size={14} /> 資産の安全なバックアップ
          </label>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
            「専用運用ウォレット」の**リカバリーフレーズ（シードフレーズ）**を表示します。この12単語を安全な場所にメモしておけば、ボットサーバーが停止しても、他のSuiウォレット（Suiet/Sui Wallet等）でいつでも資金を回収できます。
          </p>
          
          <div style={{ position: 'relative' }}>
            {recoveryData ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* 1. Address Section */}
                <div style={{ 
                  background: 'rgba(0,0,0,0.3)', 
                  padding: '12px 16px', 
                  borderRadius: '12px', 
                  border: '1px solid rgba(255,255,255,0.1)',
                }}>
                  <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Wallet Address</label>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <code style={{ fontSize: '0.8rem', color: 'var(--accent)', wordBreak: 'break-all' }}>{recoveryData.address}</code>
                    <button 
                      onClick={() => handleCopy(recoveryData.address || '', 'addr')}
                      style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px' }}
                    >
                      {copiedId === 'addr' ? <Check size={16} color="var(--neon-cetus)" /> : <Copy size={16} />}
                    </button>
                  </div>
                </div>

                {/* 12-Word Mnemonic Section */}
                {recoveryData.mnemonic && (
                  <div>
                    <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block', marginBottom: '8px' }}>Recovery Phrase (12 Words)</label>
                    <div 
                      style={{ 
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, 1fr)',
                        gap: '8px',
                        background: 'rgba(0,0,0,0.3)', 
                        padding: '16px', 
                        borderRadius: '12px', 
                        border: '1px solid rgba(255,255,255,0.1)',
                        fontSize: '0.8rem',
                        color: showRecoveryKey ? 'var(--text-main)' : 'transparent',
                        filter: showRecoveryKey ? 'none' : 'blur(8px)',
                        transition: 'all 0.3s',
                        userSelect: showRecoveryKey ? 'text' : 'none',
                        position: 'relative'
                      }}
                    >
                      {recoveryData.mnemonic.split(' ').map((word, i) => (
                        <div key={i} style={{ 
                          background: 'rgba(255,255,255,0.05)', 
                          padding: '6px 8px', 
                          borderRadius: '6px',
                          display: 'flex',
                          gap: '6px'
                        }}>
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{i + 1}</span>
                          <span style={{ fontWeight: 600 }}>{word}</span>
                        </div>
                      ))}
                      {!showRecoveryKey && (
                        <div style={{ 
                          position: 'absolute', 
                          top: 0, left: 0, right: 0, bottom: 0, 
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          zIndex: 5
                        }}>
                          <button 
                            onClick={handleFetchKey}
                            style={{ 
                              background: 'var(--border-panel)', 
                              border: '1px solid rgba(255,255,255,0.1)', 
                              color: 'white', 
                              padding: '8px 16px', 
                              borderRadius: '20px', 
                              fontSize: '0.75rem',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px'
                            }}
                          >
                            <Eye size={14} /> 表示する
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 秘密鍵 Section */}
                <div style={{ 
                  background: 'rgba(0,0,0,0.3)', 
                  padding: '12px 16px', 
                  borderRadius: '12px', 
                  border: '1px solid rgba(255,255,255,0.1)',
                }}>
                  <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Secret Key (suiprivkey)</label>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ 
                      fontSize: '0.75rem', 
                      wordBreak: 'break-all', 
                      fontFamily: 'monospace',
                      color: showRecoveryKey ? '#ff7a7f' : 'transparent',
                      filter: showRecoveryKey ? 'none' : 'blur(8px)',
                      flex: 1
                    }}>
                      {recoveryData.key}
                    </div>
                    {showRecoveryKey && (
                      <button 
                        onClick={() => handleCopy(recoveryData.key || '', 'key')}
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px', marginLeft: '8px' }}
                      >
                        {copiedId === 'key' ? <Check size={16} color="var(--neon-cetus)" /> : <Copy size={16} />}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <form onSubmit={handleFetchKey} style={{ textAlign: 'center', padding: '10px 0' }}>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                  情報の表示には管理パスワードが必要です。
                </p>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                  <input 
                    type="password"
                    className="input-glass"
                    placeholder="Password"
                    value={backupPassword}
                    onChange={(e) => setBackupPassword(e.target.value)}
                    style={{ flex: 1, fontSize: '0.8rem' }}
                  />
                  <button 
                    type="submit"
                    className="primary-btn" 
                    disabled={isLoadingKey}
                    style={{ padding: '0 20px', height: '40px', fontSize: '0.85rem' }}
                  >
                    {isLoadingKey ? "..." : "解除"}
                  </button>
                </div>
                {authError && (
                  <p style={{ fontSize: '0.7rem', color: '#ff7a7f', marginTop: '4px' }}>
                    {authError}
                  </p>
                )}
              </form>
            )}
            
            {recoveryData && (
              <div 
                style={{ 
                  position: 'absolute', 
                  right: '12px', 
                  top: '-40px',
                  cursor: 'pointer',
                  color: 'var(--text-muted)',
                  padding: '10px'
                }} 
                onClick={() => setShowRecoveryKey(!showRecoveryKey)}
              >
                {showRecoveryKey ? <EyeOff size={18} /> : <Eye size={18} />}
              </div>
            )}
          </div>
          
          <p style={{ fontSize: '0.65rem', color: '#ff7a7f', marginTop: '10px', textAlign: 'center' }}>
            ※このフレーズを知っている人は誰でも資金を盗むことができます。安全に保管してください。
          </p>
        </div>

        <div style={{ marginTop: '32px' }}>
          <button className="primary-btn" onClick={handleSave} disabled={isSaving} style={{ width: '100%', height: '48px', fontSize: '1rem' }}>
            <Save size={18} /> {isSaving ? 'Saving...' : '設定を保存して接続'}
          </button>
        </div>
      </div>
    </div>
  );
};
