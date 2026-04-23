import { TrendingUp, TrendingDown, Fuel, DollarSign, Clock, Percent } from 'lucide-react';

interface PnlData {
  lpPnl: number;
  hedgePnl: number;
  fees: number;
  gasCost: number;
  fundingCost: number;
  netPnl: number;
  apr: number;
  dailyPnl: number;
  elapsedHours: number;
}

interface GasStats {
  totalGasSui: number;
  totalGasUsdc: number;
  txCount: number;
  avgGasPerTx: number;
}

interface PnLCardProps {
  pnl: PnlData | null;
  gasStats: GasStats | null;
}

// NOTE: React.memo を外してある — pnl オブジェクトの参照が変わらなくても
// 毎ポーリングで確実に再レンダリングするため
export const PnLCard = ({ pnl, gasStats }: PnLCardProps) => {
  // pnl が null の場合はゼロフィルでフォールバック（ボット待機中の表示を維持しつつ更新に備える）
  const safePnl: PnlData = pnl ?? {
    lpPnl: 0, hedgePnl: 0, fees: 0, gasCost: 0,
    fundingCost: 0, netPnl: 0, apr: 0, dailyPnl: 0, elapsedHours: 0
  };
  const hasData = pnl !== null;
  if (!hasData) {
    return (
      <div className="glass-panel pnl-card">
        <h3 className="pnl-card-title">
          <DollarSign size={16} />
          損益状況
        </h3>
        <div className="pnl-waiting">
          <div className="pnl-waiting-icon">📊</div>
          <p>ボットを起動して取引を開始すると、ここにリアルタイム損益が表示されます。</p>
        </div>
      </div>
    );
  }

  const isProfit = safePnl.netPnl >= 0;

  return (
    <div className="glass-panel pnl-card">
      <h3 className="pnl-card-title">
        <DollarSign size={16} />
        リアルタイム損益
      </h3>

      {/* メインPnL表示 */}
      <div className={`pnl-main ${isProfit ? 'pnl-profit' : 'pnl-loss'}`}>
        <div className="pnl-main-value">
          {isProfit ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
          <span>{isProfit ? '+' : ''}${safePnl.netPnl.toFixed(4)}</span>
        </div>
        <div className="pnl-main-label">純利益 (Net P&L)</div>
      </div>

      {/* APR / 日次 */}
      <div className="pnl-metrics-row">
        <div className="pnl-metric">
          <Percent size={13} />
          <div>
            <div className="pnl-metric-value" style={{ color: safePnl.apr >= 0 ? 'var(--success)' : 'var(--danger)' }}>
              {safePnl.apr >= 0 ? '+' : ''}{safePnl.apr.toFixed(1)}%
            </div>
            <div className="pnl-metric-label">推定APR</div>
          </div>
        </div>
        <div className="pnl-metric">
          <TrendingUp size={13} />
          <div>
            <div className="pnl-metric-value">
              {safePnl.dailyPnl >= 0 ? '+' : ''}${safePnl.dailyPnl.toFixed(4)}
            </div>
            <div className="pnl-metric-label">日次P&L</div>
          </div>
        </div>
        <div className="pnl-metric">
          <Clock size={13} />
          <div>
            <div className="pnl-metric-value">{safePnl.elapsedHours.toFixed(1)}h</div>
            <div className="pnl-metric-label">運用時間</div>
          </div>
        </div>
      </div>

      {/* 内訳 */}
      <div className="pnl-breakdown">
        <div className="pnl-breakdown-title">損益の内訳</div>

        <div className="pnl-breakdown-row">
          <span className="pnl-breakdown-label">LP損益</span>
          <span className={safePnl.lpPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
            {safePnl.lpPnl >= 0 ? '+' : ''}${safePnl.lpPnl.toFixed(4)}
          </span>
        </div>

        <div className="pnl-breakdown-row">
          <span className="pnl-breakdown-label">ヘッジ損益</span>
          <span className={safePnl.hedgePnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
            {safePnl.hedgePnl >= 0 ? '+' : ''}${safePnl.hedgePnl.toFixed(4)}
          </span>
        </div>

        <div className="pnl-breakdown-row">
          <span className="pnl-breakdown-label">手数料累計</span>
          <span className="pnl-positive">+${safePnl.fees.toFixed(4)}</span>
        </div>

        <div className="pnl-breakdown-row">
          <span className="pnl-breakdown-label">Funding コスト</span>
          <span className={safePnl.fundingCost >= 0 ? 'pnl-positive' : 'pnl-negative'}>
            {safePnl.fundingCost >= 0 ? '+' : ''}${safePnl.fundingCost.toFixed(4)}
          </span>
        </div>

        <div className="pnl-breakdown-row pnl-breakdown-gas">
          <span className="pnl-breakdown-label">
            <Fuel size={12} /> ガス代累計
          </span>
          <span className="pnl-negative">-${safePnl.gasCost.toFixed(4)}</span>
        </div>
      </div>

      {/* ガス統計 */}
      {gasStats && gasStats.txCount > 0 && (
        <div className="pnl-gas-stats">
          <div className="pnl-gas-stat">
            <span>TX回数</span>
            <strong>{gasStats.txCount}</strong>
          </div>
          <div className="pnl-gas-stat">
            <span>平均ガス</span>
            <strong>${gasStats.avgGasPerTx.toFixed(4)}</strong>
          </div>
          <div className="pnl-gas-stat">
            <span>ガス合計</span>
            <strong>{gasStats.totalGasSui.toFixed(4)} SUI</strong>
          </div>
        </div>
      )}
    </div>
  );
};
