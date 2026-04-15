import { useState, useEffect } from 'react';
import { Activity, DollarSign, Repeat, ShieldCheck, PowerOff } from 'lucide-react';
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
    config: { lpAmountUsdc: 0, rangeWidth: 0, hedgeRatio: 0 }
  });

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await fetch(`${apiUrl}/api/stats`);
        const result = await response.json();
        if (result.success) {
          setStats(result.data);
          setIsBotActive(result.data.isRunning);
        }
      } catch (e) {
        console.warn('Real-time stats sync failed (Standard behavior for first launch)');
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
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

  return (
    <div className="dashboard-container">
      <header className="header">
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, margin: 0, background: 'linear-gradient(90deg, #ff007a, #7928ca)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Sui Liquidity Bot (V2 Trailing)
          </h1>
          <p style={{ color: 'var(--text-muted)', marginTop: '4px' }}>Advanced Time-Filtered Trailing Stop Strategy</p>
        </div>
        <div className={`badge ${isBotActive ? 'animate-pulse-slow' : ''}`} style={{ 
          display: 'flex', alignItems: 'center', gap: '6px',
          borderColor: isBotActive ? 'rgba(0, 240, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)',
          color: isBotActive ? 'var(--neon-cyan)' : 'var(--text-muted)',
          background: isBotActive ? 'rgba(0, 240, 255, 0.1)' : 'rgba(255, 255, 255, 0.05)'
        }}>
          {isBotActive ? (
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--neon-cyan)', display: 'inline-block' }}></span>
          ) : (
             <PowerOff size={14} color="var(--text-muted)" />
          )}
          {isBotActive ? '🟢 稼働中 (System Active)' : '⚪ 待機中 (Paused)'}
        </div>
      </header>

      <div className="dashboard-grid">
        <aside style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <ConfigPanel 
            isBotActive={isBotActive} 
            onToggleBot={toggleBotState} 
            onOpenSettings={() => setIsSettingsOpen(true)}
            onOpenWizard={() => setIsWizardOpen(true)}
            config={stats.config}
          />
          
          <div className="glass-panel">
            <h3 style={{ fontSize: '1rem', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldCheck size={18} color="#ff007a" /> 💡 稼働中アルゴリズム (V2)
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6 }}>
              V2 トレイリング・ストップ仕様：<br/><br/>
              この高度なBotは、SUIの価格上昇に合わせて防衛ラインを自動でせり上げる「トレイリングストップ」機能を搭載しています。<br/><br/>
              価格が5分間連続で撤退ラインを割った場合のみシステムが全資金を退避させ、一瞬の「ダマシ下落（損切り貧乏）」を回避します。
            </p>
          </div>
        </aside>

        <main>
          <div className="stats-grid">
            <StatCard 
              title="累計利益 (P&L)" 
              value={`$${stats.totalPnl}`} 
              trend={parseFloat(stats.totalPnl) >= 0 ? "up" : "down"} 
              icon={<DollarSign size={20} />} 
              subtitle={`獲得した手数料: ${stats.totalFees} SUI`} 
            />
            <StatCard 
              title="自動再配置 (リバランス) 回数" 
              value={stats.totalRebalances.toString()} 
              icon={<Repeat size={20} />} 
              subtitle="現在のセッション" 
            />
            <StatCard 
              title="現在の状態" 
              value={isBotActive ? "運用中" : "停止中"} 
              icon={<Activity size={20} color={isBotActive ? "var(--neon-cetus)" : "var(--text-muted)"} />} 
              subtitle={isBotActive ? "正常に手数料を稼いでいます" : "Startボタンで開始してください"} 
            />
          </div>

          <PriceChart 
            data={stats.priceHistory} 
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
