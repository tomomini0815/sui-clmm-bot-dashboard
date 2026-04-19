import React from 'react';
import { Shield, Activity } from 'lucide-react';

interface DeltaData {
  current: number;
  hedgeActive: boolean;
  hedgeSize: number;
  recommendation: string;
}

interface HedgeData {
  active: boolean;
  mode: string;
  size: number;
  entryPrice: number;
  currentPnl: number;
  cumulativePnl: number;
  fundingCost: number;
  marginBalance: number;
  maintenanceMargin: number;
}

interface Indicators {
  rsi: number;
  volatility: number;
  trend: string;
}

interface DeltaGaugeProps {
  delta: DeltaData | null;
  hedge: HedgeData | null;
  indicators: Indicators | null;
}

export const DeltaGauge: React.FC<DeltaGaugeProps> = ({ delta, hedge, indicators }) => {
  if (!delta) {
    return (
      <div className="glass-panel delta-gauge">
        <h3 className="delta-gauge-title">
          <Shield size={16} />
          デルタ・ニュートラル
        </h3>
        <div className="delta-waiting">
          <div className="delta-waiting-icon">🛡️</div>
          <p>ボット起動後、ヘッジ状態がここに表示されます。</p>
        </div>
      </div>
    );
  }

  // デルタ値を-1.0〜+1.0の範囲でゲージ化
  const deltaPercent = Math.max(-1, Math.min(1, delta.current));
  const gaugePosition = ((deltaPercent + 1) / 2) * 100; // 0-100%に変換
  const absDelta = Math.abs(deltaPercent);

  // デルタ状態の色
  const getDeltaColor = () => {
    if (absDelta < 0.05) return 'var(--success)';
    if (absDelta < 0.15) return '#f59e0b';
    if (absDelta < 0.3) return '#f97316';
    return 'var(--danger)';
  };

  const getTrendEmoji = (trend: string) => {
    switch (trend) {
      case 'uptrend': return '📈';
      case 'downtrend': return '📉';
      default: return '➡️';
    }
  };

  const getTrendLabel = (trend: string) => {
    switch (trend) {
      case 'uptrend': return '上昇';
      case 'downtrend': return '下落';
      default: return 'レンジ';
    }
  };

  const getRsiColor = (rsi: number) => {
    if (rsi < 30) return 'var(--danger)';
    if (rsi > 70) return 'var(--danger)';
    if (rsi < 40 || rsi > 60) return '#f59e0b';
    return 'var(--success)';
  };

  // 証拠金ヘルスの計算
  const marginHealth = hedge?.active && hedge.marginBalance > 0 
    ? Math.min(100, (hedge.marginBalance / (hedge.maintenanceMargin || 1)) * 100) 
    : 0;

  return (
    <div className="glass-panel delta-gauge">
      <h3 className="delta-gauge-title">
        <Shield size={16} />
        デルタ・ニュートラル & 指標
      </h3>

      {/* デルタゲージ */}
      <div className="delta-gauge-container">
        <div className="delta-gauge-labels">
          <span>ショート (-1.0)</span>
          <span style={{ color: 'var(--success)', fontWeight: 600 }}>ニュートラル (0)</span>
          <span>ロング (+1.0)</span>
        </div>
        <div className="delta-gauge-track">
          <div
            className="delta-gauge-needle"
            style={{
              left: `${gaugePosition}%`,
              background: getDeltaColor(),
              boxShadow: `0 0 12px ${getDeltaColor()}`,
            }}
          />
          {/* 中央マーカー */}
          <div className="delta-gauge-center" />
        </div>
        <div className="delta-gauge-value" style={{ color: getDeltaColor() }}>
          Δ = {deltaPercent >= 0 ? '+' : ''}{deltaPercent.toFixed(3)}
        </div>
        <div className="delta-recommendation">{delta.recommendation}</div>
      </div>

      {/* ヘッジ・証拠金情報 */}
      {hedge && (
        <div className="hedge-info">
          <div className="hedge-info-title">
            <Activity size={14} />
            ヘッジ & 証拠金監視
            <span className={`hedge-badge ${hedge.active ? 'hedge-active' : 'hedge-inactive'}`}>
              {hedge.active ? '稼働中' : '未稼働'}
            </span>
            <span className="hedge-mode-badge">{hedge.mode === 'simulate' ? 'SIM' : 'LIVE'}</span>
          </div>

          {hedge.active && (
            <div className="hedge-details">
              <div className="hedge-detail-row">
                <span>ショートサイズ</span>
                <strong>${hedge.size.toFixed(2)}</strong>
              </div>
              
              {/* 証拠金ヘルスバー */}
              {hedge.marginBalance > 0 && (
                <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid rgba(255, 255, 255, 0.05)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Shield size={12} /> Bluefin 証拠金ヘルス
                    </span>
                    <span style={{ 
                      fontSize: '0.75rem', 
                      fontWeight: 600, 
                      color: marginHealth > 60 ? 'var(--success)' : marginHealth > 45 ? 'var(--warning)' : 'var(--danger)'
                    }}>
                      {marginHealth.toFixed(1)}%
                    </span>
                  </div>
                  <div style={{ 
                    height: '8px', 
                    background: 'rgba(255, 255, 255, 0.05)', 
                    borderRadius: '10px', 
                    overflow: 'hidden',
                    position: 'relative'
                  }}>
                    <div style={{ 
                      width: `${Math.min(100, marginHealth)}%`, 
                      height: '100%', 
                      background: `linear-gradient(90deg, ${marginHealth > 45 ? '#2ed573' : '#ff4757'} 0%, #58a6ff 100%)`,
                      boxShadow: '0 0 10px rgba(88, 166, 255, 0.3)',
                      transition: 'width 1s ease-in-out'
                    }} />
                    {/* 維持証拠金（40%）のしきい値ライン */}
                    <div style={{
                      position: 'absolute',
                      left: '40%',
                      top: 0,
                      bottom: 0,
                      width: '2px',
                      background: 'rgba(248, 81, 73, 0.5)',
                      zIndex: 1
                    }} title="維持証拠金しきい値 (40%)" />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px' }}>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>維持しきい値: 40%</span>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>目標: 50%+</span>
                  </div>
                </div>
              )}

              <div className="hedge-detail-row">
                <span>エントリー価格</span>
                <strong>${hedge.entryPrice.toFixed(4)}</strong>
              </div>
              <div className="hedge-detail-row">
                <span>現在PnL</span>
                <strong style={{ color: hedge.currentPnl >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                  {hedge.currentPnl >= 0 ? '+' : ''}${hedge.currentPnl.toFixed(4)}
                </strong>
              </div>
            </div>
          )}
        </div>
      )}

      {/* テクニカル指標 */}
      {indicators && (
        <div className="indicators-section">
          <div className="indicators-title">テクニカル指標</div>
          <div className="indicators-grid">
            <div className="indicator-item">
              <div className="indicator-label">RSI</div>
              <div className="indicator-value" style={{ color: getRsiColor(indicators.rsi) }}>
                {indicators.rsi.toFixed(1)}
              </div>
              <div className="indicator-bar-track">
                <div
                  className="indicator-bar-fill"
                  style={{
                    width: `${indicators.rsi}%`,
                    background: getRsiColor(indicators.rsi),
                  }}
                />
              </div>
            </div>
            <div className="indicator-item">
              <div className="indicator-label">ボラティリティ</div>
              <div className="indicator-value">{indicators.volatility.toFixed(2)}%</div>
              <div className="indicator-bar-track">
                <div
                  className="indicator-bar-fill"
                  style={{
                    width: `${Math.min(indicators.volatility * 10, 100)}%`,
                    background: indicators.volatility > 5 ? '#f97316' : 'var(--accent)',
                  }}
                />
              </div>
            </div>
            <div className="indicator-item">
              <div className="indicator-label">トレンド</div>
              <div className="indicator-value">
                {getTrendEmoji(indicators.trend)} {getTrendLabel(indicators.trend)}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
