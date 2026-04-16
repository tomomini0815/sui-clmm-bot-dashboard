import { useState, useEffect } from 'react';
import { Activity, DollarSign, Repeat, PowerOff, TrendingUp, BarChart3, Wallet } from 'lucide-react';
import { StatCard } from './components/StatCard';
import { PriceChart } from './components/PriceChart';
import { ConfigPanel } from './components/ConfigPanel';
import { SettingsModal } from './components/SettingsModal';
import { ActivityLog } from './components/ActivityLog';
import { SetupWizard } from './components/SetupWizard';
import { HelpModal } from './components/HelpModal';
import { PnLCard } from './components/PnLCard';
import { DeltaGauge } from './components/DeltaGauge';
import { ConnectButton, useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';

function App() {
  const currentAccount = useCurrentAccount();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();
  
  const [isBotActive, setIsBotActive] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(() => !localStorage.getItem('wizard_completed'));

  const [sessionId, setSessionId] = useState(() => 
    localStorage.getItem('session_id') || ''
  );
  const [apiUrl] = useState(() => 
    import.meta.env.PROD ? 'https://sui-clmm-bot-backend.fly.dev' : 'http://localhost:3002'
  );

  // ウォレット接続時にセッション作成
  useEffect(() => {
    if (currentAccount && !sessionId) {
      createSessionFromWallet();
    }
  }, [currentAccount]);

  const createSessionFromWallet = async () => {
    if (!currentAccount) return;
    
    try {
      // ウォレットアドレスでセッションを作成
      const response = await fetch(`${apiUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          walletAddress: currentAccount.address,
          isWalletConnect: true 
        })
      });
      const data = await response.json();
      
      if (data.success) {
        setSessionId(data.sessionId);
        localStorage.setItem('session_id', data.sessionId);
        localStorage.setItem('wizard_completed', 'true');
        setIsWizardOpen(false);
      }
    } catch (e) {
      console.error('Failed to create session:', e);
    }
  };

  const [stats, setStats] = useState({
    totalPnl: '0.00',
    totalFees: '0.0000',
    totalRebalances: 0,
    activityLogs: [] as any[],
    currentRange: { lower: 0, upper: 0 },
    config: { lpAmountUsdc: 0, rangeWidth: 0, hedgeRatio: 0 },
    currentPrice: 0,
    entryPrice: 0,
    positionSize: 0,
    dailyPnl: '0.00',
    winRate: '0',
    avgHoldingTime: '0分',
    marketCondition: 'sideways',
    pythPrice: null as number | null,
    // 新データ
    pnl: null as any,
    delta: null as any,
    gasStats: null as any,
    hedge: null as any,
    indicators: null as any,
  });

  // pool価格とPyth価格をフロント側でポーリングごとに同時記録
  const [combinedHistory, setCombinedHistory] = useState<
    { time: string; poolPrice: number; pythPrice: number | null }[]
  >([]);

  useEffect(() => {
    const fetchStats = async () => {
      if (!sessionId) return;
      
      try {
        const response = await fetch(`${apiUrl}/api/stats?sessionId=${sessionId}`);
        const result = await response.json();
        if (result.success) {
          setStats(result.data);
          setIsBotActive(result.data.isRunning);

          const poolHistory: { time: string; price: number }[] = result.data.priceHistory || [];
          const latestPool = poolHistory.length > 0 ? poolHistory[poolHistory.length - 1] : null;
          const latestPyth: number | null = result.data.pythPrice ?? null;

          if (latestPool) {
            setCombinedHistory(prev => {
              const exists = prev.find(e => e.time === latestPool.time);
              if (exists) {
                return prev.map(e =>
                  e.time === latestPool.time
                    ? { ...e, poolPrice: latestPool.price, pythPrice: latestPyth ?? e.pythPrice }
                    : e
                );
              }
              const newEntry = {
                time: latestPool.time,
                poolPrice: latestPool.price,
                pythPrice: latestPyth,
              };
              const updated = [...prev, newEntry];
              return updated.length > 120 ? updated.slice(-120) : updated;
            });
          }
        }
      } catch (e) {
        console.warn('Real-time stats sync failed (Standard behavior for first launch)');
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 3000);
    return () => clearInterval(interval);
  }, [apiUrl]);

  const toggleBotState = async () => {
    if (!sessionId) return;
    
    try {
      const endpoint = isBotActive ? '/api/stop' : '/api/start';
      const response = await fetch(`${apiUrl}${endpoint}`, { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      const data = await response.json();
      if (data.success) {
        setIsBotActive(!isBotActive);
      }
    } catch (e) {
      console.error('Failed to communicate with bot backend', e);
      alert('Network Error: Make sure your backend API is running at ' + apiUrl);
    }
  };

  const handleUpdateCapital = async (newAmount: number) => {
    try {
      const response = await fetch(`${apiUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lpAmountUsdc: newAmount,
          rangeWidth: (stats.config.rangeWidth * 100).toString(),
          hedgeRatio: (stats.config.hedgeRatio * 100).toString(),
        }),
      });
      const data = await response.json();
      if (data.success) {
        setStats(prev => ({ ...prev, config: { ...prev.config, lpAmountUsdc: newAmount } }));
        alert(`✅ 運用資金を ${newAmount} USDC に更新しました`);
      }
    } catch (e) {
      alert('更新に失敗しました。バックエンドが起動中か確認してください。');
    }
  };

  const getMarketConditionText = (condition: string) => {
    switch (condition) {
      case 'uptrend': return '📈 上昇トレンド';
      case 'downtrend': return '📉 下落トレンド';
      default: return '➡️ レンジ相場';
    }
  };

  const currentPrice = stats.currentPrice || 0;
  const entryPrice = stats.entryPrice || 0;
  const priceChange = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice * 100) : 0;

  // PnLデータが利用可能か
  const netPnl = stats.pnl?.netPnl ?? 0;
  const apr = stats.pnl?.apr ?? 0;

  return (
    <div className="dashboard-container">
      <header className="header">
        <div className="header-title-section">
          <h1>
            <span className="gradient-text">
              SUI Liquidity Bot
            </span>
          </h1>
          <p className="header-subtitle">
            Delta-Neutral Profit Engine • V3.0
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
                width: '8px', height: '8px', borderRadius: '50%',
                background: 'var(--success)', display: 'inline-block',
                boxShadow: '0 0 8px var(--success)', animation: 'pulse-slow 2s infinite'
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
        <aside className="sidebar-aside">
          <ConfigPanel
            isBotActive={isBotActive}
            onToggleBot={toggleBotState}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onOpenWizard={() => setIsWizardOpen(true)}
            onOpenHelp={() => setIsHelpOpen(true)}
            config={stats.config}
            onUpdateCapital={handleUpdateCapital}
          />

          {/* PnLカード */}
          <PnLCard pnl={stats.pnl} gasStats={stats.gasStats} />

          {/* デルタゲージ */}
          <DeltaGauge delta={stats.delta} hedge={stats.hedge} indicators={stats.indicators} />
        </aside>

        <main className="main-content">
          <div className="stats-grid stats-grid-main">
            <StatCard
              title="純利益 (Net P&L)"
              value={`$${netPnl.toFixed(4)}`}
              trend={netPnl >= 0 ? "up" : "down"}
              icon={<DollarSign size={18} />}
              subtitle={`手数料: $${stats.pnl?.fees?.toFixed(4) || '0.0000'}`}
              change={apr !== 0 ? `APR ${apr.toFixed(1)}%` : undefined}
            />
            <StatCard title="リバランス回数" value={stats.totalRebalances.toString()} icon={<Repeat size={18} />} subtitle="自動再配置" change={`${stats.avgHoldingTime}`} />
            <StatCard title="勝率" value={`${stats.winRate}%`} trend={parseFloat(stats.winRate) >= 50 ? "up" : "down"} icon={<TrendingUp size={18} />} subtitle="利益確定確率" />
            <StatCard title="ポジション規模" value={`${stats.positionSize || stats.config.lpAmountUsdc} USDC`} icon={<Wallet size={18} />} subtitle="運用資金" />
            <StatCard title="Bot状態" value={isBotActive ? "運用中" : "停止中"} icon={<Activity size={18} color={isBotActive ? "var(--accent)" : "var(--text-muted)"} />} subtitle={isBotActive ? "手数料収集中" : "Startで開始"} />
            <StatCard title="市場状況" value={getMarketConditionText(stats.marketCondition).split(' ')[0]} icon={<BarChart3 size={18} />} subtitle={getMarketConditionText(stats.marketCondition).split(' ').slice(1).join(' ')} />
          </div>

          {/* 市場分析パネル（メインエリアに移動） */}
          <div className="glass-panel market-analysis-panel market-panel-main">
            <h3 style={{ fontSize: '0.95rem', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
              <BarChart3 size={16} color="var(--accent)" />
              市場分析
            </h3>
            <div className="market-analysis-grid">
              <div className="market-analysis-item">
                <div className="market-analysis-label">現在価格</div>
                <div className="market-analysis-value">${currentPrice.toFixed(4)}</div>
                {entryPrice > 0 && (
                  <div className="market-analysis-change" style={{ color: priceChange >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {priceChange >= 0 ? '↑' : '↓'} {Math.abs(priceChange).toFixed(2)}%
                  </div>
                )}
              </div>
              {stats.pythPrice && (
                <div className="market-analysis-item">
                  <div className="market-analysis-label">Pyth Oracle</div>
                  <div className="market-analysis-value" style={{ color: 'var(--accent)' }}>${stats.pythPrice.toFixed(4)}</div>
                  <div className="market-analysis-change" style={{
                    color: Math.abs(stats.pythPrice - currentPrice) / currentPrice > 0.02 ? '#f97316' : 'var(--success)'
                  }}>
                    乖離: {((Math.abs(stats.pythPrice - currentPrice) / (currentPrice || 1)) * 100).toFixed(2)}%
                  </div>
                </div>
              )}
              <div className="market-analysis-item">
                <div className="market-analysis-label">レンジ下限</div>
                <div className="market-analysis-value" style={{ color: 'var(--danger)' }}>${stats.currentRange.lower.toFixed(4)}</div>
              </div>
              <div className="market-analysis-item">
                <div className="market-analysis-label">レンジ上限</div>
                <div className="market-analysis-value" style={{ color: 'var(--success)' }}>${stats.currentRange.upper.toFixed(4)}</div>
              </div>
              {stats.gasStats && stats.gasStats.txCount > 0 && (
                <div className="market-analysis-item">
                  <div className="market-analysis-label">累積ガス代</div>
                  <div className="market-analysis-value">${stats.gasStats.totalGasUsdc.toFixed(4)}</div>
                  <div className="market-analysis-change">{stats.gasStats.txCount} TX</div>
                </div>
              )}
            </div>
          </div>

          <PriceChart
            data={combinedHistory}
            lowerBound={stats.currentRange.lower}
            upperBound={stats.currentRange.upper}
          />

          <ActivityLog logs={stats.activityLogs} />
        </main>
      </div>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        apiUrl={apiUrl}
        sessionId={sessionId}
      />
      <SetupWizard
        isOpen={isWizardOpen}
        onComplete={() => {
          // ウォレット接続を促す
        }}
        onClose={() => setIsWizardOpen(false)}
        apiUrl={apiUrl}
      />
      <HelpModal
        isOpen={isHelpOpen}
        onClose={() => setIsHelpOpen(false)}
      />
    </div>
  );
}

export default App;
