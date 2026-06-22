import React, { useState } from 'react';
import { Check, Copy, Settings, Wallet } from 'lucide-react';

interface BotWalletCardProps {
  botAddress: string;
  suiBalance: number;
  usdcBalance: number;
  onRefresh: () => void;
  isBotActive: boolean;
  onToggleBot: () => void;
  onOpenSettings: () => void;
  onOpenWizard?: () => void;
  onOpenHelp?: () => void;
  config?: { lpAmountUsdc: number; rangeWidth: number; configMode?: 'auto' | 'manual'; strategyMode?: 'balanced' | 'range_order' };
  onUpdateCapital: (amount: number) => void;
  botWalletSufficient?: boolean;
  bot1LpValue?: number;
  bot2LpValue?: number;
  userWalletBalanceSui?: number;
  userWalletBalanceUsdc?: number;
  userWalletSufficient?: boolean;
  connectedAddress?: string;
  currentPrice?: number;
  isUnbalanced?: boolean;
  onRebuild?: () => void;
  noPanel?: boolean;
}

export const getSufficientStatus = (sui: number, usdc: number) => {
  if (sui < 0.2 && usdc < 0.1) {
    return { text: 'SUI・USDC不足', color: '#ff4757', sufficient: false };
  }
  if (sui < 0.2) {
    return { text: 'SUI不足 (ガス代)', color: '#ff9f43', sufficient: false };
  }
  if (usdc < 0.1) {
    return { text: 'USDC不足 (運用資金)', color: '#ff9f43', sufficient: false };
  }
  return { text: '資金十分', color: '#2ed573', sufficient: true };
};

export const BotWalletCard: React.FC<BotWalletCardProps> = ({
  botAddress,
  suiBalance,
  usdcBalance,
  isBotActive,
  onOpenSettings,
  config,
  currentPrice = 0,
  noPanel = false
}) => {
  const [copied, setCopied] = useState(false);
  const botStatus = getSufficientStatus(suiBalance, usdcBalance);
  const totalUsdValue = (suiBalance * currentPrice) + usdcBalance;

  const copyToClipboard = () => {
    if (!botAddress) return;
    navigator.clipboard.writeText(botAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={noPanel ? '' : 'glass-panel'} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <div style={{
            background: 'rgba(88, 166, 255, 0.15)',
            padding: '8px',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0
          }}>
            <Wallet size={18} color="var(--accent)" />
          </div>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>運用ウォレット</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
              <span style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: botStatus.color,
                boxShadow: `0 0 6px ${botStatus.color}`,
                flexShrink: 0
              }} />
              <span style={{ fontSize: '0.72rem', color: botStatus.color, fontWeight: 700 }}>
                {botStatus.text}
              </span>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                {isBotActive ? 'RUNNING' : 'STOPPED'}
              </span>
            </div>
          </div>
        </div>

        <button
          onClick={onOpenSettings}
          aria-label="設定を開く"
          style={{
            width: '36px',
            height: '36px',
            background: 'rgba(88, 166, 255, 0.1)',
            border: '1px solid rgba(88, 166, 255, 0.25)',
            borderRadius: '8px',
            color: 'var(--text-main)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0
          }}
        >
          <Settings size={17} />
        </button>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: '8px'
      }}>
        <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '10px' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '4px' }}>SUI</div>
          <div style={{ fontSize: '0.9rem', fontWeight: 800, color: suiBalance < 0.2 ? '#ff4757' : 'white' }}>{suiBalance.toFixed(2)}</div>
        </div>
        <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '10px' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '4px' }}>USDC</div>
          <div style={{ fontSize: '0.9rem', fontWeight: 800, color: usdcBalance < 0.1 ? '#ff4757' : 'white' }}>${usdcBalance.toFixed(2)}</div>
        </div>
        <div style={{ background: 'rgba(88,166,255,0.06)', border: '1px solid rgba(88,166,255,0.14)', borderRadius: '10px', padding: '10px' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '4px' }}>LP設定</div>
          <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--accent)' }}>{config?.lpAmountUsdc ?? 0}</div>
        </div>
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: 'rgba(0,0,0,0.16)',
        border: '1px solid rgba(255,255,255,0.04)',
        borderRadius: '8px',
        padding: '9px 10px'
      }}>
        <code style={{
          flex: 1,
          minWidth: 0,
          color: 'var(--text-muted)',
          fontSize: '0.72rem',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}>
          {botAddress || 'ウォレット未生成'}
        </code>
        <button
          onClick={copyToClipboard}
          disabled={!botAddress}
          aria-label="ウォレットアドレスをコピー"
          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: botAddress ? 'pointer' : 'not-allowed', display: 'flex' }}
        >
          {copied ? <Check size={14} color="#2ed573" /> : <Copy size={14} />}
        </button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        <span>詳細な資金配分と操作は設定内に移動しました。</span>
        {currentPrice > 0 && <strong style={{ color: 'var(--accent)' }}>${totalUsdValue.toFixed(2)}</strong>}
      </div>
    </div>
  );
};
