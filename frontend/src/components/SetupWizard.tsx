import React from 'react';
import { Wallet, Info, X } from 'lucide-react';
import { ConnectButton } from '@mysten/dapp-kit';

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
  if (!isOpen) return null;

  return (
    <div className="wizard-overlay">
      <div className="wizard-card" style={{ position: 'relative' }}>
        <button className="wizard-close-btn" onClick={onClose} title="閉じる">
          <X size={20} />
        </button>
        
        <div className="wizard-content">
          <div className="wizard-header">
            <Wallet size={56} color="var(--neon-cetus)" style={{ marginBottom: '16px', filter: 'drop-shadow(0 0 12px rgba(78, 242, 194, 0.4))' }} />
            <h2>ウォレットを接続してください</h2>
            <p style={{ color: 'var(--text-muted)', marginTop: '8px' }}>
              Sui Walletを接続してボットを開始します。
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
            <ConnectButton />
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center' }}>
              接続後、自動的にセッションが作成されます
            </p>
          </div>
          
          <div style={{ padding: '12px', background: 'rgba(78, 242, 194, 0.05)', borderRadius: '12px', border: '1px solid rgba(78, 242, 194, 0.15)', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
            <Info size={20} color="var(--neon-cetus)" style={{ flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '0.85rem', color: 'var(--text-main)', lineHeight: 1.5 }}>
              <strong>必要なもの: </strong> Sui Wallet拡張機能（ブラウザにインストール済みである必要があります）
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
