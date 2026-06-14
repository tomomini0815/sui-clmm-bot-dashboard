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
  onOpenWizard?: () => void;
  onOpenHelp?: () => void;
  config?: { lpAmountUsdc: number; rangeWidth: number; configMode?: 'auto' | 'manual'; strategyMode?: 'balanced' | 'range_order' };
  onUpdateCapital: (amount: number) => void;
  // 追加のProps
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

export const BotWalletCard: React.FC<BotWalletCardProps> = ({ 
  botAddress, 
  suiBalance, 
  usdcBalance, 
  isBotActive,
  onToggleBot,
  onOpenSettings,
  config,
  onUpdateCapital,
  bot1LpValue = 0,
  bot2LpValue = 0,
  userWalletBalanceSui = 0,
  userWalletBalanceUsdc = 0,
  connectedAddress = '',
  currentPrice = 0,
  isUnbalanced = false,
  onRebuild,
  noPanel = false
}) => {
  const [copied, setCopied] = useState(false);
  const [isEditingCapital, setIsEditingCapital] = useState(false);
  const [capitalInput, setCapitalInput] = useState('');
  
  const getSufficientStatus = (sui: number, usdc: number) => {
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

  const botStatus = getSufficientStatus(suiBalance, usdcBalance);
  const userStatus = getSufficientStatus(userWalletBalanceSui, userWalletBalanceUsdc);
  
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
    <div className={noPanel ? "" : "glass-panel"} style={{ display: 'flex', flexDirection: 'column' }}>
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
      </div>      {/* 資金の偏り警告 */}
      {isUnbalanced && (
        <div style={{
          background: 'rgba(255, 159, 67, 0.12)',
          border: '1px solid rgba(255, 159, 67, 0.35)',
          borderRadius: '12px',
          padding: '14px',
          marginBottom: '20px',
          color: '#ff9f43',
          fontSize: '0.8rem',
          fontWeight: 600,
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>⚠️ SUI/USDC 資金偏り検知</span>
          </div>
          <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 400, lineHeight: 1.4 }}>
            レンジ移動やスライドにより、ポジション間の資金バランスに大きな偏りが発生しています。流動性を均等に再配分することをお勧めします。
          </p>
          {onRebuild && (
            <button
              onClick={onRebuild}
              style={{
                alignSelf: 'flex-start',
                background: '#ff9f43',
                border: 'none',
                borderRadius: '6px',
                color: '#0d1117',
                padding: '5px 12px',
                fontSize: '0.75rem',
                fontWeight: 700,
                cursor: 'pointer',
                boxShadow: '0 2px 6px rgba(255, 159, 67, 0.3)',
                marginTop: '4px'
              }}
            >
              今すぐ資金を均等化する
            </button>
          )}
        </div>
      )}

      {/* 1.5 Connected User Wallet */}
      {connectedAddress && (
        <div style={{ 
          background: 'rgba(255, 255, 255, 0.02)', 
          borderRadius: '12px', 
          padding: '12px',
          border: '1px solid rgba(255, 255, 255, 0.05)',
          marginBottom: '20px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 6px var(--accent)' }} />
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--accent)' }}>連携中ウォレット</span>
            </div>
            <span style={{ 
              fontSize: '0.65rem', 
              color: userStatus.color, 
              fontWeight: 700,
              background: `rgba(${userStatus.color === '#2ed573' ? '46, 213, 115' : userStatus.color === '#ff9f43' ? '255, 159, 67' : '255, 71, 87'}, 0.12)`,
              padding: '2px 6px',
              borderRadius: '4px',
              border: `1px solid rgba(${userStatus.color === '#2ed573' ? '46, 213, 115' : userStatus.color === '#ff9f43' ? '255, 159, 67' : '255, 71, 87'}, 0.2)`
            }}>
              {userStatus.text}
            </span>
          </div>

          <div style={{ 
            fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'monospace', 
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            background: 'rgba(0,0,0,0.15)', padding: '6px 8px', borderRadius: '6px', marginBottom: '8px'
          }}>
            {connectedAddress}
          </div>

          {/* 連携ウォレット残高 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '0.75rem' }}>
            <div style={{ background: 'rgba(255,255,255,0.01)', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.02)' }}>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>SUI 残高</div>
              <div style={{ fontWeight: 700, color: userWalletBalanceSui < 0.2 ? '#ff4757' : 'white' }}>{userWalletBalanceSui.toFixed(2)} SUI</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.01)', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.02)' }}>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>USDC 残高</div>
              <div style={{ fontWeight: 700, color: userWalletBalanceUsdc < 0.1 ? '#ff4757' : 'white' }}>${userWalletBalanceUsdc.toFixed(2)}</div>
            </div>
          </div>
        </div>
      )}

      {/* 2. Wallet Connectivity Indicator & Address */}
      <div style={{ marginBottom: '20px' }}>
         <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
           <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
             <div style={{ 
               width: '6px', 
               height: '6px', 
               borderRadius: '50%', 
               background: botStatus.color, 
               boxShadow: `0 0 6px ${botStatus.color}` 
             }} />
             <span style={{ fontSize: '0.75rem', fontWeight: 600, color: botStatus.color }}>
               運用用ウォレット
             </span>
           </div>
           <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
             <span style={{ 
               fontSize: '0.65rem', 
               color: botStatus.color, 
               fontWeight: 700, 
               background: `rgba(${botStatus.color === '#2ed573' ? '46, 213, 115' : botStatus.color === '#ff9f43' ? '255, 159, 67' : '255, 71, 87'}, 0.12)`, 
               padding: '3px 8px', 
               borderRadius: '6px',
               border: `1px solid rgba(${botStatus.color === '#2ed573' ? '46, 213, 115' : botStatus.color === '#ff9f43' ? '255, 159, 67' : '255, 71, 87'}, 0.25)`
             }}>
               {botStatus.text}
             </span>
             {isFixedAddress && (
               <span style={{ fontSize: '0.6rem', color: 'var(--accent)', fontWeight: 800, background: 'rgba(88, 166, 255, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>MASTER</span>
             )}
           </div>
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
         {!botStatus.sufficient ? (
           <p style={{ 
             fontSize: '0.65rem', 
             color: '#ff4757', 
             marginTop: '8px', 
             lineHeight: 1.4, 
             background: 'rgba(255, 71, 87, 0.08)',
             padding: '8px',
             borderRadius: '6px',
             border: '1px solid rgba(255, 71, 87, 0.15)'
           }}>
             🚨 <strong>運用準備未完了:</strong> {
               botStatus.text === 'SUI・USDC不足' ? 'SUI（ガス代）とUSDC（流動性供給）の両方を送金してください。' :
               botStatus.text === 'SUI不足 (ガス代)' ? 'ガス代用のSUIが不足しています（最低0.2 SUI）。' :
               '運用資金用のUSDCが不足しています。'
             } ボットを開始するには、この専用アドレスに資金を送金してください。
           </p>
         ) : (
           <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '8px', lineHeight: 1.4 }}>
             💡 運用資金が検知されました。ボットを開始する準備ができています。
           </p>
         )}
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
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>設定運用資金</span>
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
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>ウォレット残高</span>
          {currentPrice > 0 && (
            <span style={{ fontSize: '0.75rem', color: 'var(--accent)', fontWeight: 700 }}>
              総ドル価値: ${((suiBalance * currentPrice) + usdcBalance).toFixed(2)}
            </span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.03)' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '4px' }}>SUI 残高</div>
            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: suiBalance < 0.2 ? '#ff4757' : 'white' }}>
              {suiBalance.toFixed(2)} <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>SUI</span>
            </div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.03)' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '4px' }}>USDC 残高</div>
            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: usdcBalance < 0.1 ? '#ff4757' : 'white' }}>
              ${usdcBalance.toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* 4.5 Capital Allocation Breakdown */}
      <div style={{ 
        background: 'rgba(255, 255, 255, 0.02)', 
        borderRadius: '12px', 
        padding: '14px',
        border: '1px solid rgba(255, 255, 255, 0.04)',
        marginBottom: '20px'
      }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '12px' }}>
          ボット別 資金配分 (LP・ウォレット余剰内訳)
        </div>
        
        {(() => {
          const walletUsdValue = (suiBalance * currentPrice) + usdcBalance;
          const totalAllocated = bot1LpValue + bot2LpValue + walletUsdValue;
          
          const pctBot1 = totalAllocated > 0 ? (bot1LpValue / totalAllocated) * 100 : 0;
          const pctBot2 = totalAllocated > 0 ? (bot2LpValue / totalAllocated) * 100 : 0;
          const pctUnused = totalAllocated > 0 ? (walletUsdValue / totalAllocated) * 100 : 0;
          
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* ビジュアル分割バー */}
              <div style={{ 
                height: '8px', 
                background: 'rgba(255,255,255,0.08)', 
                borderRadius: '4px', 
                overflow: 'hidden',
                display: 'flex'
              }}>
                {bot1LpValue > 0 && (
                  <div style={{ 
                    height: '100%', 
                    width: `${pctBot1}%`, 
                    background: 'linear-gradient(90deg, #58a6ff, #1f6feb)',
                    transition: 'width 0.3s ease' 
                  }} title={`Bot1 SUI/USDC: ${pctBot1.toFixed(1)}%`} />
                )}
                {bot2LpValue > 0 && (
                  <div style={{ 
                    height: '100%', 
                    width: `${pctBot2}%`, 
                    background: 'linear-gradient(90deg, #2ed573, #26af5f)',
                    transition: 'width 0.3s ease' 
                  }} title={`Bot2 DEEP/SUI: ${pctBot2.toFixed(1)}%`} />
                )}
                {walletUsdValue > 0 && (
                  <div style={{ 
                    height: '100%', 
                    width: `${pctUnused}%`, 
                    background: 'rgba(255,255,255,0.2)',
                    transition: 'width 0.3s ease' 
                  }} title={`Unused Wallet Value: ${pctUnused.toFixed(1)}%`} />
                )}
              </div>

              {/* ラベル内訳リスト */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#58a6ff' }} />
                    <span style={{ color: 'var(--text-main)' }}>Bot1 (SUI/USDC LP)</span>
                  </div>
                  <span style={{ fontWeight: 700, color: 'white' }}>
                    ${bot1LpValue.toFixed(2)} <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 500 }}>({pctBot1.toFixed(0)}%)</span>
                  </span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#2ed573' }} />
                    <span style={{ color: 'var(--text-main)' }}>Bot2 (DEEP/SUI LP)</span>
                  </div>
                  <span style={{ fontWeight: 700, color: 'white' }}>
                    ${bot2LpValue.toFixed(2)} <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 500 }}>({pctBot2.toFixed(0)}%)</span>
                  </span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'rgba(255,255,255,0.4)' }} />
                    <span style={{ color: 'var(--text-muted)' }}>未使用 (ウォレット残高全体)</span>
                  </div>
                  <span style={{ fontWeight: 700, color: 'var(--text-muted)' }}>
                    ${walletUsdValue.toFixed(2)} <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 500 }}>({pctUnused.toFixed(0)}%)</span>
                  </span>
                </div>

                <div style={{ 
                  marginTop: '4px', 
                  paddingTop: '6px', 
                  borderTop: '1px solid rgba(255,255,255,0.05)', 
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  fontSize: '0.75rem',
                  fontWeight: 700
                }}>
                  <span style={{ color: 'var(--text-main)' }}>合計運用資本</span>
                  <span style={{ color: 'var(--accent)' }}>${totalAllocated.toFixed(2)}</span>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* 5. Bot Execution Control (Start/Stop) - Moved to bottom */}
      <div style={{ marginTop: 'auto', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {onRebuild && (
          <button
            onClick={onRebuild}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              cursor: 'pointer',
              transition: 'all 0.2s',
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              color: 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
            }}
          >
            🔄 資金の均等化 (再配置)
          </button>
        )}
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
