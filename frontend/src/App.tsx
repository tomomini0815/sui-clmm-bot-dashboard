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
import { BotWalletCard } from './components/BotWalletCard';
import { StrategyVisualizer } from './components/StrategyVisualizer';
import { HedgePerfChart } from './components/HedgePerfChart';
import { ConnectButton, useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';

function App() {
  const currentAccount = useCurrentAccount();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();
  
  const [isBotActive, setIsBotActive] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(() => !localStorage.getItem('wizard_completed'));

  const [sessionId, setSessionId] = useState(() => {
    // 1. URLのクエリパラメータ (?sessionId=...) を優先
    const params = new URLSearchParams(window.location.search);
    const urlSessionId = params.get('sessionId');
    if (urlSessionId) {
      localStorage.setItem('session_id', urlSessionId);
      return urlSessionId;
    }
    // 2. localStorage から復元
    return localStorage.getItem('session_id') || '';
  });
  const [botWalletAddress, setBotWalletAddress] = useState('');
  const [apiUrl] = useState(() => 
    import.meta.env.PROD ? 'https://sui-clmm-bot-backend.fly.dev' : 'http://localhost:3002'
  );



  // ウォレット接続時にセッション作成
  useEffect(() => {
    if (currentAccount && !sessionId) {
      console.log('Detected connected wallet without session. Creating session...');
      createSessionFromWallet();
    }
  }, [currentAccount, sessionId]); // sessionIdを追加して同期を確実に

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
        setBotWalletAddress(data.botWalletAddress);
        localStorage.setItem('session_id', data.sessionId);
        localStorage.setItem('wizard_completed', 'true');
        setIsWizardOpen(false);
      } else {
        alert('セッションの作成に失敗しました: ' + (data.error || 'Unknown error'));
      }
    } catch (e) {
      console.error('Failed to create session:', e);
      alert('サーバーとの通信に失敗しました。バックエンドが起動しているか確認してください。');
    }
  };

  const [stats, setStats] = useState({
    totalPnl: '0.00',
    totalFees: '0.0000',
    totalRebalances: 0,
    activityLogs: [] as any[],
    currentRange: { lower: 0, upper: 0 },
    config: { lpAmountUsdc: 0.10, rangeWidth: 0.05, hedgeRatio: 0.5, configMode: 'auto' },
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
    currentPhase: '',
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
          // アドレスの同期を強化
          if (result.data.botWalletAddress && result.data.botWalletAddress !== botWalletAddress) {
            console.log(`[SYNC] Bot Wallet Address forced to: ${result.data.botWalletAddress}`);
            setBotWalletAddress(result.data.botWalletAddress);
          }
          
          console.log('[DEBUG] API Stats Data:', result.data);
          setStats(result.data);
          setIsBotActive(result.data.isRunning);

          const poolHistory = (result.data.priceHistory || []).map((p: any) => ({
            time: p.time,
            poolPrice: p.price,
            pythPrice: p.pythPrice || null
          }));
          const latestPool = poolHistory.length > 0 ? poolHistory[poolHistory.length - 1] : null;
          const latestPyth: number | null = result.data.pythPrice ?? null;

          if (latestPool) {
            // 全体の統計を更新（フェーズ情報もここに含まれる）
            setStats(result.data);

            setCombinedHistory(prev => {
              const exists = prev.find(e => e.time === latestPool.time);
              if (exists) {
                return prev.map(e =>
                  e.time === latestPool.time
                    ? { ...e, poolPrice: latestPool.poolPrice, pythPrice: latestPyth ?? e.pythPrice }
                    : e
                );
              }
              const newEntry = {
                time: latestPool.time,
                poolPrice: latestPool.poolPrice,
                pythPrice: latestPyth,
              };
              const updated = [...prev, newEntry];
              return updated.length > 120 ? updated.slice(-120) : updated;
            });
          }
        } else if (result.error === 'Session not found') {
          // セッションが無効な場合はクリアして再作成を促す
          console.warn('Session expired or not found. Resetting...');
          setSessionId('');
          localStorage.removeItem('session_id');
        }
      } catch (e) {
        console.warn('Real-time stats sync failed');
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 3000);
    return () => clearInterval(interval);
  }, [apiUrl, sessionId]);

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
          sessionId,
          lpAmountUsdc: newAmount,
          strategyMode: stats.config.strategyMode,
          rangeWidth: (stats.config.rangeWidth * 100).toString(),
          hedgeRatio: (stats.config.hedgeRatio * 100).toString(),
          configMode: stats.config.configMode || 'auto'
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

  const handleUpdateStrategyMode = async (mode: 'balanced' | 'range_order') => {
    if (!sessionId) return;
    
    try {
      const response = await fetch(`${apiUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          strategyMode: mode,
          lpAmountUsdc: stats.config.lpAmountUsdc,
          rangeWidth: (stats.config.rangeWidth * 100).toString(),
          hedgeRatio: (stats.config.hedgeRatio * 100).toString(),
          configMode: stats.config.configMode || 'auto'
        }),
      });
      const data = await response.json();
      if (data.success) {
        setStats(prev => ({ ...prev, config: { ...prev.config, strategyMode: mode } }));
        // ボットが稼働中の場合はリバランスがトリガーされる旨を通知
        if (isBotActive) {
          alert(`🚀 戦略を ${mode === 'balanced' ? 'バランス型' : '指値レンジ型'} に切り替えました。即座にリバランスが実行されます。`);
        } else {
          alert(`✅ 戦略を ${mode === 'balanced' ? 'バランス型' : '指値レンジ型'} に設定しました。`);
        }
      }
    } catch (e) {
      alert('戦略の切り替えに失敗しました。');
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
            {stats.network === 'mainnet' && (
              <span style={{ 
                marginLeft: '12px', 
                padding: '2px 8px', 
                background: 'rgba(46, 213, 115, 0.15)', 
                color: '#2ed573', 
                borderRadius: '6px', 
                fontSize: '0.7rem',
                border: '1px solid rgba(46, 213, 115, 0.3)',
                fontWeight: 700,
                letterSpacing: '0.05em'
              }}>MAINNET</span>
            )}
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
              {stats.currentPhase && (
                <>
                  <span style={{ color: 'var(--border-panel)', margin: '0 4px' }}>|</span>
                  <span style={{ color: 'var(--accent)', fontWeight: '600' }}>
                    工程: {
                      stats.currentPhase === 'SWAPPING' ? 'スワップ中' :
                      stats.currentPhase === 'ADDING_LP' ? 'LP投入中' :
                      stats.currentPhase === 'OPENING_HEDGE' ? 'ヘッジ構築中' :
                      stats.currentPhase === 'MONITORING' ? '運用監視中' :
                      stats.currentPhase === 'REBALANCING' ? 'リバランス中' : 
                      stats.currentPhase === 'IDLE' ? '待機中' : stats.currentPhase
                    }
                  </span>
                </>
              )}
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
            onUpdateStrategyMode={handleUpdateStrategyMode}
          />

          {/* 戦略配分の視覚化 */}
          <StrategyVisualizer totalCapital={stats.config?.totalOperationalCapitalUsdc || stats.positionSize || stats.config?.lpAmountUsdc || 0} />

          {/* 専用ウォレットカード */}
          <BotWalletCard 
            botAddress={botWalletAddress}
            suiBalance={stats.pnl?.botWalletBalanceSui || 0}
            usdcBalance={stats.pnl?.botWalletBalanceUsdc || 0}
            onRefresh={() => {/* fetchStats will run shortly */}}
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

          <HedgePerfChart
            data={combinedHistory.map(h => ({ time: h.time, poolPrice: h.poolPrice, entryPrice: stats.hedge?.entryPrice }))}
            currentPrice={stats.currentPrice}
            entryPrice={stats.hedge?.entryPrice || 0}
            active={stats.hedge?.active || false}
          />

          <ActivityLog logs={stats.activityLogs} />
        </main>
      </div>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        apiUrl={apiUrl}
        sessionId={sessionId}
        currentConfig={stats.config}
      />
      <SetupWizard
        isOpen={isWizardOpen}
        onComplete={() => {
          const sid = localStorage.getItem('session_id');
          if (sid) {
            setSessionId(sid);
            setIsWizardOpen(false);
          }
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
