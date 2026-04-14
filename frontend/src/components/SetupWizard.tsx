import React, { useState } from 'react';
import { Wallet, Globe, Unlock, Rocket, ChevronRight, CheckCircle2, AlertTriangle, Info } from 'lucide-react';

interface SetupWizardProps {
  isOpen: boolean;
  onComplete: () => void;
  privateKey: string;
  setPrivateKey: (val: string) => void;
}

export const SetupWizard: React.FC<SetupWizardProps> = ({ isOpen, onComplete, privateKey, setPrivateKey }) => {
  const [step, setStep] = useState(1);
  const [network, setNetwork] = useState<'testnet' | 'mainnet'>('testnet');
  const [safetyUnlocked, setSafetyUnlocked] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [faucetStatus, setFaucetStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [faucetError, setFaucetError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleNext = () => setStep(s => s + 1);
  const handlePrev = () => setStep(s => s - 1);
  const handleFaucet = async () => {
    setFaucetStatus('loading');
    setFaucetError(null);
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const response = await fetch(`${apiUrl}/api/faucet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey })
      });
      const data = await response.json();
      if (data.success) {
        setFaucetStatus('success');
      } else {
        setFaucetStatus('error');
        setFaucetError(data.error || 'Unknown Error');
      }
    } catch (e: any) {
      setFaucetStatus('error');
      setFaucetError(e.message || 'Network Error');
      console.error(e);
    }
  };

  const handleLaunch = async () => {
    setIsSaving(true);
    try {
      const url = network === 'mainnet' 
        ? 'https://fullnode.mainnet.sui.io:443' 
        : 'https://fullnode.testnet.sui.io:443';
        
      const poolId = network === 'mainnet'
        ? '0xcf994611fd4c48e277ce3ffd4d4364c914af2c3cbb05f7bf6facd371de688630'
        : '0xc8d7a1503dc2f9f5b05449a87d8733593e2f0f3e7bffd90541252782e4d2ca20';

      // Send config to backend (Mock backend will save to .env)
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      await fetch(`${apiUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          privateKey,
          rpcUrl: url,
          poolObjectId: poolId,
          rangeWidth: 5.0,
          hedgeRatio: 50
        })
      });
      // Delay for dramatic effect
      await new Promise(r => setTimeout(r, 1500));
      onComplete(); // Closes wizard & returns to dashboard
    } catch (e) {
      console.error(e);
      alert('Network Error: Make sure your backend API is running.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="wizard-overlay">
      <div className="wizard-card">
        
        <div className="step-indicator">
          {[1,2,3,4].map(num => (
            <div key={num} className={`step-dot ${step >= num ? 'active' : ''}`} />
          ))}
        </div>

        {step === 1 && (
          <div className="wizard-content">
            <div className="wizard-header">
              <Wallet size={48} color="var(--neon-cetus)" style={{ marginBottom: '16px' }} />
              <h2>ボットへ秘密鍵を紐付けましょう</h2>
              <p style={{ color: 'var(--text-muted)', marginTop: '8px' }}>
                Cetusで自動取引を行うための専用のSui Walletを紐付けます。
              </p>
            </div>
            
            <div className="form-group">
              <label>Sui Private Key (秘密鍵)</label>
              <input 
                type="password" 
                className="input-glass" 
                placeholder="suiprivkey..." 
                value={privateKey}
                onChange={e => setPrivateKey(e.target.value)}
                autoFocus
              />
            </div>
            
            <div style={{ padding: '12px', background: 'rgba(78, 242, 194, 0.05)', borderRadius: '8px', border: '1px solid rgba(78, 242, 194, 0.15)', display: 'flex', gap: '12px', alignItems: 'flex-start', marginTop: '8px' }}>
              <Info size={20} color="var(--neon-cetus)" style={{ flexShrink: 0, marginTop: '2px' }} />
              <div style={{ fontSize: '0.85rem', color: 'var(--text-main)', lineHeight: 1.5 }}>
                <strong>取得方法: </strong> Sui Walletを開き、右上のメニュー ＞ Accounts ＞ 使用するアカウント ＞ Export Private Key（鍵アイコン）から取得した文字列を入力してください。
              </div>
            </div>

            <div style={{ marginTop: 'auto', paddingTop: '32px', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="primary-btn" onClick={handleNext} disabled={!privateKey.startsWith('suiprivkey')} style={{ width: 'auto' }}>
                Next <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="wizard-content">
            <div className="wizard-header">
              <Globe size={48} color="var(--neon-cyan)" style={{ marginBottom: '16px' }} />
              <h2>プールとネットワークの選択</h2>
              <p style={{ color: 'var(--text-muted)', marginTop: '8px' }}>
                運用する市場環境を選択してください。専門的なURL設定は裏側で自動構築されます。
              </p>
            </div>
            
            <div className="radio-group" style={{ marginBottom: '24px' }}>
              <div className={`radio-card ${network === 'testnet' ? 'selected' : ''}`} onClick={() => setNetwork('testnet')}>
                <div style={{ flex: 1 }}>
                  <h4 style={{ fontSize: '1.05rem', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    Sui Testnet (テスト用安全環境)
                    {network === 'testnet' && <CheckCircle2 size={16} color="var(--neon-cetus)" />}
                  </h4>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>無料のおもちゃのSUIを使って、バグがないか安全にテスト運用します。</p>
                </div>
              </div>
              
              <div className={`radio-card ${network === 'mainnet' ? 'selected' : ''}`} onClick={() => setNetwork('mainnet')}>
                <div style={{ flex: 1 }}>
                  <h4 style={{ fontSize: '1.05rem', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    Sui Mainnet (本番・収益化環境)
                    {network === 'mainnet' && <CheckCircle2 size={16} color="var(--neon-cyan)" />}
                  </h4>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>本当のお客様の資産(USDC/SUI)を使って、実際にCetusから手数料を獲得します。</p>
                </div>
              </div>
            </div>

            <div className="form-group">
              <label>Target Pool (対象プール)</label>
              <input type="text" className="input-glass" value="SUI / USDC (Cetus Protocol)" disabled style={{ opacity: 0.7 }} />
            </div>

            <div style={{ marginTop: 'auto', paddingTop: '16px', display: 'flex', justifyContent: 'space-between' }}>
              <button style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' }} onClick={handlePrev}>Back</button>
              <button className="primary-btn" onClick={handleNext} style={{ width: 'auto' }}>
                Next <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="wizard-content">
            <div className="wizard-header">
              <Unlock size={48} color={network === 'mainnet' ? '#ff3d00' : 'var(--neon-cetus)'} style={{ marginBottom: '16px' }} />
              <h2>安全装置（ロック）の解除</h2>
              <p style={{ color: 'var(--text-muted)', marginTop: '8px' }}>
                実際に資金をデプロイするための確認事項です。
              </p>
            </div>
            
            <div style={{ background: 'rgba(0,0,0,0.3)', padding: '20px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)', marginBottom: '24px' }}>
              <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <li style={{ display: 'flex', gap: '12px' }}>
                  <AlertTriangle size={20} color={network === 'mainnet' ? '#ff3d00' : 'var(--neon-cetus)'} style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: '0.9rem', lineHeight: 1.5 }}>
                    <strong>{network === 'mainnet' ? '本物の資金が必要です' : 'テスト用資金が必要です'}：</strong>
                    紐付けたウォレット（アドレス）に、ガス代用のSUIが数枚入っていることを確認してください。
                  </span>
                </li>
                <li style={{ display: 'flex', gap: '12px' }}>
                  <Info size={20} color="var(--neon-cyan)" style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: '0.9rem', lineHeight: 1.5 }}>
                    <strong>自動契約の承諾：</strong>
                    Botは指定されたレンジ(±5%)を自動維持するため、急反発時にインパーマネントロスが発生する場合があります。
                  </span>
                </li>
              </ul>
            </div>

            {network === 'testnet' && (
              <div style={{ marginBottom: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <button 
                  className="primary-btn" 
                  onClick={handleFaucet}
                  disabled={faucetStatus !== 'idle'}
                  style={{ width: '100%', background: faucetStatus === 'success' ? '#2ecc71' : faucetStatus === 'error' ? '#e74c3c' : 'rgba(78, 242, 194, 0.2)', color: faucetStatus === 'idle' ? 'var(--neon-cetus)' : '#fff', border: '1px solid var(--neon-cetus)', boxShadow: 'none' }}
                >
                  {faucetStatus === 'idle' && '💧 Get Free Testnet SUI (Tap once)'}
                  {faucetStatus === 'loading' && '⏳ Requesting... (Takes ~10s)'}
                  {faucetStatus === 'success' && '✅ Successfully Funded!'}
                  {faucetStatus === 'error' && `❌ Error: ${faucetError || 'Check Console'}`}
                </button>
                {faucetStatus === 'success' && (
                  <span style={{ fontSize: '0.85rem', color: 'var(--neon-cetus)', marginTop: '8px' }}>
                    SUI received! You can now check the safety box and proceed.
                  </span>
                )}
                {faucetStatus === 'error' && faucetError?.includes('429') && (
                  <span style={{ fontSize: '0.85rem', color: '#e74c3c', marginTop: '8px' }}>
                    Too many requests. Please wait a few minutes and try again.
                  </span>
                )}
              </div>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', padding: '12px', border: '1px solid var(--border-panel)', borderRadius: '8px' }}>
              <input 
                type="checkbox" 
                checked={safetyUnlocked} 
                onChange={(e) => setSafetyUnlocked(e.target.checked)} 
                style={{ width: '20px', height: '20px', accentColor: 'var(--neon-cetus)' }}
              />
              <span style={{ fontWeight: 500 }}>免責事項に同意し、安全ロックを解除して取引システムを本番稼働させます。</span>
            </label>

            <div style={{ marginTop: 'auto', paddingTop: '32px', display: 'flex', justifyContent: 'space-between' }}>
              <button style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' }} onClick={handlePrev}>Back</button>
              <button className="primary-btn" onClick={handleNext} disabled={!safetyUnlocked} style={{ width: 'auto' }}>
                Configure <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="wizard-content" style={{ alignItems: 'center', textAlign: 'center' }}>
            <Rocket size={64} className="animate-pulse-slow" color="var(--neon-cetus)" style={{ marginBottom: '24px' }} />
            <h2 style={{ fontSize: '2rem', marginBottom: '16px' }}>All Systems Ready</h2>
            <p style={{ color: 'var(--text-muted)', maxWidth: '400px', lineHeight: 1.6, marginBottom: '40px' }}>
              Botの初期設定が完了しました。裏側のシステムに秘密鍵と対象プールの設定を送信し、ダッシュボードを接続します。
            </p>
            
            <button className="primary-btn" onClick={handleLaunch} disabled={isSaving} style={{ fontSize: '1.1rem', padding: '16px 40px', borderRadius: '30px' }}>
              {isSaving ? 'Starting Engine...' : 'Launch Dashboard'}
            </button>
          </div>
        )}

      </div>
    </div>
  );
};
