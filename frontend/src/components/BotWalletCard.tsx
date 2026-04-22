import React, { useState } from 'react';
import { Copy, Check, Settings, Edit3, Play, Square } from 'lucide-react';

interface BotWalletCardProps {
  botAddress: string;
  suiBalance: number;
  usdcBalance: number;
  onRefresh: () => void;
  isBotActive: boolean;
  onToggleBot: () => void;
  onOpenSettings: () => void;
  onOpenWizard: () => void;
  onOpenHelp: () => void;
  config?: { lpAmountUsdc: number; rangeWidth: number; configMode?: 'auto' | 'manual'; strategyMode?: 'balanced' | 'range_order' };
  onUpdateCapital: (amount: number) => void;
}

export const BotWalletCard: React.FC<BotWalletCardProps> = ({ 
  botAddress, 
  suiBalance, 
  usdcBalance, 
  isBotActive,
  onToggleBot,
  onOpenSettings,
  config,
  onUpdateCapital
}) => {
  const [copied, setCopied] = useState(false);
  const [isEditingCapital, setIsEditingCapital] = useState(false);
  const [capitalInput, setCapitalInput] = useState('');
  
  const handleEditCapital = () => {
    setCapitalInput(String(config?.lpAmountUsdc || 0));
    setIsEditingCapital(true);
  };

  const handleSaveCapital = () => {
    const val = parseFloat(capitalInput);
    if (!isNaN(val) && val > 0) {
      onUpdateCapital(val);
      setIsEditingCapital(false);
    }
  };

  const handleCancelCapital = () => {
    setIsEditingCapital(false);
    setCapitalInput('');
  };
  
  const isFixedAddress = botAddress.toLowerCase() === '0xc17e3ef45cfb8ff6f0d5e55669b148fc27e615e2bde27109ccf3e952d1215559'.toLowerCase();

  const copyToClipboard = () => {
    navigator.clipboard.writeText(botAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="glass-panel" style={{ marginBottom: '24px', display: 'flex', flexDirection: 'column' }}>
      {/* 1. Header: Bot Management + Settings Button */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingBottom: '16px', borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
        marginBottom: '20px', gap: '8px', flexWrap: 'wrap'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '130px' }}>
          <div style={{
            background: 'rgba(88, 166, 255, 0.15)', padding: '6px', borderRadius: '8px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
          }}>
            <Settings size={18} color="var(--accent)" />
          </div>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0, whiteSpace: 'nowrap' }}>Bot管理</h3>
        </div>
        <button
          onClick={onOpenSettings}
          style={{
            background: 'rgba(88, 166, 255, 0.1)', border: '1px solid rgba(88, 166, 255, 0.25)',
            borderRadius: '6px', padding: '5px 10px', color: 'var(--text-main)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
            fontSize: '0.8rem', fontWeight: 500, whiteSpace: 'nowrap'
          }}
        >
          <Edit3 size={14} /> 設定
        </button>
      </div>

      {/* 2. Wallet Connectivity Indicator & Address */}
      <div style={{ marginBottom: '20px' }}>
         <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
           <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
             <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#2ed573', boxShadow: '0 0 6px #2ed573' }} />
             <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#2ed573' }}>運用用ウォレット</span>
           </div>
           {isFixedAddress && (
             <span style={{ fontSize: '0.6rem', color: 'var(--accent)', fontWeight: 800, background: 'rgba(88, 166, 255, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>MASTER</span>
           )}
         </div>
         <div style={{ 
           background: 'rgba(255, 255, 255, 0.03)', 
           padding: '10px', 
           borderRadius: '8px', 
           display: 'flex', 
           alignItems: 'center', 
           gap: '8px',
           border: '1px solid rgba(255, 255, 255, 0.05)'
         }}>
           <div style={{ 
             fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'monospace', 
             overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 
           }}>
             {botAddress}
           </div>
           <button 
             onClick={copyToClipboard}
             style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', flexShrink: 0 }}
           >
             {copied ? <Check size={14} color="#2ed573" /> : <Copy size={14} />}
           </button>
         </div>
      </div>

      {/* 3. Operational Capital Setting */}
      <div style={{ 
        background: 'rgba(255, 255, 255, 0.03)', 
        borderRadius: '12px', 
        padding: '16px',
        border: '1px solid rgba(255, 255, 255, 0.05)',
        marginBottom: '20px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>運用資金</span>
          {!isEditingCapital ? (
            <button onClick={handleEditCapital} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 600 }}>変更</button>
          ) : (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={handleSaveCapital} style={{ background: 'transparent', border: 'none', color: '#2ed573', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 600 }}>保存</button>
              <button onClick={handleCancelCapital} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 600 }}>戻る</button>
            </div>
          )}
        </div>

        {isEditingCapital ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input 
              type="number"
              value={capitalInput}
              onChange={(e) => setCapitalInput(e.target.value)}
              style={{ 
                background: 'rgba(0,0,0,0.2)', border: '1px solid var(--accent)', color: 'white', 
                borderRadius: '6px', padding: '8px 12px', fontSize: '1rem', width: '100%', outline: 'none'
              }}
              autoFocus
            />
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
            <span style={{ fontSize: '1.5rem', fontWeight: 800, color: 'white' }}>{config?.lpAmountUsdc || 0}</span>
            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)' }}>USDC</span>
          </div>
        )}
      </div>

      {/* 4. Wallet Balance Summary (Compact) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
        <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.03)' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '4px' }}>SUI Balance</div>
          <div style={{ fontSize: '0.9rem', fontWeight: 700 }}>{suiBalance.toFixed(2)} <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>SUI</span></div>
        </div>
        <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.03)' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '4px' }}>USDC Balance</div>
          <div style={{ fontSize: '0.9rem', fontWeight: 700 }}>${usdcBalance.toFixed(2)}</div>
        </div>
      </div>

      {/* 5. Bot Execution Control (Start/Stop) - Moved to bottom */}
      <div style={{ marginTop: 'auto', paddingTop: '10px' }}>
        <button
          onClick={onToggleBot}
          style={{
            width: '100%',
            padding: '12px',
            borderRadius: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            cursor: 'pointer',
            transition: 'all 0.2s',
            background: isBotActive ? 'rgba(248, 81, 73, 0.15)' : 'var(--accent)',
            color: isBotActive ? 'var(--danger)' : 'white',
            fontWeight: 700,
            fontSize: '1rem',
            boxShadow: isBotActive ? 'none' : '0 4px 12px rgba(88, 166, 255, 0.3)',
            border: isBotActive ? '1px solid rgba(248, 81, 73, 0.3)' : 'none'
          }}
        >
          {isBotActive ? (
            <>
              <Square size={18} fill="currentColor" />
              Botを停止する
            </>
          ) : (
            <>
              <Play size={18} fill="currentColor" />
              Botを開始する
            </>
          )}
        </button>
      </div>
    </div>
  );
};
