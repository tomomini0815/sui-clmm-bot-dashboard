import React from 'react';
import { Brain, Activity, Zap, Target } from 'lucide-react';

interface MtfState {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  mtfScore: number;
  fundingBias: number;
  totalScore: number;
  details: string;
  fundingArbitrage: boolean;
  currentFundingRate: number;
  regime: 'LOW_VOL' | 'HIGH_VOL';
  hedgeRatio: number;
  updatedAt: number;
}

interface MtfPanelProps {
  mtf: MtfState | null;
}

export const MtfPanel: React.FC<MtfPanelProps> = ({ mtf }) => {
  if (!mtf) {
    return (
      <div className="glass-panel" style={{ padding: '20px', opacity: 0.7 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)' }}>
          <Brain size={18} />
          <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>MTF 分析エンジン 待機中</span>
        </div>
        <p style={{ fontSize: '0.8rem', marginTop: '8px', color: 'var(--text-muted)' }}>
          最初の分析サイクルが完了すると表示されます...
        </p>
      </div>
    );
  }

  const isShort = mtf.direction === 'SHORT';
  const isLong = mtf.direction === 'LONG';
  
  return (
    <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '15px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Brain size={20} color="var(--accent)" />
          <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>MTF 戦略シグナル</h3>
        </div>
        <div style={{ 
          background: isLong ? 'rgba(63, 185, 80, 0.15)' : isShort ? 'rgba(248, 81, 73, 0.15)' : 'rgba(255, 255, 255, 0.05)',
          padding: '4px 12px',
          borderRadius: '20px',
          fontSize: '0.75rem',
          fontWeight: 800,
          color: isLong ? 'var(--success)' : isShort ? 'var(--danger)' : 'var(--text-muted)',
          border: `1px solid ${isLong ? 'rgba(63, 185, 80, 0.3)' : isShort ? 'rgba(248, 81, 73, 0.3)' : 'rgba(255, 255, 255, 0.1)'}`
        }}>
          {mtf.direction}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <div className="mtf-stat-card">
          <div className="mtf-stat-label">市場レジーム</div>
          <div className="mtf-stat-value" style={{ color: mtf.regime === 'HIGH_VOL' ? '#f97316' : 'var(--accent)' }}>
            <Activity size={14} style={{ marginRight: '4px' }} />
            {mtf.regime === 'HIGH_VOL' ? '高ボラティリティ' : '低ボラティリティ'}
          </div>
        </div>
        <div className="mtf-stat-card">
          <div className="mtf-stat-label">最適ヘッジ比率</div>
          <div className="mtf-stat-value">
            <Target size={14} style={{ marginRight: '4px' }} />
            {(mtf.hedgeRatio * 100).toFixed(0)}%
          </div>
        </div>
      </div>

      <div style={{ background: 'rgba(255, 255, 255, 0.03)', borderRadius: '8px', padding: '12px', fontSize: '0.85rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
          <span style={{ color: 'var(--text-muted)' }}>MTF スコア (5m/15m/30m)</span>
          <span style={{ fontWeight: 600, color: mtf.mtfScore > 0 ? 'var(--success)' : mtf.mtfScore < 0 ? 'var(--danger)' : 'inherit' }}>
            {mtf.mtfScore > 0 ? '+' : ''}{mtf.mtfScore}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
          <span style={{ color: 'var(--text-muted)' }}>Funding バイアス ({(mtf.currentFundingRate * 100).toFixed(4)}%)</span>
          <span style={{ fontWeight: 600, color: mtf.fundingBias > 0 ? 'var(--success)' : mtf.fundingBias < 0 ? 'var(--danger)' : 'inherit' }}>
            {mtf.fundingBias > 0 ? '+' : ''}{mtf.fundingBias}
          </span>
        </div>
        <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '8px', display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700 }}>総合判定スコア</span>
          <span style={{ fontWeight: 800, fontSize: '1rem', color: mtf.totalScore >= 2 ? 'var(--success)' : mtf.totalScore <= -2 ? 'var(--danger)' : 'var(--accent)' }}>
            {mtf.totalScore > 0 ? '+' : ''}{mtf.totalScore}
          </span>
        </div>
      </div>

      {mtf.fundingArbitrage && (
        <div style={{ 
          background: 'linear-gradient(90deg, rgba(138, 75, 255, 0.1), rgba(63, 185, 80, 0.1))',
          border: '1px solid rgba(138, 75, 255, 0.2)',
          borderRadius: '8px',
          padding: '10px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px'
        }}>
          <Zap size={16} color="#8a4bff" />
          <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#d1b3ff' }}>
            Funding Arbitrage Mode Active: SHORT を維持し金利を収益化中
          </span>
        </div>
      )}

      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'right' }}>
        Last updated: {new Date(mtf.updatedAt).toLocaleTimeString()}
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .mtf-stat-card {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 8px;
          padding: 10px;
        }
        .mtf-stat-label {
          font-size: 0.65rem;
          color: var(--text-muted);
          margin-bottom: 4px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .mtf-stat-value {
          font-size: 0.85rem;
          font-weight: 700;
          display: flex;
          align-items: center;
        }
      `}} />
    </div>
  );
};
