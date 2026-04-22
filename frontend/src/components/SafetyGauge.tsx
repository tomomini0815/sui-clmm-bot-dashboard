import { ShieldAlert, Clock, TrendingDown, AlertTriangle, CheckCircle } from 'lucide-react';

interface SafetyGaugeProps {
  drawdownPct: number;       // 0-10 (%)
  marginRatio: number;       // % (150が危険ライン)
  priceDataAge: number;      // 秒 (60が上限)
  consecutiveErrors: number; // 連続エラー数 (3で停止)
  isEmergency: boolean;
}

export function SafetyGauge({
  drawdownPct = 0,
  marginRatio = 999,
  priceDataAge = 0,
  consecutiveErrors = 0,
  isEmergency = false,
}: SafetyGaugeProps) {
  const drawdownWarn = drawdownPct >= 10 && drawdownPct < 15;
  const drawdownDanger = drawdownPct >= 15;

  const marginWarn = marginRatio <= 130 && marginRatio >= 110;
  const marginDanger = marginRatio < 110;

  const ageWarn = priceDataAge >= 60 && priceDataAge < 120;
  const ageDanger = priceDataAge >= 120;

  const errorWarn = consecutiveErrors === 1 || consecutiveErrors === 2;
  const errorDanger = consecutiveErrors >= 3;

  const getColor = (warn: boolean, danger: boolean) => {
    if (danger) return 'var(--danger)';
    if (warn) return '#f97316';
    return 'var(--success)';
  };

  const getGaugeWidth = (value: number, max: number) =>
    `${Math.min((value / max) * 100, 100)}%`;

  if (isEmergency) {
    return (
      <div className="glass-panel" style={{
        border: '1px solid rgba(255, 59, 48, 0.6)',
        background: 'rgba(255, 59, 48, 0.1)',
        padding: '16px',
        marginBottom: '16px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--danger)' }}>
          <ShieldAlert size={20} />
          <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>🚨 緊急停止中</span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '6px' }}>
          安全ゲートが発動しました。手動で確認してから再起動してください。
        </p>
      </div>
    );
  }

  const gates = [
    {
      label: 'Drawdown',
      value: `${drawdownPct.toFixed(2)}%`,
      sub: '上限 15%',
      icon: <TrendingDown size={14} />,
      barWidth: getGaugeWidth(drawdownPct, 15),
      color: getColor(drawdownWarn, drawdownDanger),
      danger: drawdownDanger,
    },
    {
      label: '証拠金比率',
      value: marginRatio >= 999 ? 'N/A' : `${marginRatio.toFixed(0)}%`,
      sub: '下限 110%',
      icon: <ShieldAlert size={14} />,
      barWidth: marginRatio >= 999 ? '100%' : getGaugeWidth(Math.max(0, marginRatio - 110), 390),
      color: getColor(marginWarn, marginDanger),
      danger: marginDanger,
    },
    {
      label: '価格データ鮮度',
      value: `${priceDataAge.toFixed(0)}秒前`,
      sub: '上限 120秒',
      icon: <Clock size={14} />,
      barWidth: getGaugeWidth(priceDataAge, 120),
      color: getColor(ageWarn, ageDanger),
      danger: ageDanger,
    },
    {
      label: '連続エラー',
      value: `${consecutiveErrors}/3`,
      sub: '3回で自動停止',
      icon: <AlertTriangle size={14} />,
      barWidth: getGaugeWidth(consecutiveErrors, 3),
      color: getColor(errorWarn, errorDanger),
      danger: errorDanger,
    },
  ];

  const allSafe = !drawdownDanger && !marginDanger && !ageDanger && !errorDanger;

  return (
    <div className="glass-panel" style={{ padding: '16px', marginBottom: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <ShieldAlert size={15} color="var(--accent)" />
          安全ゲート
        </h3>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          fontSize: '0.75rem', fontWeight: 600,
          color: allSafe ? 'var(--success)' : 'var(--danger)',
        }}>
          {allSafe
            ? <><CheckCircle size={12} /> すべて正常</>
            : <><AlertTriangle size={12} /> 警告あり</>
          }
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {gates.map((gate) => (
          <div key={gate.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', color: gate.color, fontSize: '0.78rem' }}>
                {gate.icon}
                <span>{gate.label}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{gate.sub}</span>
                <span style={{ fontSize: '0.82rem', fontWeight: 700, color: gate.color }}>{gate.value}</span>
              </div>
            </div>
            <div style={{
              height: '4px', borderRadius: '2px',
              background: 'rgba(255,255,255,0.06)',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', width: gate.barWidth,
                background: gate.color,
                borderRadius: '2px',
                transition: 'width 0.5s ease',
                boxShadow: gate.danger ? `0 0 6px ${gate.color}` : 'none',
              }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
