import React, { useState, useEffect } from 'react';
import { AlertTriangle, Eye, EyeOff, Save, X, Zap, Settings as SettingsIcon, Info, Copy, Check, Wallet, Play, Square, RotateCw } from 'lucide-react';
import { getSufficientStatus } from './BotWalletCard';

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
    backupPassword?: string;
    hedgeEnabled?: boolean;
  };
  walletInfo?: {
    botAddress: string;
    suiBalance: number;
    usdcBalance: number;
    bot1LpValue: number;
    bot2LpValue: number;
    userWalletBalanceSui: number;
    userWalletBalanceUsdc: number;
    connectedAddress?: string;
    currentPrice: number;
    isBotActive: boolean;
    isUnbalanced: boolean;
  };
  onToggleBot?: () => void;
  onRebuild?: () => void;
  isActionPending?: boolean;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  apiUrl,
  sessionId,
  currentConfig,
  walletInfo,
  onToggleBot,
  onRebuild,
  isActionPending = false
}) => {
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
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [totalCapital, setTotalCapital] = useState('200');
  const [lpAmount, setLpAmount] = useState('1.0');

  // モーダルを開いた時だけ初期値をセットするように変更
  useEffect(() => {
    if (isOpen && currentConfig) {
      setConfigMode(currentConfig.configMode || 'auto');
      setRangeWidth((currentConfig.rangeWidth * 100).toFixed(2));
      setHedgeRatio((currentConfig.hedgeRatio * 100).toFixed(0));
      setTotalCapital((currentConfig.totalOperationalCapitalUsdc ?? 200).toString());
      setLpAmount((currentConfig.lpAmountUsdc ?? 1.0).toString());
      setBackupPassword(currentConfig.backupPassword || '');
    }
  }, [isOpen]); // currentConfig を依存関係から外す

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
          lpAmountUsdc: parseFloat(lpAmount),
          totalOperationalCapitalUsdc: parseFloat(totalCapital),
          telegramToken,
          telegramChatId,
          configMode,
          backupPassword: backupPassword,
          hedgeEnabled: false,
        })
      });
      const data = await response.json();
      if (data.success) {
        alert('✅ 設定を保存しました。現在のポジションをリセットして再構築を開始します。');
        onClose();
      } else {
        alert('❌ 保存に失敗しました: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      console.error('Failed to save settings to backend:', err);
      alert('❌ サーバー通信エラーが発生しました。');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCopy = (text: string, id: string) => {
    if (!text) return;
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
    
    if (!authPassword) {
      setAuthError('パスワードを入力してください。');
      return;
    }
    
    setIsLoadingKey(true);
    setAuthError(null);
    try {
      const response = await fetch(`${apiUrl}/api/export-key?sessionId=${sessionId}&password=${encodeURIComponent(authPassword)}`);
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
      <div className="glass-panel modal-content" style={{ maxWidth: '720px', padding: '32px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '12px', letterSpacing: '-0.02em' }}>
            <SettingsIcon size={26} color="var(--accent)" />
            Bot Configuration
          </h2>
          <button 
            style={{ 
              background: 'rgba(255,255,255,0.05)', 
              border: 'none', 
              color: 'var(--text-muted)', 
              cursor: 'pointer', 
              padding: '8px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s'
            }} 
            onClick={onClose}
            className="hover-bg-white-10"
          >
            <X size={20} />
          </button>
        </div>

        {walletInfo && (
          <div style={{
            background: 'rgba(255,255,255,0.025)',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '16px',
            padding: '18px',
            marginBottom: '28px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            {(() => {
              const botStatus = getSufficientStatus(walletInfo.suiBalance, walletInfo.usdcBalance);
              const userStatus = getSufficientStatus(walletInfo.userWalletBalanceSui, walletInfo.userWalletBalanceUsdc);
              const walletUsdValue = (walletInfo.suiBalance * walletInfo.currentPrice) + walletInfo.usdcBalance;
              const totalAllocated = walletInfo.bot1LpValue + walletInfo.bot2LpValue + walletUsdValue;
              const pctBot1 = totalAllocated > 0 ? (walletInfo.bot1LpValue / totalAllocated) * 100 : 0;
              const pctBot2 = totalAllocated > 0 ? (walletInfo.bot2LpValue / totalAllocated) * 100 : 0;
              const pctUnused = totalAllocated > 0 ? (walletUsdValue / totalAllocated) * 100 : 0;
              const fixedMaster = walletInfo.botAddress.toLowerCase() === '0xc17e3ef45cfb8ff6f0d5e55669b148fc27e615e2bde27109ccf3e952d1215559'.toLowerCase();

              return (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                      <div style={{ background: 'rgba(88,166,255,0.15)', borderRadius: '10px', padding: '8px', display: 'flex' }}>
                        <Wallet size={18} color="var(--accent)" />
                      </div>
                      <div>
                        <h3 style={{ fontSize: '1rem', margin: 0, fontWeight: 800 }}>運用ウォレット管理</h3>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
                          <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: botStatus.color, boxShadow: `0 0 6px ${botStatus.color}` }} />
                          <span style={{ fontSize: '0.76rem', color: botStatus.color, fontWeight: 700 }}>{botStatus.text}</span>
                          {fixedMaster && (
                            <span style={{ fontSize: '0.65rem', color: 'var(--accent)', fontWeight: 800, background: 'rgba(88,166,255,0.1)', padding: '2px 6px', borderRadius: '5px' }}>MASTER</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {onRebuild && (
                        <button
                          onClick={onRebuild}
                          disabled={isActionPending}
                          style={{
                            background: 'rgba(255,255,255,0.05)',
                            border: '1px solid rgba(255,255,255,0.1)',
                            color: 'var(--text-main)',
                            borderRadius: '10px',
                            padding: '9px 12px',
                            cursor: isActionPending ? 'not-allowed' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '7px',
                            fontWeight: 700,
                            fontSize: '0.82rem'
                          }}
                        >
                          <RotateCw size={15} style={{ animation: isActionPending ? 'spin 1s linear infinite' : 'none' }} />
                          資金の均等化
                        </button>
                      )}
                      {onToggleBot && (
                        <button
                          onClick={onToggleBot}
                          disabled={isActionPending}
                          style={{
                            background: walletInfo.isBotActive ? 'rgba(248,81,73,0.14)' : 'var(--accent)',
                            border: walletInfo.isBotActive ? '1px solid rgba(248,81,73,0.3)' : 'none',
                            color: walletInfo.isBotActive ? 'var(--danger)' : '#fff',
                            borderRadius: '10px',
                            padding: '9px 12px',
                            cursor: isActionPending ? 'not-allowed' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '7px',
                            fontWeight: 800,
                            fontSize: '0.82rem'
                          }}
                        >
                          {walletInfo.isBotActive ? <Square size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
                          {walletInfo.isBotActive ? 'Botを停止' : 'Botを開始'}
                        </button>
                      )}
                    </div>
                  </div>

                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    background: 'rgba(0,0,0,0.2)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '10px',
                    padding: '10px 12px'
                  }}>
                    <code style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                      {walletInfo.botAddress || 'ウォレット未生成'}
                    </code>
                    <button
                      onClick={() => handleCopy(walletInfo.botAddress, 'bot-wallet')}
                      disabled={!walletInfo.botAddress}
                      aria-label="運用ウォレットアドレスをコピー"
                      style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: walletInfo.botAddress ? 'pointer' : 'not-allowed', display: 'flex' }}
                    >
                      {copiedId === 'bot-wallet' ? <Check size={16} color="#2ed573" /> : <Copy size={16} />}
                    </button>
                  </div>

                  {!botStatus.sufficient && (
                    <div style={{
                      display: 'flex',
                      gap: '10px',
                      padding: '12px',
                      borderRadius: '12px',
                      background: 'rgba(255,71,87,0.08)',
                      border: '1px solid rgba(255,71,87,0.18)',
                      color: '#ff7a7f',
                      fontSize: '0.78rem',
                      lineHeight: 1.5
                    }}>
                      <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                      <span>ボット開始には運用ウォレットへガス代用SUIと運用資金用USDCを送金してください。</span>
                    </div>
                  )}

                  {walletInfo.isUnbalanced && (
                    <div style={{
                      display: 'flex',
                      gap: '10px',
                      padding: '12px',
                      borderRadius: '12px',
                      background: 'rgba(255,159,67,0.1)',
                      border: '1px solid rgba(255,159,67,0.25)',
                      color: '#ffb86b',
                      fontSize: '0.78rem',
                      lineHeight: 1.5
                    }}>
                      <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                      <span>資金バランスに偏りがあります。必要に応じて資金の均等化を実行してください。</span>
                    </div>
                  )}

                  {walletInfo.connectedAddress && (
                    <div style={{
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.05)',
                      borderRadius: '12px',
                      padding: '12px'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--accent)', fontWeight: 700 }}>連携中ウォレット</span>
                        <span style={{ fontSize: '0.7rem', color: userStatus.color, fontWeight: 800 }}>{userStatus.text}</span>
                      </div>
                      <code style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.72rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '10px' }}>
                        {walletInfo.connectedAddress}
                      </code>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px' }}>
                        <div style={{ background: 'rgba(0,0,0,0.16)', borderRadius: '8px', padding: '8px' }}>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>SUI 残高</div>
                          <strong style={{ color: walletInfo.userWalletBalanceSui < 0.2 ? '#ff4757' : 'white' }}>{walletInfo.userWalletBalanceSui.toFixed(2)} SUI</strong>
                        </div>
                        <div style={{ background: 'rgba(0,0,0,0.16)', borderRadius: '8px', padding: '8px' }}>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>USDC 残高</div>
                          <strong style={{ color: walletInfo.userWalletBalanceUsdc < 0.1 ? '#ff4757' : 'white' }}>${walletInfo.userWalletBalanceUsdc.toFixed(2)}</strong>
                        </div>
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px' }}>
                    <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '12px' }}>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '4px' }}>SUI 残高</div>
                      <strong style={{ color: walletInfo.suiBalance < 0.2 ? '#ff4757' : 'white' }}>{walletInfo.suiBalance.toFixed(2)} SUI</strong>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '12px' }}>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '4px' }}>USDC 残高</div>
                      <strong style={{ color: walletInfo.usdcBalance < 0.1 ? '#ff4757' : 'white' }}>${walletInfo.usdcBalance.toFixed(2)}</strong>
                    </div>
                    <div style={{ background: 'rgba(88,166,255,0.06)', border: '1px solid rgba(88,166,255,0.14)', borderRadius: '12px', padding: '12px' }}>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '4px' }}>総ドル価値</div>
                      <strong style={{ color: 'var(--accent)' }}>${walletUsdValue.toFixed(2)}</strong>
                    </div>
                  </div>

                  <div style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '14px' }}>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontWeight: 700, marginBottom: '12px' }}>
                      ボット別 資金配分
                    </div>
                    <div style={{ height: '8px', background: 'rgba(255,255,255,0.08)', borderRadius: '4px', overflow: 'hidden', display: 'flex', marginBottom: '12px' }}>
                      {walletInfo.bot1LpValue > 0 && <div style={{ width: `${pctBot1}%`, background: '#58a6ff' }} />}
                      {walletInfo.bot2LpValue > 0 && <div style={{ width: `${pctBot2}%`, background: '#2ed573' }} />}
                      {walletUsdValue > 0 && <div style={{ width: `${pctUnused}%`, background: 'rgba(255,255,255,0.28)' }} />}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '0.78rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}><span style={{ color: 'var(--text-main)' }}>Bot1 (SUI/USDC LP)</span><strong>${walletInfo.bot1LpValue.toFixed(2)} ({pctBot1.toFixed(0)}%)</strong></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}><span style={{ color: 'var(--text-main)' }}>Bot2 (DEEP/SUI LP)</span><strong>${walletInfo.bot2LpValue.toFixed(2)} ({pctBot2.toFixed(0)}%)</strong></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}><span style={{ color: 'var(--text-muted)' }}>未使用 (ウォレット残高全体)</span><strong style={{ color: 'var(--text-muted)' }}>${walletUsdValue.toFixed(2)} ({pctUnused.toFixed(0)}%)</strong></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '8px', marginTop: '2px' }}><span style={{ fontWeight: 800 }}>合計運用資本</span><strong style={{ color: 'var(--accent)' }}>${totalAllocated.toFixed(2)}</strong></div>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {/* モード選択タブ - プレミアム化 */}
        <div style={{ 
          display: 'flex', 
          background: 'rgba(0,0,0,0.25)', 
          borderRadius: '14px', 
          padding: '4px', 
          marginBottom: '28px',
          border: '1px solid var(--border-panel)',
          position: 'relative'
        }}>
          <button 
            onClick={() => setConfigMode('auto')}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
              padding: '12px',
              borderRadius: '10px',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.95rem',
              fontWeight: 700,
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              background: configMode === 'auto' ? 'var(--accent)' : 'transparent',
              color: configMode === 'auto' ? '#fff' : 'var(--text-muted)',
              zIndex: 1,
              boxShadow: configMode === 'auto' ? '0 4px 15px rgba(88, 166, 255, 0.4)' : 'none'
            }}
          >
            <Zap size={18} fill={configMode === 'auto' ? 'currentColor' : 'none'} />
            お任せモード
          </button>
          <button 
            onClick={() => setConfigMode('manual')}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
              padding: '12px',
              borderRadius: '10px',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.95rem',
              fontWeight: 700,
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              background: configMode === 'manual' ? 'var(--accent)' : 'transparent',
              color: configMode === 'manual' ? '#fff' : 'var(--text-muted)',
              zIndex: 1,
              boxShadow: configMode === 'manual' ? '0 4px 15px rgba(88, 166, 255, 0.4)' : 'none'
            }}
          >
            <SettingsIcon size={18} />
            カスタム設定
          </button>
        </div>

        {configMode === 'auto' && (
          <div style={{ 
            padding: '16px', 
            background: 'rgba(88, 166, 255, 0.08)', 
            borderRadius: '14px', 
            border: '1px solid rgba(88, 166, 255, 0.2)',
            marginBottom: '28px',
            display: 'flex',
            gap: '14px',
            boxShadow: 'inset 0 0 20px rgba(88, 166, 255, 0.05)'
          }}>
            <div style={{
              background: 'rgba(88, 166, 255, 0.15)',
              padding: '8px',
              borderRadius: '10px',
              height: 'fit-content'
            }}>
              <Info size={18} color="var(--accent)" />
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-main)', lineHeight: 1.6, margin: 0 }}>
              推奨値（<strong style={{ color: 'var(--accent)' }}>リバランス幅 5% / ヘッジ 50%</strong>）が自動適用されます。市場のボラティリティに最適化された最も安定した設定です。
            </p>
          </div>
        )}

        <div className="form-group" style={{ marginBottom: '28px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', color: 'var(--text-main)', fontSize: '0.9rem' }}>
            <Zap size={16} color="var(--neon-cetus)" /> 総運用資金 (Total USDC)
          </label>
          <div style={{ position: 'relative' }}>
            <input 
              type="number" 
              className="input-glass" 
              value={totalCapital} 
              onChange={(e) => setTotalCapital(e.target.value)} 
              placeholder="e.g. 200"
              style={{ 
                fontSize: '1.4rem', 
                fontWeight: 800, 
                color: 'white', 
                padding: '16px 80px 16px 20px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.1)'
              }}
            />
            <span style={{ 
              position: 'absolute', 
              right: '20px', 
              top: '50%', 
              transform: 'translateY(-50%)', 
              fontSize: '1rem', 
              color: 'var(--text-muted)',
              fontWeight: 800,
              letterSpacing: '0.05em'
            }}>USDC</span>
          </div>
          <div style={{ 
            marginTop: '12px', 
            fontSize: '0.8rem', 
            color: 'var(--text-muted)', 
            display: 'flex', 
            alignItems: 'center', 
            gap: '6px',
            paddingLeft: '4px' 
          }}>
             <Info size={14} /> ボットが認識する総資本額です（利益計算やマージン管理の基準）。
          </div>
        </div>

        <div className="form-group" style={{ marginBottom: '28px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', color: 'var(--text-main)', fontSize: '0.9rem' }}>
            <Wallet size={16} color="var(--neon-cetus)" /> LP投入額 (LP Amount)
          </label>
          <div style={{ position: 'relative' }}>
            <input 
              type="number" 
              className="input-glass" 
              value={lpAmount} 
              onChange={(e) => setLpAmount(e.target.value)} 
              placeholder="e.g. 100"
              style={{ 
                fontSize: '1.2rem', 
                fontWeight: 700, 
                color: 'white', 
                padding: '12px 80px 12px 20px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.1)'
              }}
            />
            <span style={{ 
              position: 'absolute', 
              right: '20px', 
              top: '50%', 
              transform: 'translateY(-50%)', 
              fontSize: '0.9rem', 
              color: 'var(--text-muted)',
              fontWeight: 700
            }}>USDC</span>
          </div>
          <div style={{ 
            marginTop: '8px', 
            fontSize: '0.75rem', 
            color: 'var(--text-muted)', 
            paddingLeft: '4px' 
          }}>
             CetusのLPポジションに実際に投入する金額です。
          </div>
        </div>

        <div style={{ display: 'flex', gap: '20px', marginBottom: '28px' }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label style={{ opacity: configMode === 'auto' ? 0.5 : 1, marginBottom: '8px', fontSize: '0.85rem' }}>Range Width (%)</label>
            <input 
              type="number" 
              className="input-glass" 
              value={rangeWidth} 
              onChange={(e) => setRangeWidth(e.target.value)} 
              min="0.61"
              max="15"
              step="0.01"
              disabled={configMode === 'auto'}
              style={{ 
                opacity: configMode === 'auto' ? 0.4 : 1,
                cursor: configMode === 'auto' ? 'not-allowed' : 'text',
                textAlign: 'center',
                fontWeight: 700
              }}
            />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label style={{ opacity: configMode === 'auto' ? 0.5 : 1, marginBottom: '8px', fontSize: '0.85rem' }}>Hedge Ratio (%)</label>
            <input 
              type="number" 
              className="input-glass" 
              value={hedgeRatio} 
              onChange={(e) => setHedgeRatio(e.target.value)} 
              step="10" 
              disabled={configMode === 'auto'}
              style={{ 
                opacity: configMode === 'auto' ? 0.4 : 1,
                cursor: configMode === 'auto' ? 'not-allowed' : 'text',
                textAlign: 'center',
                fontWeight: 700
              }}
            />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '28px' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label style={{ marginBottom: '8px', fontSize: '0.85rem' }}>Telegram Token</label>
            <div className="input-wrapper">
              <input 
                type={showTelegramToken ? "text" : "password"} 
                className="input-glass" 
                placeholder="Token" 
                value={telegramToken}
                onChange={(e) => setTelegramToken(e.target.value)}
                autoComplete="off"
                style={{ fontSize: '0.9rem' }}
              />
              <div className="input-icon-right" onClick={() => setShowTelegramToken(!showTelegramToken)}>
                {showTelegramToken ? <EyeOff size={16} /> : <Eye size={16} />}
              </div>
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label style={{ marginBottom: '8px', fontSize: '0.85rem' }}>Telegram Chat ID</label>
            <input 
              type="text" 
              className="input-glass" 
              placeholder="Chat ID" 
              value={telegramChatId} 
              onChange={(e) => setTelegramChatId(e.target.value)} 
              autoComplete="off"
              style={{ fontSize: '0.9rem' }}
            />
          </div>
        </div>

        <div className="form-group" style={{ marginBottom: '28px' }}>
           <label style={{ marginBottom: '8px', fontSize: '0.85rem' }}>バックアップ用パスワード (表示解除用)</label>
           <input 
             type="password" 
             className="input-glass" 
             placeholder="バックアップ情報を表示するためのパスワード" 
             value={backupPassword} 
             onChange={(e) => setBackupPassword(e.target.value)} 
             autoComplete="off"
             style={{ fontSize: '0.9rem' }}
           />
        </div>

        <div style={{ 
          marginTop: '8px', 
          padding: '20px', 
          background: 'rgba(248, 81, 73, 0.05)', 
          borderRadius: '16px', 
          border: '1px solid rgba(248, 81, 73, 0.15)',
          position: 'relative',
          overflow: 'hidden'
        }}>
          {/* 装飾用背景 */}
          <div style={{ position: 'absolute', top: '-20px', right: '-20px', opacity: 0.05 }}>
             <Zap size={100} color="var(--danger)" />
          </div>

          <label style={{ color: 'var(--danger)', fontSize: '0.85rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <Zap size={16} fill="currentColor" /> 資産の安全なバックアップ
          </label>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.6 }}>
            「専用運用ウォレット」の**リカバリーフレーズ**を表示します。これを保存しておけば、サーバー停止時も資金を回収可能です。
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
              <form onSubmit={handleFetchKey} style={{ textAlign: 'center' }}>
                <div style={{ 
                  display: 'flex', 
                  flexDirection: 'column', 
                  gap: '12px',
                  background: 'rgba(0,0,0,0.2)',
                  padding: '16px',
                  borderRadius: '12px',
                  border: '1px solid rgba(255,255,255,0.05)'
                }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    情報の表示には管理パスワードが必要です。
                  </p>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <input 
                      type="password"
                      className="input-glass"
                      placeholder="管理パスワード"
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      style={{ flex: 1, fontSize: '0.9rem', background: 'rgba(0,0,0,0.3)' }}
                    />
                    <button 
                      type="submit"
                      className="primary-btn" 
                      disabled={isLoadingKey}
                      style={{ 
                        width: '90px', 
                        height: '44px', 
                        fontSize: '0.9rem',
                        boxShadow: 'none',
                        background: 'rgba(255,255,255,0.1)',
                        border: '1px solid rgba(255,255,255,0.1)'
                      }}
                    >
                      {isLoadingKey ? "..." : "解除"}
                    </button>
                  </div>
                  {authError && (
                    <p style={{ fontSize: '0.7rem', color: 'var(--danger)', fontWeight: 600 }}>
                      {authError}
                    </p>
                  )}
                </div>
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
          <button 
            className="primary-btn" 
            onClick={handleSave} 
            disabled={isSaving} 
            style={{ 
              width: '100%', 
              height: '54px', 
              fontSize: '1.05rem', 
              borderRadius: '14px',
              background: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px'
            }}
          >
            <Save size={20} /> {isSaving ? '保存中...' : '設定を保存して接続'}
          </button>
        </div>


      </div>
    </div>
  );
};
