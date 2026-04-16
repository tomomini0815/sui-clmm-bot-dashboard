import React, { useState } from 'react';
import { X, ExternalLink, Droplets, Wallet, ArrowRight, Globe, TestTube } from 'lucide-react';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HelpModal: React.FC<HelpModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'testnet' | 'mainnet'>('testnet');

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="glass-panel modal-content" style={{ maxWidth: '600px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
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

        {/* Network Tabs */}
        <div style={{
          display: 'flex',
          gap: '8px',
          marginBottom: '20px',
          padding: '4px',
          background: 'rgba(255, 255, 255, 0.03)',
          borderRadius: '12px',
          border: '1px solid var(--border-panel)'
        }}>
          <button
            onClick={() => setActiveTab('testnet')}
            style={{
              flex: 1,
              padding: '10px 16px',
              borderRadius: '8px',
              border: 'none',
              background: activeTab === 'testnet' ? 'rgba(88, 166, 255, 0.15)' : 'transparent',
              color: activeTab === 'testnet' ? 'var(--accent)' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.9rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              transition: 'all 0.2s ease'
            }}
          >
            <TestTube size={16} />
            テストネット
          </button>
          <button
            onClick={() => setActiveTab('mainnet')}
            style={{
              flex: 1,
              padding: '10px 16px',
              borderRadius: '8px',
              border: 'none',
              background: activeTab === 'mainnet' ? 'rgba(63, 185, 80, 0.15)' : 'transparent',
              color: activeTab === 'mainnet' ? 'var(--success)' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.9rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              transition: 'all 0.2s ease'
            }}
          >
            <Globe size={16} />
            メインネット
          </button>
        </div>

        {/* Testnet Content */}
        {activeTab === 'testnet' && (
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
        )}

        {/* Mainnet Content */}
        {activeTab === 'mainnet' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', lineHeight: 1.6 }}>
            メインネットでボットを稼働させるには、実際のSUIとUSDCが必要です。以下の方法で資金を準備してください。
          </p>

          {/* Step 1: Buy SUI */}
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
              SUI を購入する
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.9rem', color: 'var(--text-main)', opacity: 0.9 }}>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ArrowRight size={14} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>国内外の取引所でSUIを購入し、Sui Walletに送金してください。</span>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ArrowRight size={14} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>推奨取引所: Binance, Bybit, OKX, Crypto.com など</span>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ArrowRight size={14} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>ガス代として最低 1-2 SUI を推奨（余裕を持って 5 SUI 以上を推奨）</span>
              </div>
              <a 
                href="https://wallet.sui.io/" 
                target="_blank" 
                rel="noreferrer"
                className="primary-btn"
                style={{ marginTop: '8px', padding: '8px 16px', fontSize: '0.85rem', width: 'fit-content', background: 'rgba(88, 166, 255, 0.15)', color: 'var(--accent)', border: '1px solid rgba(88, 166, 255, 0.3)' }}
              >
                Sui Wallet を開く <ExternalLink size={14} style={{ marginLeft: '4px' }} />
              </a>
            </div>
          </div>

          {/* Step 2: Buy USDC */}
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
              USDC を準備する
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.9rem', color: 'var(--text-main)', opacity: 0.9 }}>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ArrowRight size={14} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>取引所でUSDCを購入し、Suiネットワーク経由でウォレットに送金してください。</span>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ArrowRight size={14} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>または、Cetus DEXで他の資産からスワップしてください。</span>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ArrowRight size={14} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>最低運用資金: 50 USDC 以上を推奨</span>
              </div>
              <a 
                href="https://app.cetus.zone/swap" 
                target="_blank" 
                rel="noreferrer"
                className="primary-btn"
                style={{ marginTop: '8px', padding: '8px 16px', fontSize: '0.85rem', width: 'fit-content', background: 'rgba(63, 185, 80, 0.15)', color: 'var(--success)', border: '1px solid rgba(63, 185, 80, 0.3)' }}
              >
                Cetus DEX でスワップ <ExternalLink size={14} style={{ marginLeft: '4px' }} />
              </a>
            </div>
          </div>

          {/* Step 3: Important Notes */}
          <div style={{
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid var(--border-panel)',
            borderRadius: '12px',
            padding: '16px'
          }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <span style={{ 
                 background: '#f97316', color: 'white', width: '20px', height: '20px', 
                 borderRadius: '50%', fontSize: '0.75rem', display: 'flex', 
                 alignItems: 'center', justifyContent: 'center'
              }}>3</span>
              注意事項
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.9rem', color: 'var(--text-main)', opacity: 0.9 }}>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ArrowRight size={14} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>メインネットでは実際の資産が使用されるため、リスク管理を徹底してください。</span>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ArrowRight size={14} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>最初は少額から開始し、ボットの動作を確認してから資金を増やすことを推奨します。</span>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ArrowRight size={14} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>ガス代として常に十分なSUI残高を維持してください（最低 1 SUI 以上）。</span>
              </div>
            </div>
          </div>

          <div style={{ 
            background: 'rgba(248, 81, 73, 0.08)',
            padding: '16px',
            borderRadius: '12px',
            border: '1px solid rgba(248, 81, 73, 0.2)',
            fontSize: '0.85rem',
            color: 'var(--text-muted)',
            display: 'flex',
            gap: '12px'
          }}>
            <Wallet size={32} color="#f85149" style={{ flexShrink: 0 }} />
            <div>
              <p style={{ margin: 0, fontWeight: 600, color: 'var(--danger)', marginBottom: '8px' }}>
                ⚠️ 自己責任について
              </p>
              <p style={{ margin: 0 }}>
                メインネットでの取引は<strong>すべて自己責任</strong>となります。ボットは自動化ツールであり、損失を保証するものではありません。投資する金額は、失っても許容できる範囲にしてください。
              </p>
            </div>
          </div>
        </div>
        )}

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
