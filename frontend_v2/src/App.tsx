import { useState, useEffect } from 'react';
import { Activity, DollarSign, Repeat, ShieldCheck, PowerOff, TrendingUp, BarChart3, Wallet } from 'lucide-react';
import { StatCard } from './components/StatCard';
import { PriceChart } from './components/PriceChart';
import { ConfigPanel } from './components/ConfigPanel';
import { SettingsModal } from './components/SettingsModal';
import { ActivityLog } from './components/ActivityLog';
import { SetupWizard } from './components/SetupWizard';

function App() {
  const [isBotActive, setIsBotActive] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(() => !localStorage.getItem('wizard_completed'));

  // グローバルなフォーム状態（ウィザードと設定間での同期用）
  const [privateKey, setPrivateKey] = useState('');
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem('api_url_v2') || 'http://localhost:3002');

  // リアルタイム統計情報
  const [stats, setStats] = useState({
    totalPnl: '0.00',
    totalFees: '0.0000',
    totalRebalances: 0,
    priceHistory: [] as any[],
    activityLogs: [] as any[],
    currentRange: { lower: 0, upper: 0 },
    config: { lpAmountUsdc: 0, rangeWidth: 0, hedgeRatio: 0 },
    // 追加のメトリクス
    currentPrice: 0,
    entryPrice: 0,
    positionSize: 0,
    dailyPnl: '0.00',
    winRate: '0',
    avgHoldingTime: '0分',
    marketCondition: 'sideways',
    pythPrice: null as number | null // Pyth市場価格
  });
  
  // Pyth価格履歴
  const [pythPriceHistory, setPythPriceHistory] = useState<any[]>([]);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await fetch(`${apiUrl}/api/stats`);
        const result = await response.json();
        if (result.success) {
          setStats(result.data);
          setIsBotActive(result.data.isRunning);
          
          // Pyth価格履歴を更新
          if (result.data.pythPrice && result.data.priceHistory) {
            const now = new Date();
            const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
            
            setPythPriceHistory(prev => {
              const newHistory = [...prev, { time: timeStr, price: result.data.pythPrice }];
              // 最新60件を保持
              if (newHistory.length > 60) {
                return newHistory.slice(-60);
              }
              return newHistory;
            });
          }
        }
      } catch (e) {
        console.warn('Real-time stats sync failed (Standard behavior for first launch)');
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 3000); // 3秒ごとに更新
    return () => clearInterval(interval);
  }, [apiUrl]);

  const toggleBotState = async () => {
    try {
      const endpoint = isBotActive ? '/api/stop' : '/api/start';
      const response = await fetch(`${apiUrl}${endpoint}`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        setIsBotActive(!isBotActive);
      }
    } catch (e) {
      console.error('Failed to communicate with bot backend', e);
      alert('Network Error: Make sure your backend API is running at ' + apiUrl);
    }
  };

  // 市場状況の日本語変換
  const getMarketConditionText = (condition: string) => {
    switch(condition) {
      case 'uptrend': return '📈 上昇トレンド';
      case 'downtrend': return '📉 下落トレンド';
      default: return '➡️ レンジ相場';
    }
  };

  // 現在の損益状況
  const currentPrice = stats.currentPrice || 0;
  const entryPrice = stats.entryPrice || 0;
  const priceChange = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice * 100) : 0;

  return (
    <div className="dashboard-container">
      <header className="header">
        <div>
          <h1>
            <span style={{ 
              background: 'linear-gradient(135deg, #58a6ff 0%, #3fb950 100%)', 
              WebkitBackgroundClip: 'text', 
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text'
            }}>
              SUI Liquidity Bot
            </span>
          </h1>
          <p style={{ color: 'var(--text-muted)', marginTop: '6px', fontSize: '0.95rem' }}>
            Advanced Trailing Stop Strategy • V2.0
          </p>
        </div>
        <div className={`badge ${isBotActive ? 'animate-pulse-slow' : ''}`} style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '8px',
          borderColor: isBotActive ? 'rgba(63, 185, 80, 0.3)' : 'rgba(139, 148, 158, 0.25)',
          color: isBotActive ? 'var(--success)' : 'var(--text-muted)',
          background: isBotActive ? 'rgba(63, 185, 80, 0.12)' : 'rgba(139, 148, 158, 0.08)',
          padding: '8px 14px',
          fontSize: '0.85rem'
        }}>
          {isBotActive ? (
            <>
              <span style={{ 
                width: '8px', 
                height: '8px', 
                borderRadius: '50%', 
                background: 'var(--success)', 
                display: 'inline-block',
                boxShadow: '0 0 8px var(--success)',
                animation: 'pulse-slow 2s infinite'
              }}></span>
              稼働中
            </>
          ) : (
            <>
              <PowerOff size={14} />
              待機中
            </>
          )}
        </div>
      </header>

      <div className="dashboard-grid">
        <aside style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <ConfigPanel 
            isBotActive={isBotActive} 
            onToggleBot={toggleBotState} 
            onOpenSettings={() => setIsSettingsOpen(true)}
            onOpenWizard={() => setIsWizardOpen(true)}
            config={stats.config}
          />
          
          {/* 市場状況パネル */}
          <div className="glass-panel" style={{
            background: 'rgba(22, 27, 34, 0.9)',
            borderColor: 'rgba(88, 166, 255, 0.2)'
          }}>
            <h3 style={{ 
              fontSize: '0.95rem', 
              marginBottom: '14px', 
              display: 'flex', 
              alignItems: 'center', 
              gap: '8px',
              fontWeight: 600
            }}>
              <BarChart3 size={16} color="var(--accent)" />
              市場分析
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ 
                padding: '10px',
                background: 'rgba(255, 255, 255, 0.03)',
                borderRadius: '8px',
                border: '1px solid var(--border-panel)'
              }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '4px' }}>市場状況</div>
                <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                  {getMarketConditionText(stats.marketCondition)}
                </div>
              </div>
              <div style={{ 
                padding: '10px',
                background: 'rgba(255, 255, 255, 0.03)',
                borderRadius: '8px',
                border: '1px solid var(--border-panel)'
              }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '4px' }}>現在価格 / エントリー価格</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{currentPrice.toFixed(4)} USDC</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>→ {entryPrice.toFixed(4)} USDC</span>
                </div>
                {entryPrice > 0 && (
                  <div style={{ 
                    marginTop: '6px',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: priceChange >= 0 ? 'var(--success)' : 'var(--danger)'
                  }}>
                    {priceChange >= 0 ? '↑' : '↓'} {Math.abs(priceChange).toFixed(2)}%
                  </div>
                )}
              </div>
              
              {/* Pyth市場価格 */}
              {stats.pythPrice && (
                <div style={{ 
                  padding: '10px',
                  background: 'rgba(88, 166, 255, 0.08)',
                  borderRadius: '8px',
                  border: '1px solid rgba(88, 166, 255, 0.3)'
                }}>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '4px' }}>
                    SUI 市場価格 (Pyth Oracle)
                  </div>
                  <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--accent)' }}>
                    ${stats.pythPrice.toFixed(4)}
                  </div>
                  <div style={{ 
                    marginTop: '4px',
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    display: 'flex',
                    justifyContent: 'space-between'
                  }}>
                    <span>プール価格: ${currentPrice.toFixed(4)}</span>
                    {stats.pythPrice !== currentPrice && (
                      <span style={{ 
                        color: Math.abs(stats.pythPrice - currentPrice) / currentPrice > 0.02 ? '#f97316' : 'var(--success)'
                      }}>
                        乖離: {((Math.abs(stats.pythPrice - currentPrice) / currentPrice) * 100).toFixed(2)}%
                      </span>
                    )}
                  </div>
                </div>
              )}
              <div style={{ 
                padding: '10px',
                background: 'rgba(255, 255, 255, 0.03)',
                borderRadius: '8px',
                border: '1px solid var(--border-panel)'
              }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '4px' }}>現在のレンジ</div>
                <div style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>下限:</span>
                    <strong style={{ color: 'var(--danger)' }}>{stats.currentRange.lower.toFixed(4)}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>上限:</span>
                    <strong style={{ color: 'var(--success)' }}>{stats.currentRange.upper.toFixed(4)}</strong>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <main>
          {/* 統計カード - 6枚に拡張 */}
          <div className="stats-grid" style={{ 
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            marginBottom: '20px'
          }}>
            <StatCard 
              title="累計利益 (P&L)" 
              value={`$${stats.totalPnl}`} 
              trend={parseFloat(stats.totalPnl) >= 0 ? "up" : "down"} 
              icon={<DollarSign size={18} />} 
              subtitle={`手数料: ${stats.totalFees} USDC`}
              change={stats.dailyPnl !== '0.00' ? `${stats.dailyPnl}%` : undefined}
            />
            <StatCard 
              title="リバランス回数" 
              value={stats.totalRebalances.toString()} 
              icon={<Repeat size={18} />} 
              subtitle="自動再配置"
              change={`${stats.avgHoldingTime}`}
            />
            <StatCard 
              title="勝率" 
              value={`${stats.winRate}%`} 
              trend={parseFloat(stats.winRate) >= 50 ? "up" : "down"}
              icon={<TrendingUp size={18} />} 
              subtitle="利益確定確率"
            />
            <StatCard 
              title="ポジション規模" 
              value={`${stats.positionSize || stats.config.lpAmountUsdc} USDC`} 
              icon={<Wallet size={18} />} 
              subtitle="運用資金"
            />
            <StatCard 
              title="現在の状態" 
              value={isBotActive ? "運用中" : "停止中"} 
              icon={<Activity size={18} color={isBotActive ? "var(--accent)" : "var(--text-muted)"} />} 
              subtitle={isBotActive ? "手数料収集中" : "Startボタンで開始"}
            />
            <StatCard 
              title="市場状況" 
              value={getMarketConditionText(stats.marketCondition).split(' ')[0]} 
              icon={<BarChart3 size={18} />} 
              subtitle={getMarketConditionText(stats.marketCondition).split(' ').slice(1).join(' ')}
            />
          </div>

          <PriceChart 
            data={stats.priceHistory} 
            pythData={pythPriceHistory}
            lowerBound={stats.currentRange.lower} 
            upperBound={stats.currentRange.upper} 
          />
          
          <ActivityLog logs={stats.activityLogs} />
        </main>
      </div>

      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
        privateKey={privateKey}
        setPrivateKey={setPrivateKey}
        apiUrl={apiUrl}
        setApiUrl={(val) => {
          setApiUrl(val);
          localStorage.setItem('api_url_v2', val);
        }}
      />
      <SetupWizard 
        isOpen={isWizardOpen} 
        onComplete={() => {
          localStorage.setItem('wizard_completed', 'true');
          setIsWizardOpen(false);
        }} 
        privateKey={privateKey}
        setPrivateKey={setPrivateKey}
        apiUrl={apiUrl}
      />
    </div>
  );
}

export default App;
