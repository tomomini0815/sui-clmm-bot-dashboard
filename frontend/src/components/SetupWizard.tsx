import React from 'react';
import { Wallet, Info, X } from 'lucide-react';
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit';

interface SetupWizardProps {
  isOpen: boolean;
  onComplete: () => void;
  onClose: () => void;
  apiUrl: string;
}

export const SetupWizard: React.FC<SetupWizardProps> = ({ 
  isOpen, 
  onComplete, 
  onClose,
  apiUrl
}) => {
  const currentAccount = useCurrentAccount();
  const [isRestoring, setIsRestoring] = React.useState(false);
  const [mnemonicInput, setMnemonicInput] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // 復元処理
  const handleRestore = async () => {
    if (mnemonicInput.trim().split(/\s+/).length !== 12) {
      alert('リカバリーフレーズは12単語で入力してください');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(`${apiUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          mnemonic: mnemonicInput.trim(),
        })
      });
      const data = await response.json();
      
      if (data.success) {
        localStorage.setItem('session_id', data.sessionId);
        localStorage.setItem('wizard_completed', 'true');
        onComplete();
      } else {
        alert('復元に失敗しました: ' + (data.error || '不明なエラー'));
      }
    } catch (e) {
      console.error(e);
      alert('サーバー通信エラー');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="wizard-overlay">
      <div className="wizard-card" style={{ position: 'relative', maxWidth: '480px' }}>
        <button className="wizard-close-btn" onClick={onClose} title="閉じる">
          <X size={20} />
        </button>
        
        <div className="wizard-content">
          <div className="wizard-header">
            <Wallet size={56} color="var(--neon-cetus)" style={{ marginBottom: '16px', filter: 'drop-shadow(0 0 12px rgba(78, 242, 194, 0.4))' }} />
            <h2>{isRestoring ? 'ボットを復元する' : 'ウォレットを接続してください'}</h2>
            <p style={{ color: 'var(--text-muted)', marginTop: '8px' }}>
              {isRestoring 
                ? 'メモした12単語を入力して、以前のウォレットと履歴に復帰します。' 
                : 'Sui Walletを接続してボットを開始します。'}
            </p>
          </div>
          
          <div style={{ 
            padding: '24px', 
            background: 'rgba(0,0,0,0.3)', 
            borderRadius: '16px', 
            border: '1px solid var(--border-panel)',
            marginBottom: '24px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '16px'
          }}>
            {!isRestoring ? (
              <>
                <ConnectButton />
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                  {currentAccount ? (
                    <span className="animate-pulse" style={{ color: 'var(--neon-cetus)', fontWeight: 600 }}>
                      セッションを作成中...
                    </span>
                  ) : (
                    "接続後、自動的にセッションが作成されます"
                  )}
                </p>
                
                <button 
                  onClick={() => setIsRestoring(true)}
                  style={{ 
                    background: 'transparent', 
                    border: 'none', 
                    color: 'var(--accent)', 
                    fontSize: '0.85rem', 
                    cursor: 'pointer',
                    textDecoration: 'underline'
                  }}
                >
                  既存のボットを12単語で復元する
                </button>
              </>
            ) : (
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <textarea 
                  value={mnemonicInput}
                  onChange={(e) => setMnemonicInput(e.target.value)}
                  placeholder="12単語のリカバリーフレーズを入力してください..."
                  style={{
                    width: '100%',
                    height: '100px',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid var(--border-panel)',
                    borderRadius: '12px',
                    padding: '12px',
                    color: 'white',
                    fontSize: '0.9rem',
                    resize: 'none',
                    fontFamily: 'monospace'
                  }}
                />
                <button 
                  className="btn-primary" 
                  onClick={handleRestore}
                  disabled={isSubmitting}
                  style={{ width: '100%', padding: '12px' }}
                >
                  {isSubmitting ? '復元中...' : '復元を実行'}
                </button>
                <button 
                  onClick={() => setIsRestoring(false)}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '0.8rem', cursor: 'pointer' }}
                >
                  キャンセル
                </button>
              </div>
            )}
          </div>
          
          <div style={{ padding: '12px', background: 'rgba(78, 242, 194, 0.05)', borderRadius: '12px', border: '1px solid rgba(78, 242, 194, 0.15)', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
            <Info size={20} color="var(--neon-cetus)" style={{ flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '0.85rem', color: 'var(--text-main)', lineHeight: 1.5 }}>
              <strong>バックアップの重要性: </strong> 生成された運用ウォレットの12単語を保存していれば、いつでも資産を回収できます。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
