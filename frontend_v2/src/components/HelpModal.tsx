import React from 'react';
import { X, ExternalLink, Droplets, Wallet, ArrowRight } from 'lucide-react';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HelpModal: React.FC<HelpModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="glass-panel modal-content" style={{ maxWidth: '600px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              background: 'rgba(249, 115, 22, 0.15)', padding: '8px', borderRadius: '8px',
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <Droplets size={20} color="#f97316" />
            </div>
            <h2 style={{ fontSize: '1.4rem', fontWeight: 600 }}>資金の追加方法 (Faucet)</h2>
          </div>
          <button style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }} onClick={onClose}>
            <X size={24} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', lineHeight: 1.6 }}>
            テストネット環境でボットを稼働させるには、ガス代（SUI）と運用資産（USDC/TSTA）が必要です。以下の手順で無料で入手できます。
          </p>

          {/* Step 1: gas SUI */}
          <div style={{
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid var(--border-panel)',
            borderRadius: '12px',
            padding: '16px'
          }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <span style={{ 
                 background: 'var(--accent)', color: 'white', width: '20px', height: '20px', 
                 borderRadius: '50%', fontSize: '0.75rem', display: 'flex', 
                 alignItems: 'center', justifyContent: 'center'
              }}>1</span>
              ガス代 (SUI) を入手する
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.9rem', color: 'var(--text-main)', opacity: 0.9 }}>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ArrowRight size={14} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>Sui Wallet 等の拡張機能内の「Request Testnet SUI」ボタンをクリックしてください。</span>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ArrowRight size={14} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>または、公式 Discord の #testnet-faucet チャンネルでアドレスを送信してください。</span>
              </div>
              <a 
                href="https://faucet.testnet.sui.io/" 
                target="_blank" 
                rel="noreferrer"
                className="primary-btn"
                style={{ marginTop: '8px', padding: '8px 16px', fontSize: '0.85rem', width: 'fit-content', background: 'rgba(88, 166, 255, 0.15)', color: 'var(--accent)', border: '1px solid rgba(88, 166, 255, 0.3)' }}
              >
                公式 Faucet サイトを開く <ExternalLink size={14} style={{ marginLeft: '4px' }} />
              </a>
            </div>
          </div>

          {/* Step 2: Pool Assets */}
          <div style={{
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid var(--border-panel)',
            borderRadius: '12px',
            padding: '16px'
          }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <span style={{ 
                 background: 'var(--success)', color: 'white', width: '20px', height: '20px', 
                 borderRadius: '50%', fontSize: '0.75rem', display: 'flex', 
                 alignItems: 'center', justifyContent: 'center'
              }}>2</span>
              運用資産 (USDC / TSTA) を入手する
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.9rem', color: 'var(--text-main)', opacity: 0.9 }}>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ArrowRight size={14} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>Cetus のアプリケーションを開き、接続した後に右上の「Faucet」をクリックします。</span>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ArrowRight size={14} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>USDC や COIN_A (TSTA) を選択してリクエストしてください。</span>
              </div>
              <a 
                href="https://app.cetus.zone/lp/faucet?network=testnet" 
                target="_blank" 
                rel="noreferrer"
                className="primary-btn"
                style={{ marginTop: '8px', padding: '8px 16px', fontSize: '0.85rem', width: 'fit-content', background: 'rgba(63, 185, 80, 0.15)', color: 'var(--success)', border: '1px solid rgba(63, 185, 80, 0.3)' }}
              >
                Cetus Faucet を開く <ExternalLink size={14} style={{ marginLeft: '4px' }} />
              </a>
            </div>
          </div>

          <div style={{ 
            background: 'rgba(249, 115, 22, 0.08)',
            padding: '16px',
            borderRadius: '12px',
            border: '1px solid rgba(249, 115, 22, 0.2)',
            fontSize: '0.85rem',
            color: 'var(--text-muted)',
            display: 'flex',
            gap: '12px'
          }}>
            <Wallet size={32} color="#f97316" style={{ flexShrink: 0 }} />
            <p style={{ margin: 0 }}>
              <strong>ヒント:</strong> 資金を追加した後は、一度ボットを<strong>停止→起動</strong>して情報を更新することをお勧めします。ボットが自動で残高を検知し、監視を再開します。
            </p>
          </div>
        </div>

        <div style={{ marginTop: '32px', display: 'flex', justifyContent: 'flex-end' }}>
          <button 
            className="primary-btn" 
            onClick={onClose} 
            style={{ width: '120px' }}
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
};
