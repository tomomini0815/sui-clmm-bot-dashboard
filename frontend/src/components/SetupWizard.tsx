import React from 'react';
import { Wallet, Info, X, ShieldCheck, Zap, ArrowRight, ChevronLeft } from 'lucide-react';
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit';

interface SetupWizardProps {
  isOpen: boolean;
  onComplete: () => void;
  onClose: () => void;
  apiUrl: string;
  mnemonic?: string;
  initialPoolId?: string;
}

type WizardStep = 'selection' | 'pool' | 'direct' | 'safety' | 'backup';

export const SetupWizard: React.FC<SetupWizardProps> = ({ 
  isOpen, 
  onComplete, 
  onClose,
  apiUrl,
  mnemonic,
  initialPoolId
}) => {
  const currentAccount = useCurrentAccount();
  const [step, setStep] = React.useState<WizardStep>('selection');
  const [mnemonicInput, setMnemonicInput] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [hasBackedUp, setHasBackedUp] = React.useState(false);
  const [selectedPool, setSelectedPool] = React.useState(initialPoolId || '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105');
  const [targetStep, setTargetStep] = React.useState<'direct' | 'safety'>('safety');

  const POOLS = [
    { id: '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105', name: 'SUI / USDC', fee: '0.25%' },
    { id: '0xe01243f37f712ef87e556afb9b1d03d0fae13f96d324ec912daffc339dfdcbd2', name: 'DEEP / SUI', fee: '0.25%' },
  ];

  // mnemonic prop が渡されたらバックアップ画面へ
  React.useEffect(() => {
    if (mnemonic && step !== 'backup') {
      setStep('backup');
    }
  }, [mnemonic]);

  // Wizardが開くたびにステートをリセット
  React.useEffect(() => {
    if (isOpen && !mnemonic) {
      setStep('selection');
      setMnemonicInput('');
      setIsSubmitting(false);
      if (initialPoolId) {
        setSelectedPool(initialPoolId);
      }
    }
  }, [isOpen, mnemonic, initialPoolId]);

  const [directInputType, setDirectInputType] = React.useState<'mnemonic' | 'privateKey'>('mnemonic');

  const handleRestore = async () => {
    if (targetStep === 'direct') {
      if (directInputType === 'mnemonic' && mnemonicInput.trim().split(/\s+/).length !== 12) {
        alert('リカバリーフレーズは12単語で入力してください');
        return;
      }
      if (directInputType === 'privateKey' && !mnemonicInput.trim()) {
        alert('秘密鍵を入力してください');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const body: any = {
        poolObjectId: selectedPool
      };

      if (targetStep === 'direct') {
        if (directInputType === 'mnemonic') {
          body.mnemonic = mnemonicInput.trim();
        } else {
          body.privateKey = mnemonicInput.trim();
        }
      } else {
        // Safety Mode
        if (!currentAccount) {
          alert('ウォレットを接続してください');
          setIsSubmitting(false);
          return;
        }
        body.walletAddress = currentAccount.address;
        body.isWalletConnect = true;
      }

      const response = await fetch(`${apiUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      
      if (data.success) {
        localStorage.setItem('session_id', data.sessionId);
        localStorage.setItem('wizard_completed', 'true');
        if (data.botWalletAddress) {
          localStorage.setItem('bot_wallet_address', data.botWalletAddress);
        }
        onComplete();
      } else {
        alert('失敗しました: ' + (data.error || '不明なエラー'));
      }
    } catch (e) {
      console.error(e);
      alert('サーバー通信エラー');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFinish = () => {
    if (mnemonic && !hasBackedUp) {
      alert('リカバリーフレーズをメモしたことを確認してください');
      return;
    }
    localStorage.setItem('wizard_completed', 'true');
    onComplete();
  };

  if (!isOpen) return null;

  return (
    <div className="wizard-overlay">
      <div className="wizard-card" style={{ position: 'relative', maxWidth: '540px', width: '90%' }}>
        <button className="wizard-close-btn" onClick={onClose} title="閉じる">
          <X size={20} />
        </button>
        
        <div className="wizard-content">
          {/* Header */}
          <div className="wizard-header">
            {step !== 'selection' && step !== 'backup' && (
              <button 
                onClick={() => setStep('selection')}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', marginBottom: '12px' }}
              >
                <ChevronLeft size={16} /> 戻る
              </button>
            )}
            
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              {step === 'selection' && <Wallet size={56} color="var(--accent)" />}
              {step === 'pool' && <Zap size={56} color="var(--accent)" />}
              {step === 'safety' && <ShieldCheck size={56} color="#2ed573" />}
              {step === 'direct' && <Zap size={56} color="var(--neon-cetus)" />}
              {step === 'backup' && <ShieldCheck size={56} color="#ff7a7f" />}
            </div>

            <h2>
              {step === 'selection' && '運用スタイルを選択'}
              {step === 'pool' && '運用対象のプールを選択'}
              {step === 'safety' && '安心設定：ボット専用口座'}
              {step === 'direct' && 'かんたん設定：メイン口座'}
              {step === 'backup' && 'フレーズを保存してください'}
            </h2>
            <p style={{ color: 'var(--text-muted)', marginTop: '8px' }}>
              {step === 'selection' && 'ボットをどのように運用するか選択してください。後で変更も可能です。'}
              {step === 'safety' && '運用資金だけをボットに預ける、最も安全な推奨モードです。'}
              {step === 'direct' && '自分の12単語または秘密鍵を入力して、メインウォレットをそのままボットにします。'}
              {step === 'backup' && 'この12単語は、ボットの資金を回収するための唯一の鍵です。'}
            </p>
          </div>

          {/* Step: Selection */}
          {step === 'selection' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '8px' }}>
              {/* Option Safety */}
              <div 
                onClick={() => { setTargetStep('safety'); setStep('pool'); }}
                className="glass-panel"
                style={{ 
                  padding: '20px', cursor: 'pointer', border: '1px solid rgba(46, 213, 115, 0.2)',
                  transition: 'all 0.2s', background: 'rgba(46, 213, 115, 0.03)'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px', color: '#2ed573' }}>
                    <ShieldCheck size={20} /> 安心設定（推奨）
                  </h3>
                  <span style={{ fontSize: '0.7rem', background: '#2ed573', color: 'white', padding: '2px 8px', borderRadius: '10px', fontWeight: 800 }}>SECURITY</span>
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-main)', margin: '0 0 12px 0' }}>
                  ボット専用の運用口座を自動作成します。メインウォレットから運用分だけを送金して使うため、万が一の際も安心です。
                </p>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  詳しく見る <ArrowRight size={14} />
                </div>
              </div>

              {/* Option Direct */}
              <div 
                onClick={() => { setTargetStep('direct'); setStep('pool'); }}
                className="glass-panel"
                style={{ 
                  padding: '20px', cursor: 'pointer', border: '1px solid rgba(88, 166, 255, 0.2)',
                  transition: 'all 0.2s', background: 'rgba(88, 166, 255, 0.03)'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent)' }}>
                    <Zap size={20} /> 直接運用モード
                  </h3>
                  <span style={{ fontSize: '0.7rem', background: 'var(--accent)', color: 'white', padding: '2px 8px', borderRadius: '10px', fontWeight: 800 }}>DIRECT</span>
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-main)', margin: '0 0 12px 0' }}>
                  現在接続しているメインウォレットをそのままボットとして使います。送金の手間がなく、今あるLPポジションも自動で管理できます。
                </p>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  詳しく見る <ArrowRight size={14} />
                </div>
              </div>
            </div>
          )}

          {/* Step: Pool Selection */}
          {step === 'pool' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>運用対象のペアを選択してください。DEEP/SUIにも対応しました。</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {POOLS.map(pool => (
                  <div 
                    key={pool.id}
                    onClick={() => setSelectedPool(pool.id)}
                    className="glass-panel"
                    style={{ 
                      padding: '16px', cursor: 'pointer', 
                      border: selectedPool === pool.id ? '2px solid var(--accent)' : '1px solid var(--border-panel)',
                      background: selectedPool === pool.id ? 'rgba(88, 166, 255, 0.1)' : 'rgba(255,255,255,0.02)',
                      transition: 'all 0.2s'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600 }}>{pool.name}</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>手数料: {pool.fee}</span>
                    </div>
                  </div>
                ))}
              </div>
              <button 
                className="btn-primary" 
                onClick={() => setStep(targetStep)}
                style={{ width: '100%', marginTop: '8px', padding: '14px' }}
              >
                次へ進む
              </button>
            </div>
          )}

          {/* Step: Safety */}
          {step === 'safety' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div style={{ padding: '16px', background: 'rgba(255,255,255,0.03)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: 'var(--border-panel)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 800 }}>1</div>
                    <div style={{ fontSize: '0.8rem' }}>個人ウォレットで<strong>ログイン</strong></div>
                  </div>
                  <div style={{ height: '12px', borderLeft: '2px dashed var(--border-panel)', marginLeft: '11px' }}></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: '#2ed573', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 800, color: 'white' }}>2</div>
                    <div style={{ fontSize: '0.8rem' }}><strong>ボット専用口座</strong>を自動生成</div>
                  </div>
                  <div style={{ height: '12px', borderLeft: '2px dashed var(--border-panel)', marginLeft: '11px' }}></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 800, color: 'white' }}>3</div>
                    <div style={{ fontSize: '0.8rem' }}>運用資金をそこに<strong>送金</strong></div>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', padding: '24px', background: 'rgba(0,0,0,0.3)', borderRadius: '16px', border: '1px solid var(--border-panel)' }}>
                <div className="sui-connect-wrapper">
                  <ConnectButton />
                </div>
                <button 
                  className="btn-primary" 
                  onClick={handleRestore}
                  disabled={!currentAccount || isSubmitting}
                  style={{ width: '100%', padding: '14px', fontSize: '1rem' }}
                >
                  {isSubmitting ? 'セッション作成中...' : 'このプールでボットを開始'}
                </button>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  {!currentAccount ? "まずはウォレットを接続してください" : "接続完了。上記のボタンで開始します。"}
                </p>
              </div>
            </div>
          )}

          {/* Step: Direct */}
          {step === 'direct' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0 0 8px 0' }}>
                {currentAccount ? (
                  <>
                    現在接続中のアドレス: <code style={{ color: 'var(--accent)', background: 'rgba(255,255,255,0.05)', padding: '2px 4px', borderRadius: '4px' }}>{currentAccount.address.slice(0, 10)}...{currentAccount.address.slice(-6)}</code><br />
                    このウォレットを24時間自動運用するために、リカバリーフレーズ（12単語）または秘密鍵を入力してください。
                  </>
                ) : (
                  '運用したいウォレットのリカバリーフレーズ（12単語）または秘密鍵を入力してください。'
                )}
              </p>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <button 
                  onClick={() => setDirectInputType('mnemonic')}
                  style={{
                    flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid var(--border-panel)',
                    background: directInputType === 'mnemonic' ? 'var(--accent)' : 'transparent',
                    color: directInputType === 'mnemonic' ? 'white' : 'var(--text-muted)',
                    fontSize: '0.85rem', cursor: 'pointer', transition: 'all 0.2s'
                  }}
                >
                  12単語 (Mnemonic)
                </button>
                <button 
                  onClick={() => setDirectInputType('privateKey')}
                  style={{
                    flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid var(--border-panel)',
                    background: directInputType === 'privateKey' ? 'var(--accent)' : 'transparent',
                    color: directInputType === 'privateKey' ? 'white' : 'var(--text-muted)',
                    fontSize: '0.85rem', cursor: 'pointer', transition: 'all 0.2s'
                  }}
                >
                  秘密鍵 (Private Key)
                </button>
              </div>

              <textarea 
                value={mnemonicInput}
                onChange={(e) => setMnemonicInput(e.target.value)}
                placeholder={directInputType === 'mnemonic' ? "12単語のリカバリーフレーズを入力してください..." : "0x... または suiprivkey... で始まる秘密鍵を入力してください"}
                style={{
                  width: '100%', height: '100px', background: 'rgba(255,255,255,0.05)',
                  border: '1px solid var(--border-panel)', borderRadius: '12px',
                  padding: '12px', color: 'white', fontSize: '0.9rem', resize: 'none',
                  fontFamily: 'monospace'
                }}
              />
              <button 
                className="btn-primary" 
                onClick={handleRestore}
                disabled={isSubmitting}
                style={{ width: '100%', padding: '14px', fontSize: '1rem' }}
              >
                {isSubmitting ? '認証中...' : 'ボットを開始'}
              </button>
              <div style={{ padding: '12px', background: 'rgba(248, 81, 73, 0.05)', borderRadius: '12px', border: '1px solid rgba(248, 81, 73, 0.15)', display: 'flex', gap: '10px' }}>
                <Info size={16} color="#f85149" style={{ flexShrink: 0 }} />
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                  注意: 秘密鍵をボットに預けることになります。セキュリティを重視する場合は「安心設定」をご利用ください。
                </p>
              </div>
            </div>
          )}

          {/* Step: Backup */}
          {step === 'backup' && mnemonic && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div 
                style={{ 
                  display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px',
                  background: 'rgba(0,0,0,0.3)', padding: '20px', borderRadius: '16px',
                  border: '1px solid #ff7a7f', fontSize: '0.9rem'
                }}
              >
                {mnemonic.split(' ').map((word, i) => (
                  <div key={i} style={{ 
                    background: 'rgba(255,255,255,0.05)', padding: '8px', borderRadius: '8px',
                    display: 'flex', gap: '8px'
                  }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{i + 1}</span>
                    <span style={{ fontWeight: 600 }}>{word}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', cursor: 'pointer' }} onClick={() => setHasBackedUp(!hasBackedUp)}>
                <input type="checkbox" checked={hasBackedUp} readOnly style={{ width: '20px', height: '20px', cursor: 'pointer' }} />
                <span style={{ fontSize: '0.9rem', color: 'var(--text-main)' }}>12単語を安全な場所にメモしました。</span>
              </div>
              <button className="btn-primary" onClick={handleFinish} style={{ width: '100%', padding: '14px', fontSize: '1rem', background: '#2ed573' }}>
                ダッシュボードへ移動
              </button>
            </div>
          )}

          {/* Footer Info */}
          <div style={{ marginTop: '24px', padding: '12px', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', border: '1px solid var(--border-panel)', display: 'flex', gap: '12px', alignItems: 'center' }}>
            <Info size={18} color="var(--text-muted)" style={{ flexShrink: 0 }} />
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              不明な点は<span style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}>ヘルプ</span>をご確認ください。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
