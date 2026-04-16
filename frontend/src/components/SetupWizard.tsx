import React, { useState } from 'react';
import { 
  ShieldCheck, 
  Compass, 
  Key, 
  Rocket, 
  ChevronRight, 
  CheckCircle2, 
  AlertTriangle, 
  Info, 
  X,
  ArrowRight,
  Server,
  ExternalLink
} from 'lucide-react';

interface SetupWizardProps {
  isOpen: boolean;
  onComplete: () => void;
  onClose: () => void;
  privateKey: string;
  setPrivateKey: (val: string) => void;
  apiUrl: string;
  setApiUrl?: (val: string) => void;
}

export const SetupWizard: React.FC<SetupWizardProps> = ({ 
  isOpen, 
  onComplete, 
  onClose,
  privateKey, 
  setPrivateKey, 
  apiUrl,
  setApiUrl 
}) => {
  const [step, setStep] = useState(1);
  const [network, setNetwork] = useState<'testnet' | 'mainnet'>('testnet');
  const [customApiUrl, setCustomApiUrl] = useState(apiUrl || '');
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
        ? '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105'
        : '0xf4f9663f288049ede73a9f19e3a655c74be8a9a84dd3e2c7f04c190c5c9f1fba';

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
      
      await new Promise(r => setTimeout(r, 1500));
      onComplete(); 
    } catch (e) {
      console.error(e);
      alert('Network Error: Make sure your backend API is running.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="wizard-overlay">
      <div className="wizard-card" style={{ position: 'relative' }}>
        {/* Close Button */}
        <button className="wizard-close-btn" onClick={onClose} title="閉じる">
          <X size={20} />
        </button>
        
        <div className="step-indicator">
          {[1,2,3,4].map(num => (
            <div key={num} className={`step-dot ${step >= num ? 'active' : ''}`} />
          ))}
        </div>

        {step === 1 && (
          <div className="wizard-content">
            <div className="wizard-header">
              <ShieldCheck size={56} color="var(--neon-cetus)" style={{ marginBottom: '16px', filter: 'drop-shadow(0 0 12px rgba(78, 242, 194, 0.4))' }} />
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
            
            <div style={{ padding: '12px', background: 'rgba(78, 242, 194, 0.05)', borderRadius: '12px', border: '1px solid rgba(78, 242, 194, 0.15)', display: 'flex', gap: '12px', alignItems: 'flex-start', marginTop: '8px' }}>
              <Info size={20} color="var(--neon-cetus)" style={{ flexShrink: 0, marginTop: '2px' }} />
              <div style={{ fontSize: '0.85rem', color: 'var(--text-main)', lineHeight: 1.5 }}>
                <strong>取得方法: </strong> Sui Walletを開き、右上のメニュー ＞ Accounts ＞ 使用するアカウント ＞ Export Private Key（鍵アイコン）から取得した文字列を入力してください。
              </div>
            </div>

            <div style={{ marginTop: 'auto', paddingTop: '32px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <button className="primary-btn" onClick={handleNext} disabled={!privateKey.startsWith('suiprivkey')}>
                開始する <ChevronRight size={18} />
              </button>
              <button 
                onClick={onClose}
                style={{ 
                  background: 'transparent', 
                  border: 'none', 
                  color: 'var(--text-muted)', 
                  fontSize: '0.88rem', 
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  padding: '8px'
                }}
              >
                スキップして後で設定する <ArrowRight size={14} />
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="wizard-content">
            <div className="wizard-header">
              <Compass size={56} color="var(--neon-cyan)" style={{ marginBottom: '16px', filter: 'drop-shadow(0 0 12px rgba(0, 229, 255, 0.4))' }} />
              <h2>プールとネットワークの選択</h2>
              <p style={{ color: 'var(--text-muted)', marginTop: '8px' }}>
                運用する市場環境を選択してください。
              </p>
            </div>
            
            <div className="radio-group" style={{ marginBottom: '24px' }}>
              <div className={`radio-card ${network === 'testnet' ? 'selected' : ''}`} onClick={() => setNetwork('testnet')}>
                <div style={{ flex: 1 }}>
                  <h4 style={{ fontSize: '1.05rem', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    Sui Testnet (テスト用)
                    {network === 'testnet' && <CheckCircle2 size={16} color="var(--neon-cetus)" />}
                  </h4>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>無料のSUIを使って安全にテスト運用します。</p>
                </div>
              </div>
              
              <div className={`radio-card ${network === 'mainnet' ? 'selected' : ''}`} onClick={() => setNetwork('mainnet')}>
                <div style={{ flex: 1 }}>
                  <h4 style={{ fontSize: '1.05rem', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    Sui Mainnet (本番稼働)
                    {network === 'mainnet' && <CheckCircle2 size={16} color="var(--neon-cyan)" />}
                  </h4>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>実際の資産(USDC/SUI)を使って手数料を獲得します。</p>
                </div>
              </div>
            </div>

            <div className="form-group">
              <label>Target Pool (対象プール)</label>
              <input type="text" className="input-glass" value="SUI / USDC (Cetus Protocol)" disabled style={{ opacity: 0.7 }} />
            </div>

            <div style={{ marginTop: 'auto', paddingTop: '16px', display: 'flex', justifyContent: 'space-between' }}>
              <button style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' }} onClick={handlePrev}>戻る</button>
              <button className="primary-btn" onClick={handleNext} style={{ width: 'auto', padding: '12px 32px' }}>
                次へ <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="wizard-content">
            <div className="wizard-header">
              <Key size={56} color={network === 'mainnet' ? 'var(--danger)' : 'var(--neon-cetus)'} style={{ marginBottom: '16px', filter: `drop-shadow(0 0 12px ${network === 'mainnet' ? 'rgba(248, 81, 73, 0.4)' : 'rgba(78, 242, 194, 0.4)'})` }} />
              <h2>安全装置の解除</h2>
              <p style={{ color: 'var(--text-muted)', marginTop: '8px' }}>
                運用を開始する前の確認事項です。
              </p>
            </div>
            
            <div style={{ background: 'rgba(0,0,0,0.3)', padding: '20px', borderRadius: '16px', border: '1px solid var(--border-panel)', marginBottom: '24px' }}>
              <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <li style={{ display: 'flex', gap: '12px' }}>
                  <AlertTriangle size={20} color={network === 'mainnet' ? 'var(--danger)' : 'var(--neon-cetus)'} style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: '0.9rem', lineHeight: 1.5 }}>
                    <strong>資金の確認：</strong>
                    ウォレットにガス代用のSUIが少量入っていることを確認してください。
                  </span>
                </li>
                <li style={{ display: 'flex', gap: '12px' }}>
                  <Info size={20} color="var(--neon-cyan)" style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: '0.9rem', lineHeight: 1.5 }}>
                    <strong>リスクの承諾：</strong>
                    急激な価格変動によりインパーマネントロスが発生する場合があります。
                  </span>
                </li>
              </ul>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', padding: '16px', border: '1px solid var(--border-panel)', borderRadius: '12px', background: safetyUnlocked ? 'rgba(88, 166, 255, 0.05)' : 'transparent', transition: 'all 0.2s' }}>
              <input 
                type="checkbox" 
                checked={safetyUnlocked} 
                onChange={(e) => setSafetyUnlocked(e.target.checked)} 
                style={{ width: '22px', height: '22px', accentColor: 'var(--accent)' }}
              />
              <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>免責事項に同意し、安全ロックを解除して本番稼働させます。</span>
            </label>

            <div style={{ marginTop: 'auto', paddingTop: '32px', display: 'flex', justifyContent: 'space-between' }}>
              <button style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' }} onClick={handlePrev}>戻る</button>
              <button className="primary-btn" onClick={handleNext} disabled={!safetyUnlocked} style={{ width: 'auto', padding: '12px 32px' }}>
                最終確認へ <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="wizard-content" style={{ alignItems: 'center', textAlign: 'center' }}>
            <div style={{ position: 'relative', marginBottom: '32px' }}>
              <div style={{ position: 'absolute', inset: -20, background: 'var(--neon-cetus)', filter: 'blur(40px)', opacity: 0.15 }}></div>
              <Rocket size={80} className="animate-pulse-slow" color="var(--neon-cetus)" style={{ filter: 'drop-shadow(0 0 20px rgba(78, 242, 194, 0.6))' }} />
            </div>
            <h2 style={{ fontSize: '2.2rem', marginBottom: '16px', fontWeight: 800 }}>All Systems Ready</h2>
            <p style={{ color: 'var(--text-muted)', maxWidth: '400px', lineHeight: 1.6, marginBottom: '40px' }}>
              Botの初期設定が完了しました。市場監視エンジンを起動し、資産の運用を開始します。
            </p>
            
            <button className="primary-btn" onClick={handleLaunch} disabled={isSaving} style={{ fontSize: '1.1rem', padding: '16px 60px', borderRadius: '40px' }}>
              {isSaving ? '起動中...' : '運用を開始する'}
            </button>
          </div>
        )}

      </div>
    </div>
  );
};
