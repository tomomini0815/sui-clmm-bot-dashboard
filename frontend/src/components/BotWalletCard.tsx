import React, { useState } from 'react';
import { Wallet, Copy, Check } from 'lucide-react';

interface BotWalletCardProps {
  botAddress: string;
  suiBalance: number;
  usdcBalance: number;
  onRefresh: () => void;
}

export const BotWalletCard: React.FC<BotWalletCardProps> = ({ botAddress, suiBalance, usdcBalance, onRefresh }) => {
  const [copied, setCopied] = useState(false);
  
  // 固定アドレス判定
  const isFixedAddress = botAddress.toLowerCase() === '0xc17e3ef45cfb8ff6f0d5e55669b148fc27e615e2bde27109ccf3e952d1215559'.toLowerCase();
  

  const copyToClipboard = () => {
    navigator.clipboard.writeText(botAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const needsSui = suiBalance < 0.05;
  const needsUsdc = usdcBalance < 0.01;

  return (
    <div className="card-premium" style={{ marginBottom: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ 
            background: 'rgba(88, 166, 255, 0.1)', 
            padding: '8px', 
            borderRadius: '10px',
            color: 'var(--accent)'
          }}>
            <Wallet size={20} />
          </div>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>専用運用ウォレット</h3>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {isFixedAddress && (
            <div style={{ 
              background: 'rgba(88, 166, 255, 0.2)', 
              color: 'var(--accent)',
              padding: '4px 8px',
              borderRadius: '6px',
              fontSize: '0.65rem',
              fontWeight: 800,
              border: '1px solid var(--accent)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em'
            }}>
              MASTER FIXED
            </div>
          )}
          <div style={{ 
            background: needsSui ? 'rgba(255, 71, 87, 0.1)' : 'rgba(46, 213, 115, 0.1)',
            color: needsSui ? '#ff4757' : '#2ed573',
            padding: '4px 12px',
            borderRadius: '20px',
            fontSize: '0.75rem',
            fontWeight: 600
          }}>
            {needsSui ? '入金が必要です' : '運用可能'}
          </div>
        </div>
      </div>

      <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.5 }}>
        このセッション専用のウォレットです。ボットが自動運用するためには、このアドレスに少額の資金を移動してください。
      </p>

      {/* アドレス表示・コピー */}
      <div style={{ 
        background: 'rgba(255, 255, 255, 0.03)', 
        padding: '12px', 
        borderRadius: '12px', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between',
        marginBottom: '20px',
        border: '1px solid rgba(255, 255, 255, 0.05)'
      }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.8rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          {botAddress}
        </div>
        <button 
          onClick={copyToClipboard}
          className="btn-icon"
          title="コピー"
        >
          {copied ? <Check size={14} color="#2ed573" /> : <Copy size={14} />}
        </button>
      </div>

      {/* 残高表示 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
        <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '12px', borderRadius: '12px' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px' }}>SUI 残高</div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: needsSui ? '#ff4757' : 'inherit' }}>
            {suiBalance.toFixed(4)} <span style={{ fontSize: '0.7rem', fontWeight: 400 }}>SUI</span>
          </div>
        </div>
        <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '12px', borderRadius: '12px' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px' }}>USDC 残高</div>
          <div style={{ fontSize: '1rem', fontWeight: 700 }}>
            {usdcBalance.toFixed(2)} <span style={{ fontSize: '0.7rem', fontWeight: 400 }}>USDC</span>
          </div>
        </div>
      </div>

    </div>
  );
};
