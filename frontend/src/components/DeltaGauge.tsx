import React from 'react';
import { Shield, AlertTriangle, Activity } from 'lucide-react';

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

      {/* ヘッジ情報 */}
      {hedge && (
        <div className="hedge-info">
          <div className="hedge-info-title">
            <Activity size={14} />
            ヘッジポジション
            <span className={`hedge-badge ${hedge.active ? 'hedge-active' : 'hedge-inactive'}`}>
              {hedge.active ? '稼働中' : '未稼働'}
            </span>
            <span className="hedge-mode-badge">{hedge.mode === 'simulate' ? 'SIM' : 'LIVE'}</span>
          </div>

          {hedge.active && (
            <div className="hedge-details">
              <div className="hedge-detail-row">
                <span>サイズ</span>
                <strong>${hedge.size.toFixed(2)}</strong>
              </div>
              <div className="hedge-detail-row">
                <span>エントリー</span>
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
