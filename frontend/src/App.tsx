import { useState, useEffect, useCallback, useRef } from 'react';
import {
  PowerOff, CheckCircle, AlertCircle, Loader,
  RotateCw, Settings, HelpCircle, TrendingUp, TrendingDown, Minus,
} from 'lucide-react';
import { SettingsModal } from './components/SettingsModal';
import { ActivityLog } from './components/ActivityLog';
import { HelpModal } from './components/HelpModal';
import { PnLCard } from './components/PnLCard';
import { BotWalletCard } from './components/BotWalletCard';
import { StrategyVisualizer } from './components/StrategyVisualizer';
import { SafetyGauge } from './components/SafetyGauge';
import { MtfPanel } from './components/MtfPanel';
import { MultiBotPanel } from './components/MultiBotPanel';
import { KpiBar } from './components/KpiBar';
import { PriceChartPanel } from './components/PriceChartPanel';
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit';

// トースト通知の型
interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'loading';
}

function App() {
  const currentAccount = useCurrentAccount();

  const [isBotActive, setIsBotActive] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [allSessions, setAllSessions] = useState<any[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isActionPending, setIsActionPending] = useState(false);
  const [chartMode, setChartMode] = useState<'recharts' | 'tradingview'>('tradingview');
  const toastIdRef = useRef(0);
  const statsRequestInFlightRef = useRef(false);

  const showToast = useCallback((message: string, type: Toast['type'] = 'success', duration = 3000) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
    if (type !== 'loading') {
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
    }
    return id;
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const [sessionId, setSessionId] = useState(() => localStorage.getItem('session_id') || '');
  const [botWalletAddress, setBotWalletAddress] = useState(() => localStorage.getItem('bot_wallet_address') || '');
  const [apiUrl] = useState(() => {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    return isLocal ? 'http://localhost:3002' : 'https://sui-clmm-bot-backend.fly.dev';
  });

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
        if (data.sessions.length > 0 && !data.sessions.find((s: any) => s.sessionId === sessionId)) {
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

  useEffect(() => {
    if (currentAccount?.address) {
      syncWalletSession();
    } else {
      refreshSessions();
    }
  }, [currentAccount?.address]);

  const [stats, setStats] = useState({
    totalPnl: '0.00',
    totalFees: '0.0000',
    totalRebalances: 0,
    activityLogs: [] as any[],
    currentRange: { lower: 0, upper: 0 },
    bot1OuterRange: { lower: 0, upper: 0 },
    bot2OuterRange: { lower: 0, upper: 0 },
    bot2PriceHistory: [] as any[],
    bot2CurrentPrice: 0,
    config: {
      lpAmountUsdc: 0.10,
      rangeWidth: 0.05,
      rangeOrderWidthPct: 0.05,
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
    safetyGates: null as any,
    hourlySummary: null as any,
    mtf: null as any,
    advisor: null as any,
    isUnbalanced: false as boolean,
    priceHistory: [] as any[],
  });

  const [bot2, setBot2] = useState<any>(null);

  useEffect(() => {
    const fetchStats = async () => {
      if (!sessionId || sessionId === 'undefined' || statsRequestInFlightRef.current) return;
      statsRequestInFlightRef.current = true;

      try {
        const response = await fetch(`${apiUrl}/api/stats?sessionId=${sessionId}`);
        const result = await response.json();
        if (result.success && result.data) {
          if (result.data.botWalletAddress && result.data.botWalletAddress !== botWalletAddress) {
            setBotWalletAddress(result.data.botWalletAddress);
            localStorage.setItem('bot_wallet_address', result.data.botWalletAddress);
          }
          setStats(prev => ({ ...prev, ...result.data }));
          setIsBotActive(result.data.isRunning);
          if (result.data.bot2Status) {
            setBot2(result.data.bot2Status);
          }
        } else if (result.error === 'Session not found') {
          console.warn('Session expired or not found. Resetting...');
          setSessionId('');
          localStorage.removeItem('session_id');
        }
      } catch (e) {
        console.warn('Real-time stats sync failed');
      }

      statsRequestInFlightRef.current = false;
    };
    fetchStats();
    const interval = setInterval(fetchStats, 300000); // 5分間隔でポーリング（バックエンドのCetus価格キャッシュ時間5分と同期）
    return () => clearInterval(interval);
  }, [apiUrl, sessionId]);

  const handleRebuild = async () => {
    if (!sessionId || isActionPending) return;
    const confirm = window.confirm("すべてのポジションを一度クローズし、資金を均等（25%ずつ）にスワップ調整して再構築します。よろしいですか？");
    if (!confirm) return;

    setIsActionPending(true);
    const loadingId = showToast("全ポジションの再配置を実行中...⚙️ (しばらくお待ちください)", "loading");
    try {
      const response = await fetch(`${apiUrl}/api/rebuild`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, rangeWidth: ((stats.config.rangeOrderWidthPct ?? stats.config.rangeWidth) * 100) })
      });
      const data = await response.json();
      dismissToast(loadingId);
      if (data.success) {
        showToast("✅ 再配置を開始しました。数分でポジション構築が完了します。", "success", 5000);
      } else {
        showToast(`再配置に失敗しました: ${data.error}`, "error");
      }
    } catch (e) {
      dismissToast(loadingId);
      showToast("通信エラーが発生しました", "error");
    } finally {
      setIsActionPending(false);
    }
  };

  const handleRestartAndRebuild = async (overrideRangeWidth?: number) => {
    if (!sessionId || isActionPending) return;
    const effectiveWidth = overrideRangeWidth ?? ((stats.config.rangeOrderWidthPct ?? stats.config.rangeWidth) * 100);
    const confirm = window.confirm(`Botを再起動し、Cetusレンジ幅 ${effectiveWidth.toFixed(2)}% で合計8ポジションを再配置します。よろしいですか？`);
    if (!confirm) return;

    setIsActionPending(true);
    setIsBotActive(true);
    setStats(prev => ({ ...prev, config: { ...prev.config, strategyMode: 'range_order', hedgeEnabled: false, rangeWidth: effectiveWidth / 100, rangeOrderWidthPct: effectiveWidth / 100 } }));
    const loadingId = showToast("Botを再起動し、8ポジションを再配置中... 完了まで待機します", "loading");
    try {
      const response = await fetch(`${apiUrl}/api/restart-rebuild`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, rangeWidth: effectiveWidth.toString() })
      });
      const data = await response.json();
      dismissToast(loadingId);
      if (data.success) {
        showToast("✅ 8ポジション再配置が完了し、Botを起動しました。", "success", 6000);
      } else {
        showToast(`Bot再起動に失敗しました: ${data.error}`, "error");
      }
    } catch (e) {
      dismissToast(loadingId);
      showToast("通信エラー: バックエンドが起動中か確認してください", "error", 5000);
    } finally {
      setIsActionPending(false);
    }
  };

  const toggleBotState = async () => {
    if (!sessionId || isActionPending) return;
    const nextActive = !isBotActive;
    setIsBotActive(nextActive);
    setIsActionPending(true);
    const loadingId = showToast(nextActive ? 'ボットを起動中...⚙️' : 'ボットを停止中...', 'loading');
    try {
      const endpoint = nextActive ? '/api/start' : '/api/stop';
      const response = await fetch(`${apiUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      const data = await response.json();
      dismissToast(loadingId);
      if (data.success) {
        showToast(nextActive ? '✅ ボットを起動しました' : '⏹️ ボットを停止しました', 'success');
      } else {
        setIsBotActive(!nextActive);
        showToast('操作に失敗しました', 'error');
      }
    } catch (e) {
      dismissToast(loadingId);
      setIsBotActive(!nextActive);
      showToast('通信エラー: バックエンドが起動中か確認してください', 'error', 5000);
    } finally {
      setIsActionPending(false);
    }
  };

  const handleUpdateCapital = async (newAmount: number) => {
    setStats(prev => ({ ...prev, config: { ...prev.config, lpAmountUsdc: newAmount } }));
    const loadingId = showToast('運用資金を更新中...', 'loading');
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
      dismissToast(loadingId);
      if (data.success) {
        showToast(`✅ 運用資金を ${newAmount} USDC に更新しました`);
      } else {
        showToast('更新に失敗しました', 'error');
      }
    } catch (e) {
      dismissToast(loadingId);
      showToast('更新に失敗しました。バックエンドが起動中か確認してください。', 'error', 5000);
    }
  };

  const handleUpdateStrategyMode = async (mode: 'balanced' | 'range_order', hedgeEnabled: boolean) => {
    if (!sessionId || isActionPending) return;
    const prevConfig = stats.config;
    setStats(prev => ({ ...prev, config: { ...prev.config, strategyMode: mode, hedgeEnabled } }));
    setIsActionPending(true);
    const modeText = mode === 'balanced' ? 'ヘッジあり' : 'ヘッジなし';
    const loadingId = showToast(`戦略を「${modeText}」に切り替え中...`, 'loading');
    try {
      const response = await fetch(`${apiUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          strategyMode: mode,
          hedgeEnabled,
          lpAmountUsdc: stats.config.lpAmountUsdc,
          rangeWidth: (stats.config.rangeWidth * 100).toString(),
          hedgeRatio: (stats.config.hedgeRatio * 100).toString(),
          configMode: stats.config.configMode || 'auto'
        }),
      });
      const data = await response.json();
      dismissToast(loadingId);
      if (data.success) {
        showToast(isBotActive ? `🚀 「${modeText}」に切り替えました。再構築を実行します。` : `✅ 「${modeText}」に設定しました。`);
      } else {
        setStats(prev => ({ ...prev, config: prevConfig }));
        showToast('戦略の切り替えに失敗しました', 'error');
      }
    } catch (e) {
      dismissToast(loadingId);
      setStats(prev => ({ ...prev, config: prevConfig }));
      showToast('戦略の切り替えに失敗しました', 'error');
    } finally {
      setIsActionPending(false);
    }
  };

  const handleUpdateRangeWidth = async (newWidth: number) => {
    if (!sessionId) return;
    setStats(prev => ({ ...prev, config: { ...prev.config, rangeWidth: newWidth / 100, rangeOrderWidthPct: newWidth / 100 } }));
    const loadingId = showToast(`レンジ幅を ±${newWidth.toFixed(2)}% に更新中...`, 'loading');
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
      dismissToast(loadingId);
      if (data.success) {
        showToast(`✅ レンジ幅を ±${newWidth.toFixed(2)}% に保存しました。既存ポジションへ反映するには8再配置を実行してください。`, 'success', 5000);
      } else {
        showToast('レンジ幅の更新に失敗しました', 'error');
      }
    } catch (e) {
      dismissToast(loadingId);
      showToast('レンジ幅の更新に失敗しました', 'error');
    }
  };

  // 計算済み値
  const netPnl = stats.pnl?.netPnl ?? 0;
  const totalLpValue = (stats.pnl?.bot1LpValue || 0) + (stats.pnl?.bot2LpValue || 0);
  const safetyHealthy = !stats.safetyGates?.isEmergency && (stats.safetyGates?.consecutiveErrors ?? 0) < 3;
  const phaseLabel = stats.currentPhase || (isBotActive ? '運用監視中' : '待機中');
  const fees = stats.pnl?.fees ?? (stats.pnl as any)?.feesCollected ?? 0;

  // トレンドバッジ
  const trendClass = stats.marketCondition === 'uptrend' ? 'up' : stats.marketCondition === 'downtrend' ? 'down' : 'neutral';
  const trendLabel = stats.marketCondition === 'uptrend' ? '上昇トレンド' : stats.marketCondition === 'downtrend' ? '下降トレンド' : 'レンジ相場';
  const TrendIcon = stats.marketCondition === 'uptrend' ? TrendingUp : stats.marketCondition === 'downtrend' ? TrendingDown : Minus;

  return (
    <div className="dashboard-container">
      {/* ======= トースト通知 ======= */}
      <div style={{
        position: 'fixed', top: '20px', right: '20px', zIndex: 9999,
        display: 'flex', flexDirection: 'column', gap: '8px', pointerEvents: 'none'
      }}>
        {toasts.map(toast => (
          <div key={toast.id} style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '12px 16px', borderRadius: '12px',
            background: toast.type === 'success' ? 'rgba(34, 197, 94, 0.15)'
              : toast.type === 'error' ? 'rgba(239, 68, 68, 0.15)'
              : 'rgba(88, 166, 255, 0.15)',
            border: `1px solid ${
              toast.type === 'success' ? 'rgba(34, 197, 94, 0.4)'
              : toast.type === 'error' ? 'rgba(239, 68, 68, 0.4)'
              : 'rgba(88, 166, 255, 0.4)'
            }`,
            backdropFilter: 'blur(12px)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            color: 'white', fontSize: '0.85rem', fontWeight: 600,
            minWidth: '260px', maxWidth: '360px',
            animation: 'slideInRight 0.25s ease-out',
            pointerEvents: 'auto'
          }}>
            {toast.type === 'success' && <CheckCircle size={16} color="#22c55e" style={{ flexShrink: 0 }} />}
            {toast.type === 'error' && <AlertCircle size={16} color="#ef4444" style={{ flexShrink: 0 }} />}
            {toast.type === 'loading' && <Loader size={16} color="#58a6ff" style={{ flexShrink: 0, animation: 'spin 1s linear infinite' }} />}
            <span style={{ flex: 1 }}>{toast.message}</span>
          </div>
        ))}
      </div>

      {/* ======= ヘッダー v2 ======= */}
      <header className="header-v2" aria-label="ダッシュボードヘッダー">
        <div className="header-v2-left">
          <div className="header-v2-title">
            <h1>
              <span className="gradient-text">SuiBot V3</span>
            </h1>
            <span className="header-v2-pair">SUI / USDC</span>
            {stats.currentPrice > 0 && (
              <span className="header-v2-price" style={{
                color: stats.marketCondition === 'uptrend' ? '#3fb950'
                  : stats.marketCondition === 'downtrend' ? '#f85149'
                  : '#e6edf3'
              }}>
                {stats.currentPrice.toFixed(4)}
                <span style={{ fontSize: '0.7em', color: 'var(--text-muted)', marginLeft: '4px' }}>USDC</span>
              </span>
            )}
          </div>
          <div className="header-v2-meta">
            <div className={`status-dot-badge ${isBotActive ? 'active' : 'inactive'}`}>
              <div className={`status-dot ${isBotActive ? 'active' : 'inactive'}`} />
              {isBotActive ? 'RUNNING' : 'STOPPED'}
            </div>
            <div className={`trend-badge ${trendClass}`}>
              <TrendIcon size={13} />
              {trendLabel}
            </div>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontWeight: 500 }}>
              {phaseLabel}
            </span>
            <span style={{
              fontSize: '0.72rem',
              color: safetyHealthy ? 'var(--success)' : 'var(--danger)',
              background: safetyHealthy ? 'rgba(63,185,80,0.08)' : 'rgba(248,81,73,0.08)',
              padding: '2px 8px', borderRadius: '6px',
              border: `1px solid ${safetyHealthy ? 'rgba(63,185,80,0.2)' : 'rgba(248,81,73,0.2)'}`,
              fontWeight: 600
            }}>
              安全性: {safetyHealthy ? '正常' : '要確認'}
            </span>
          </div>
        </div>

        <div className="header-v2-actions">
          {allSessions.length > 0 && (
            <div className="session-picker">
              <span>ボット</span>
              <select
                value={sessionId || ''}
                aria-label="運用ボットを選択"
                onChange={(e) => {
                  const sid = e.target.value;
                  setSessionId(sid);
                  localStorage.setItem('session_id', sid);
                }}
              >
                {allSessions.map((s, idx) => (
                  <option key={s.sessionId || `session-${idx}`} value={s.sessionId || ''}>
                    {s.poolObjectId?.includes('b8d7d9') ? 'SUI/USDC' : s.poolObjectId?.includes('e01243') ? 'DEEP/SUI' : 'Pool'} ({s.sessionId?.slice(0, 6) || '---'})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* コントロールボタン */}
          <button
            id="btn-toggle-bot"
            className={`ctrl-btn ${isBotActive ? 'stop' : 'start'}`}
            onClick={toggleBotState}
            disabled={!sessionId || isActionPending}
            aria-label={isBotActive ? 'Botを停止' : 'Botを起動'}
          >
            {isActionPending
              ? <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} />
              : <PowerOff size={16} />
            }
            {isBotActive ? '停止' : '起動'}
          </button>

          <button
            id="btn-restart-rebuild"
            className="ctrl-btn rebuild"
            onClick={() => handleRestartAndRebuild()}
            disabled={!sessionId || isActionPending}
            aria-label="8ポジション再配置"
          >
            <RotateCw size={16} style={{ animation: isActionPending ? 'spin 1s linear infinite' : 'none' }} />
            再配置
          </button>

          <button className="icon-button" id="btn-help" onClick={() => setIsHelpOpen(true)} aria-label="ヘルプ">
            <HelpCircle size={18} />
          </button>
          <button className="icon-button" id="btn-settings" onClick={() => setIsSettingsOpen(true)} aria-label="設定">
            <Settings size={18} />
          </button>
          <div className="sui-connect-wrapper">
            <ConnectButton />
          </div>
        </div>
      </header>

      {/* ======= KPI バー ======= */}
      <KpiBar
        totalLpValue={totalLpValue}
        netPnl={netPnl}
        totalRebalances={stats.totalRebalances}
        marketCondition={stats.marketCondition}
        estimatedApr={stats.estimatedApr}
        fees={fees}
        isBotActive={isBotActive}
        currentPrice={stats.currentPrice}
        pythPrice={stats.pythPrice}
      />

      {/* ======= メインコンテンツ ======= */}
      <div className="dashboard-grid-v2">
        <div className="dashboard-grid-v2-main">
          <div className={`dashboard-grid-v2-main-content ${chartMode === 'tradingview' ? 'tradingview-mode' : ''}`}>
            {/* 価格チャート */}
            <PriceChartPanel
              priceHistory={stats.priceHistory}
              currentPrice={stats.currentPrice}
              bot1OuterRange={stats.bot1OuterRange || { lower: 0, upper: 0 }}
              bot2OuterRange={stats.bot2OuterRange || { lower: 0, upper: 0 }}
              bot2PriceHistory={stats.bot2PriceHistory || []}
              bot2CurrentPrice={stats.bot2CurrentPrice || 0}
              isBotActive={isBotActive}
              marketCondition={stats.marketCondition}
              chartMode={chartMode}
              setChartMode={setChartMode}
            />

            {/* 実行履歴 — flex: 1 で右サイドの下端に揃える */}
            <div className="activity-log-stretch">
              <ActivityLog logs={stats.activityLogs} />
            </div>
          </div>
        </div>

        {/* 右: コントロールパネル */}
        <aside className="dashboard-grid-v2-side">
          {/* 運用戦略を右サイド最上部に集約 */}
          <div className="glass-panel side-group-panel">
            <StrategyVisualizer
              totalCapital={stats.config?.totalOperationalCapitalUsdc || stats.positionSize || stats.config?.lpAmountUsdc || 0}
              bot1LpValue={stats.pnl?.bot1LpValue || 0}
              bot2LpValue={stats.pnl?.bot2LpValue || 0}
              config={stats.config}
              onUpdateStrategyMode={handleUpdateStrategyMode}
              onUpdateRangeWidth={handleUpdateRangeWidth}
              onRestartRebuild={handleRestartAndRebuild}
              isActionPending={isActionPending}
              noPanel={true}
            />
          </div>

          {/* グループ1: 資金と収益 (Wallet & PnL) */}
          <div className="glass-panel side-group-panel">
            <BotWalletCard
              botAddress={botWalletAddress}
              suiBalance={stats.pnl?.botWalletBalanceSui || 0}
              usdcBalance={stats.pnl?.botWalletBalanceUsdc || 0}
              onRefresh={() => {}}
              isBotActive={isBotActive}
              onToggleBot={toggleBotState}
              onOpenSettings={() => setIsSettingsOpen(true)}
              onOpenHelp={() => setIsHelpOpen(true)}
              config={stats.config}
              onUpdateCapital={handleUpdateCapital}
              botWalletSufficient={stats.pnl?.botWalletSufficient ?? false}
              bot1LpValue={stats.pnl?.bot1LpValue || 0}
              bot2LpValue={stats.pnl?.bot2LpValue || 0}
              userWalletBalanceSui={stats.pnl?.userWalletBalanceSui || 0}
              userWalletBalanceUsdc={stats.pnl?.userWalletBalanceUsdc || 0}
              userWalletSufficient={stats.pnl?.userWalletSufficient ?? false}
              connectedAddress={currentAccount?.address || ''}
              currentPrice={stats.currentPrice}
              isUnbalanced={stats.isUnbalanced}
              onRebuild={handleRebuild}
              noPanel={true}
            />
            <div className="side-group-divider" />
            <PnLCard pnl={stats.pnl} gasStats={stats.gasStats} noPanel={true} />
          </div>

          {/* グループ2: Bot2 */}
          <div className="glass-panel side-group-panel">
            <MultiBotPanel
              title={`Bot2 — ${bot2?.pool || 'DEEP/SUI'}`}
              bot={bot2}
              onStart={() => { alert('Bot2は自動で稼働中です。個別設定は不要です。'); }}
              onRebuild={handleRebuild}
              noPanel={true}
            />
          </div>

          {/* グループ3: 安全性と分析シグナル (Safety & Signals) */}
          <div className="glass-panel side-group-panel">
            <SafetyGauge
              drawdownPct={stats.safetyGates?.drawdownPct ?? 0}
              marginRatio={stats.safetyGates?.marginRatio ?? 999}
              priceDataAge={stats.safetyGates?.priceDataAge ?? 0}
              consecutiveErrors={stats.safetyGates?.consecutiveErrors ?? 0}
              isEmergency={stats.safetyGates?.isEmergency ?? false}
              noPanel={true}
            />
            <div className="side-group-divider" />
            <MtfPanel mtf={stats.mtf} noPanel={true} />
          </div>
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
