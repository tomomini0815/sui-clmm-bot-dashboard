import { useState, useEffect } from 'react';
import { Activity, DollarSign, Repeat, PowerOff, TrendingUp, BarChart3, Wallet } from 'lucide-react';
import { StatCard } from './components/StatCard';
import { PriceChart } from './components/PriceChart';
import { BalanceChart } from './components/BalanceChart';
import { SettingsModal } from './components/SettingsModal';
import { ActivityLog } from './components/ActivityLog';
import { HelpModal } from './components/HelpModal';
import { PnLCard } from './components/PnLCard';
import { DeltaGauge } from './components/DeltaGauge';
import { BotWalletCard } from './components/BotWalletCard';
import { StrategyVisualizer } from './components/StrategyVisualizer';
import { HedgePerfChart } from './components/HedgePerfChart';
import { SafetyGauge } from './components/SafetyGauge';
import { HourlySummaryCard } from './components/HourlySummaryCard';
import { MtfPanel } from './components/MtfPanel';
import { MultiBotPanel } from './components/MultiBotPanel';
import MarketAdvisor from './components/MarketAdvisor';
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit';

function App() {
  const currentAccount = useCurrentAccount();
  
  const [isBotActive, setIsBotActive] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [allSessions, setAllSessions] = useState<any[]>([]);
  
  const [sessionId, setSessionId] = useState(() => localStorage.getItem('session_id') || '');
  const [botWalletAddress, setBotWalletAddress] = useState(() => localStorage.getItem('bot_wallet_address') || '');
  const [apiUrl] = useState(() => 
    import.meta.env.PROD ? 'https://sui-clmm-bot-backend.fly.dev' : 'http://localhost:3002'
  );



  const syncWalletSession = async () => {
    if (!currentAccount) return;
    try {
      const response = await fetch(`${apiUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          walletAddress: currentAccount.address,
          isWalletConnect: true 
        })
      });
      const data = await response.json();
      if (data.success && data.sessionId) {
        setSessionId(data.sessionId);
        localStorage.setItem('session_id', data.sessionId);
        // セッション作成後に一覧も更新
        refreshSessions(currentAccount.address);
      }
    } catch (e) {
      console.warn('Failed to sync wallet session');
    }
  }; 

  const refreshSessions = async (addr?: string) => {
    try {
      const url = addr ? `${apiUrl}/api/sessions?walletAddress=${addr}` : `${apiUrl}/api/sessions`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) {
        setAllSessions(data.sessions);
        // 現在のsessionIdが一覧になければ、最新のものを選択
        if (data.sessions.length > 0 && !data.sessions.find((s: any) => s.sessionId === sessionId)) {
          // localStorageにあるか確認
          const savedId = localStorage.getItem('session_id');
          if (savedId && data.sessions.find((s: any) => s.sessionId === savedId)) {
             setSessionId(savedId);
          } else {
             const latest = data.sessions[data.sessions.length - 1];
             setSessionId(latest.sessionId);
             localStorage.setItem('session_id', latest.sessionId);
          }
        }
      }
    } catch (e) {
      console.error('Failed to fetch sessions');
    }
  };

  // マウント時およびウォレット接続時にセッション同期
  useEffect(() => {
    if (currentAccount?.address) {
      syncWalletSession();
    } else {
      refreshSessions();
    }
  }, [currentAccount?.address]); 

  // const handleWalletSessionSync = async () => {
  //   if (!currentAccount) return;
  //   syncWalletSession();
  // };
  const [stats, setStats] = useState({
    totalPnl: '0.00',
    totalFees: '0.0000',
    totalRebalances: 0,
    activityLogs: [] as any[],
    currentRange: { lower: 0, upper: 0 },
    config: { 
      lpAmountUsdc: 0.10, 
      rangeWidth: 0.05, 
      hedgeRatio: 0.5, 
      configMode: 'auto' as 'auto' | 'manual',
      strategyMode: 'balanced' as 'balanced' | 'range_order',
      totalOperationalCapitalUsdc: 0,
      hedgeEnabled: false as boolean
    },
    currentPrice: 0,
    entryPrice: 0,
    positionSize: 0,
    dailyPnl: '0.00',
    winRate: '0',
    avgHoldingTime: '0分',
    marketCondition: 'sideways',
    pythPrice: null as number | null,
    estimatedApr: 0 as number,
    pnl: null as any,
    delta: null as any,
    gasStats: null as any,
    hedge: null as any,
    indicators: null as any,
    currentPhase: '',
    network: 'mainnet' as 'mainnet' | 'testnet',
    balanceHistory: [] as any[],
    // 安全ゲート・1時間サマリー
    safetyGates: null as any,
    hourlySummary: null as any,
    mtf: null as any,
    advisor: null as any,
  });

  const [bot2, setBot2] = useState<any>(null);
  const [bot3, setBot3] = useState<any>(null);

  // pool価格とPyth価格をフロント側でポーリングごとに同時記録
  const [combinedHistory, setCombinedHistory] = useState<
    { time: string; poolPrice: number; pythPrice: number | null }[]
  >([]);

  useEffect(() => {
    const fetchStats = async () => {
      if (!sessionId || sessionId === 'undefined') return;
      
      try {
        const response = await fetch(`${apiUrl}/api/stats?sessionId=${sessionId}`);
        const result = await response.json();
        if (result.success && result.data) {
          // アドレスの同期を強化
          if (result.data.botWalletAddress && result.data.botWalletAddress !== botWalletAddress) {
            setBotWalletAddress(result.data.botWalletAddress);
            localStorage.setItem('bot_wallet_address', result.data.botWalletAddress);
          }
          
          setStats(prev => ({ ...prev, ...result.data }));
          setIsBotActive(result.data.isRunning);

          // データの徹底洗浄：数値であることを保証
          const poolHistory = (result.data.priceHistory || [])
            .map((p: any) => ({
              time: String(p.time || ''),
              poolPrice: Number(p.price) || 0,
              pythPrice: p.pythPrice ? Number(p.pythPrice) : null
            }))
            .filter((p: any) => p.time && p.poolPrice > 0);

          const latestPool = poolHistory.length > 0 ? poolHistory[poolHistory.length - 1] : null;
          const latestPyth: number | null = result.data.pythPrice ? Number(result.data.pythPrice) : null;

          if (latestPool) {
            setCombinedHistory(prev => {
              const lastEntry = prev.length > 0 ? prev[prev.length - 1] : null;
              
              // 全く同じデータなら更新しない
              if (lastEntry && 
                  lastEntry.time === latestPool.time && 
                  Math.abs(lastEntry.poolPrice - latestPool.poolPrice) < 0.00001 && 
                  lastEntry.pythPrice === latestPyth) {
                return prev;
              }

              const existsIndex = prev.findIndex(e => e.time === latestPool.time);
              if (existsIndex > -1) {
                const updated = [...prev];
                updated[existsIndex] = {
                  ...prev[existsIndex],
                  poolPrice: latestPool.poolPrice,
                  pythPrice: latestPyth ?? prev[existsIndex].pythPrice
                };
                return updated;
              }
              
              const updated = [...prev, {
                time: latestPool.time,
                poolPrice: latestPool.poolPrice,
                pythPrice: latestPyth,
              }];
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

      // === Bot2のステータス取得 ===
      try {
        const res2 = await fetch(`${apiUrl}/api/bot2/status`);
        const data2 = await res2.json();
        if (data2.success) {
          setBot2(data2);
        } else {
          setBot2({ active: false, message: data2.message || 'Bot2 inactive' });
        }
      } catch (e) {
        // console.warn('Bot2 stats sync failed');
      }

      // === Bot3のステータス取得 ===
      try {
        const res3 = await fetch(`${apiUrl}/api/bot3/status`);
        const data3 = await res3.json();
        if (data3.success) {
          setBot3(data3);
        } else {
          setBot3({ active: false, message: data3.message || 'Bot3 inactive' });
        }
      } catch (e) {
        // console.warn('Bot3 stats sync failed');
      }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 3000);
    return () => clearInterval(interval);
  }, [apiUrl, sessionId]);

  const handleApplyAdvisorRecommendation = async (mode: 'LP_ONLY' | 'DELTA_NEUTRAL') => {
    if (!sessionId) return;
    try {
      const isHedge = mode === 'DELTA_NEUTRAL';
      const updatedConfig = {
        ...stats.config,
        hedgeEnabled: isHedge,
        hedgeMode: isHedge ? 'bluefin' : 'simulate',
        rangeWidth: 0.04 
      };

      const response = await fetch(`${apiUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          ...updatedConfig,
          rangeWidth: (updatedConfig.rangeWidth * 100).toString(),
          hedgeRatio: (updatedConfig.hedgeRatio * 100).toString(),
        }),
      });

      const data = await response.json();
      if (data.success) {
        alert(`AI Strategy Applied: ${mode}. Bot is rebalancing...`);
        // 最新のステータスを取得
        const statsRes = await fetch(`${apiUrl}/api/stats?sessionId=${sessionId}`);
        const statsData = await statsRes.json();
        if (statsData.success) {
          setStats(statsData.data);
        }
      }
    } catch (err) {
      console.error('Failed to apply strategy', err);
      alert('Failed to apply AI strategy.');
    }
  };

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

  const handleUpdateStrategyMode = async (mode: 'balanced' | 'range_order', hedgeEnabled: boolean) => {
    if (!sessionId) return;
    
    try {
      const response = await fetch(`${apiUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          strategyMode: mode,
          hedgeEnabled: hedgeEnabled,
          lpAmountUsdc: stats.config.lpAmountUsdc,
          rangeWidth: (stats.config.rangeWidth * 100).toString(),
          hedgeRatio: (stats.config.hedgeRatio * 100).toString(),
          configMode: stats.config.configMode || 'auto'
        }),
      });
      const data = await response.json();
      if (data.success) {
        setStats(prev => ({ ...prev, config: { ...prev.config, strategyMode: mode, hedgeEnabled: hedgeEnabled } }));
        // ボットが稼働中の場合はリバランスがトリガーされる旨を通知
        const modeText = mode === 'balanced' ? 'ヘッジあり (バランス型)' : 'ヘッジなし (指値レンジ型)';
        if (isBotActive) {
          alert(`🚀 戦略を 「${modeText}」 に切り替えました。即座にリセット・再構築が実行されます。`);
        } else {
          alert(`✅ 戦略を 「${modeText}」 に設定しました。`);
        }
      }
    } catch (e) {
      alert('戦略の切り替えに失敗しました。');
    }
  };

  const handleToggleHedge = async () => {
    if (!sessionId) return;
    const nextHedgeEnabled = !stats.config.hedgeEnabled;
    const nextStrategyMode = nextHedgeEnabled ? 'balanced' : 'range_order';
    
    try {
      const response = await fetch(`${apiUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          strategyMode: nextStrategyMode,
          hedgeEnabled: nextHedgeEnabled,
          lpAmountUsdc: stats.config.lpAmountUsdc,
          rangeWidth: (stats.config.rangeWidth * 100).toString(),
          hedgeRatio: (stats.config.hedgeRatio * 100).toString(),
          configMode: stats.config.configMode || 'auto'
        }),
      });
      const data = await response.json();
      if (data.success) {
        setStats(prev => ({ 
          ...prev, 
          config: { 
            ...prev.config, 
            strategyMode: nextStrategyMode, 
            hedgeEnabled: nextHedgeEnabled 
          } 
        }));
        
        if (isBotActive) {
          alert(`🚀 ヘッジを「${nextHedgeEnabled ? 'ON' : 'OFF'}」に切り替えました。ボットのリバランス・クローズが即座に実行されます。`);
        } else {
          alert(`✅ ヘッジを「${nextHedgeEnabled ? 'ON' : 'OFF'}」に設定しました。`);
        }
      }
    } catch (e) {
      alert('ヘッジの切り替えに失敗しました。');
    }
  };

  const handleUpdateRangeWidth = async (newWidth: number) => {
    if (!sessionId) return;
    try {
      const response = await fetch(`${apiUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          strategyMode: stats.config.strategyMode,
          hedgeEnabled: stats.config.hedgeEnabled,
          lpAmountUsdc: stats.config.lpAmountUsdc,
          rangeWidth: newWidth.toString(),
          hedgeRatio: (stats.config.hedgeRatio * 100).toString(),
          configMode: stats.config.configMode || 'auto'
        }),
      });
      const data = await response.json();
      if (data.success) {
        setStats(prev => ({ 
          ...prev, 
          config: { 
            ...prev.config, 
            rangeWidth: newWidth / 100 
          } 
        }));
      }
    } catch (e) {
      console.error('Failed to update range width', e);
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
              SuiBot V3
            </span>
          </h1>
          <p className="header-subtitle">
            Delta-Neutral Profit Engine • V3.0
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
              }}>本番環境</span>
          </p>
        </div>
        <div className="header-actions">
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
                        stats.currentPhase === 'スワップ中' ? 'スワップ中' :
                        stats.currentPhase === 'LP投入中' ? 'LP投入中' :
                        stats.currentPhase === 'ヘッジ注文中' ? 'ヘッジ構築中' :
                        stats.currentPhase === 'ヘッジ決済中' ? 'ヘッジ決済中' :
                        stats.currentPhase === 'LP解除中' ? 'LP解除中' :
                        stats.currentPhase === 'ヘッジ方向反転中' ? '方向反転中' :
                        stats.currentPhase === '運用中 (監視)' ? '運用監視中' :
                        stats.currentPhase === 'リバランス中' ? 'リバランス中' : 
                        stats.currentPhase === '待機中' ? '待機中' : stats.currentPhase
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

          {/* Hedge Toggle */}
          {sessionId && (
            <button
              onClick={handleToggleHedge}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                borderColor: stats.config?.hedgeEnabled ? 'rgba(255, 159, 67, 0.3)' : 'rgba(139, 148, 158, 0.25)',
                color: stats.config?.hedgeEnabled ? '#ff9f43' : 'var(--text-muted)',
                background: stats.config?.hedgeEnabled ? 'rgba(255, 159, 67, 0.12)' : 'rgba(139, 148, 158, 0.08)',
                padding: '8px 14px',
                borderRadius: '12px',
                fontSize: '0.85rem',
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'all 0.2s',
                border: '1px solid',
                boxShadow: stats.config?.hedgeEnabled ? '0 0 8px rgba(255, 159, 67, 0.15)' : 'none',
              }}
            >
              <span style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: stats.config?.hedgeEnabled ? '#ff9f43' : 'rgba(255, 255, 255, 0.3)',
                display: 'inline-block',
                boxShadow: stats.config?.hedgeEnabled ? '0 0 6px #ff9f43' : 'none'
              }}></span>
              ヘッジ: {stats.config?.hedgeEnabled ? 'ON' : 'OFF'}
            </button>
          )}
          
          {/* Bot Selector */}
          {allSessions.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.05)', padding: '4px 12px', borderRadius: '12px', border: '1px solid var(--border-panel)' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>運用ボット:</span>
              <select 
                value={sessionId || ''}                onChange={(e) => {
                  const sid = e.target.value;
                  setSessionId(sid);
                  localStorage.setItem('session_id', sid);
                }}
                style={{ background: 'transparent', border: 'none', color: 'white', fontSize: '0.85rem', cursor: 'pointer', outline: 'none' }}
              >
                {allSessions.map((s, idx) => (
                  <option key={s.sessionId || `session-${idx}`} value={s.sessionId || ''} style={{ background: '#0d1117' }}>
                    {s.poolObjectId?.includes('b8d7d9') ? 'SUI / USDC' : s.poolObjectId?.includes('e01243') ? 'DEEP / SUI' : 'Other Pool'} ({s.sessionId?.slice(0, 6) || 'Unknown'})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="sui-connect-wrapper">
            <ConnectButton />
          </div>
        </div>
      </header>

      <div className="dashboard-grid">
        <main className="main-content">
          <div className="stats-grid stats-grid-main">
            <StatCard
              title="純利益 (Net P&L)"
              value={`$${netPnl.toFixed(4)}`}
              trend={netPnl >= 0 ? "up" : "down"}
              icon={<DollarSign size={18} />}
              subtitle={`手数料: $${stats.pnl?.fees?.toFixed(4) || '0.0000'}`}
              change={apr !== 0 ? `集計APR ${apr.toFixed(1)}% / 推定 ${stats.estimatedApr?.toFixed(1) || '0.0'}%` : undefined}
            />
            <StatCard title="リバランス回数" value={(stats.totalRebalances ?? 0).toString()} icon={<Repeat size={18} />} subtitle="自動再配置" change={`${stats.avgHoldingTime || '0分'}`} />
            <StatCard title="勝率" value={`${stats.winRate ?? '0'}%`} trend={parseFloat(stats.winRate ?? '0') >= 50 ? "up" : "down"} icon={<TrendingUp size={18} />} subtitle="利益確定確率" />
            <StatCard title="ポジション規模" value={`${stats.positionSize || stats.config?.lpAmountUsdc || 0} USDC`} icon={<Wallet size={18} />} subtitle="運用資金" />
            <StatCard title="Bot状態" value={isBotActive ? "運用中" : "停止中"} icon={<Activity size={18} color={isBotActive ? "var(--accent)" : "var(--text-muted)"} />} subtitle={isBotActive ? "手数料収集中" : "Startで開始"} />
            <StatCard title="市場状況" value={getMarketConditionText(stats.marketCondition || 'sideways').split(' ')[0]} icon={<BarChart3 size={18} />} subtitle={getMarketConditionText(stats.marketCondition || 'sideways').split(' ').slice(1).join(' ')} />
          </div>

          {/* 市場分析パネル（メインエリアに移動） */}
          <div className="glass-panel market-analysis-panel market-panel-main">
            <h3 style={{ fontSize: '0.95rem', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
              <BarChart3 size={16} color="var(--accent)" />
              市場分析
            </h3>

            <div className="market-analysis-grid" style={{ marginTop: '12px' }}>
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
                <div className="market-analysis-value" style={{ color: 'var(--danger)' }}>${stats.currentRange?.lower?.toFixed(4) || '0.0000'}</div>
              </div>
              <div className="market-analysis-item">
                <div className="market-analysis-label">レンジ上限</div>
                <div className="market-analysis-value" style={{ color: 'var(--success)' }}>${stats.currentRange?.upper?.toFixed(4) || '0.0000'}</div>
              </div>
              {stats.gasStats && stats.gasStats.txCount > 0 && (
                <div className="market-analysis-item">
                  <div className="market-analysis-label">累積ガス代</div>
                  <div className="market-analysis-value">${stats.gasStats.totalGasUsdc.toFixed(4)}</div>
                  <div className="market-analysis-change">{stats.gasStats.txCount} TX</div>
                </div>
              )}
            </div>

            <MarketAdvisor 
              advisor={stats.advisor} 
              onApplyStrategy={handleApplyAdvisorRecommendation} 
            />
          </div>

          <div className="main-charts-section">
            <BalanceChart data={stats.balanceHistory || []} />
            <PriceChart 
              data={combinedHistory} 
              lowerBound={stats.currentRange?.lower || 0}
              upperBound={stats.currentRange?.upper || 0}
            />
          </div>

          <HedgePerfChart
            data={combinedHistory.map(h => ({ time: h.time, poolPrice: h.poolPrice, entryPrice: stats.hedge?.entryPrice }))}
            currentPrice={stats.currentPrice}
            entryPrice={stats.hedge?.entryPrice || 0}
            active={stats.hedge?.active || false}
            direction={stats.hedge?.direction || 'SHORT'}
          />

          <ActivityLog logs={stats.activityLogs} />
        </main>

        <aside className="sidebar-aside">
          {/* 運用管理 & ウォレット (Section B) - トップに移動 */}
          <BotWalletCard 
            botAddress={botWalletAddress}
            suiBalance={stats.pnl?.botWalletBalanceSui || 0}
            usdcBalance={stats.pnl?.botWalletBalanceUsdc || 0}
            onRefresh={() => {/* fetchStats handles this */}}
            isBotActive={isBotActive}
            onToggleBot={toggleBotState}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onOpenHelp={() => setIsHelpOpen(true)}
            config={stats.config}
            onUpdateCapital={handleUpdateCapital}
            botWalletSufficient={stats.pnl?.botWalletSufficient ?? false}
            bot1LpValue={stats.pnl?.bot1LpValue || 0}
            bot2LpValue={stats.pnl?.bot2LpValue || 0}
            marginBalance={stats.hedge?.marginBalance || 0}
            userWalletBalanceSui={stats.pnl?.userWalletBalanceSui || 0}
            userWalletBalanceUsdc={stats.pnl?.userWalletBalanceUsdc || 0}
            userWalletSufficient={stats.pnl?.userWalletSufficient ?? false}
            connectedAddress={currentAccount?.address || ''}
            currentPrice={stats.currentPrice}
          />

          {/* Bot2 (DEEP/SUI) ステータスパネル */}
          <MultiBotPanel 
            title={`Bot2 — ${bot2?.pool || 'DEEP/SUI'}`} 
            bot={bot2} 
            onStart={() => {
              alert('Bot2は自動で稼働中です。個別設定は不要です。');
            }}
          />

          {/* Bot3 (Extra) ステータスパネル */}
          <MultiBotPanel 
            title={`Bot3 — ${bot3?.pool || 'SUI-PERP'}`} 
            bot={bot3} 
            onStart={() => {
              // SUI-PERPはまだ未実装だが枠だけ用意
              alert('SUI-PERPは近日公開予定です。');
            }}
          />

          {/* 安全ゲートパネル */}
          <SafetyGauge
            drawdownPct={stats.safetyGates?.drawdownPct ?? 0}
            marginRatio={stats.safetyGates?.marginRatio ?? 999}
            priceDataAge={stats.safetyGates?.priceDataAge ?? 0}
            consecutiveErrors={stats.safetyGates?.consecutiveErrors ?? 0}
            isEmergency={stats.safetyGates?.isEmergency ?? false}
          />

          {/* 1時間サマリー */}
          <HourlySummaryCard summary={stats.hourlySummary} />

          {/* MTF分析パネル (新機能) */}
          <MtfPanel mtf={stats.mtf} />

          {/* 戦略設定 & 資金配分 (Section A) */}
          <StrategyVisualizer 
            totalCapital={stats.config?.totalOperationalCapitalUsdc || stats.positionSize || stats.config?.lpAmountUsdc || 0} 
            config={stats.config}
            hedge={stats.hedge}
            onUpdateStrategyMode={handleUpdateStrategyMode}
            onUpdateRangeWidth={handleUpdateRangeWidth}
          />

          {/* PnLカード */}
          <PnLCard pnl={stats.pnl} gasStats={stats.gasStats} />

          {/* デルタゲージ */}
          <DeltaGauge delta={stats.delta} hedge={stats.hedge} indicators={stats.indicators} />
        </aside>
      </div>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        apiUrl={apiUrl}
        sessionId={sessionId}
        currentConfig={stats.config}
      />
      <HelpModal
        isOpen={isHelpOpen}
        onClose={() => setIsHelpOpen(false)}
      />
    </div>
  );
}

export default App;
