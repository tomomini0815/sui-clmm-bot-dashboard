import { useState } from 'react';
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
  const [isWizardOpen, setIsWizardOpen] = useState(true); // 初回アクセス時に開く

  // グローバルなフォーム状態（ウィザードと設定間での同期用）
  const [privateKey, setPrivateKey] = useState('');
  const [apiUrl, setApiUrl] = useState(localStorage.getItem('bot_api_url') || import.meta.env.VITE_API_URL || 'http://localhost:3001');

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
          <h1><span className="text-gradient">Cetus</span> Bot UI Max</h1>
          <p style={{ color: 'var(--text-muted)', marginTop: '4px' }}>Automated Rebalance & Hedge Manager on Sui</p>
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
          {isBotActive ? 'System Active' : 'System Paused'}
        </div>
      </header>

      <div className="dashboard-grid">
        <aside style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <ConfigPanel 
            isBotActive={isBotActive} 
            onToggleBot={toggleBotState} 
            onOpenSettings={() => setIsSettingsOpen(true)}
            onOpenWizard={() => setIsWizardOpen(true)}
          />
          
          <div className="glass-panel">
            <h3 style={{ fontSize: '1rem', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldCheck size={18} color="var(--neon-cetus)" /> Protocol Analytics
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6 }}>
              The bot continuously monitors the tick ranges of the assigned CLMM pool on Cetus.
              It uses dynamic math to collect fees and execute a delta-neutral hedge.
            </p>
          </div>
        </aside>

        <main>
          <div className="stats-grid">
            <StatCard 
              title="Total P&L" 
              value="$124.50" 
              trend="up" 
              icon={<DollarSign size={20} />} 
              subtitle="All time realized PnL" 
            />
            <StatCard 
              title="Rebalance Count" 
              value="42" 
              icon={<Repeat size={20} />} 
              subtitle="Past 30 days" 
            />
            <StatCard 
              title="Current Status" 
              value={isBotActive ? "In Range" : "Stopped"} 
              icon={<Activity size={20} color={isBotActive ? "var(--neon-cetus)" : "var(--text-muted)"} />} 
              subtitle={isBotActive ? "Earning fees actively" : "Awaiting manual start"} 
            />
          </div>

          <PriceChart />
          
          <ActivityLog />
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
          localStorage.setItem('bot_api_url', val);
        }}
      />
      <SetupWizard 
        isOpen={isWizardOpen} 
        onComplete={() => setIsWizardOpen(false)} 
        privateKey={privateKey}
        setPrivateKey={setPrivateKey}
        apiUrl={apiUrl}
      />
    </div>
  );
}

export default App;
