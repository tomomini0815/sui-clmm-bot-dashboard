import { Activity, CheckCircle2, Circle, Gauge, RotateCw, TrendingUp, AlertTriangle } from 'lucide-react';

interface RuntimeRange {
  lower: number;
  upper: number;
}

interface RuntimeBot {
  name: string;
  pair: string;
  active: boolean;
  phase?: string;
  currentPrice?: number;
  priceSuffix?: string;
  currentRange?: RuntimeRange;
  lpValue?: number;
  rebalances?: number;
  isUnbalanced?: boolean;
}

interface BotRuntimeStatusProps {
  bots: RuntimeBot[];
}

const hasRange = (range?: RuntimeRange) => {
  return typeof range?.lower === 'number' && typeof range?.upper === 'number' && range.lower > 0 && range.upper > 0;
};

const formatPrice = (price: number) => {
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
};

export function BotRuntimeStatus({ bots }: BotRuntimeStatusProps) {
  const visibleBots = bots.filter((bot) => bot.name && bot.pair);

  if (visibleBots.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{
            width: '30px',
            height: '30px',
            borderRadius: '8px',
            background: 'rgba(88,166,255,0.12)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent)'
          }}>
            <Activity size={16} />
          </div>
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 800 }}>Bot稼働状況</h3>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {visibleBots.map((bot) => {
          const inRange = bot.currentPrice && hasRange(bot.currentRange)
            ? bot.currentPrice >= bot.currentRange!.lower && bot.currentPrice <= bot.currentRange!.upper
            : null;
          const rangePct = bot.currentPrice && hasRange(bot.currentRange)
            ? Math.max(0, Math.min(100, ((bot.currentPrice - bot.currentRange!.lower) / (bot.currentRange!.upper - bot.currentRange!.lower)) * 100))
            : null;

          return (
            <section
              key={bot.name}
              style={{
                minWidth: 0,
                borderRadius: '12px',
                border: `1px solid ${bot.active ? 'rgba(63,185,80,0.18)' : 'rgba(255,255,255,0.06)'}`,
                background: bot.active ? 'rgba(63,185,80,0.045)' : 'rgba(255,255,255,0.025)',
                padding: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.9rem', fontWeight: 850, color: 'var(--text-main)' }}>{bot.name}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {bot.pair}
                  </div>
                </div>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  borderRadius: '999px',
                  padding: '3px 7px',
                  fontSize: '0.66rem',
                  fontWeight: 800,
                  color: bot.active ? 'var(--success)' : 'var(--text-muted)',
                  background: bot.active ? 'rgba(63,185,80,0.1)' : 'rgba(139,148,158,0.08)',
                  border: `1px solid ${bot.active ? 'rgba(63,185,80,0.2)' : 'rgba(139,148,158,0.14)'}`,
                  flexShrink: 0
                }}>
                  <Circle size={7} fill="currentColor" />
                  {bot.active ? '稼働中' : '停止中'}
                </span>
              </div>

              {bot.phase && (
                <div style={{
                  fontSize: '0.72rem',
                  color: 'var(--text-muted)',
                  background: 'rgba(0,0,0,0.16)',
                  borderRadius: '8px',
                  padding: '7px 8px'
                }}>
                  工程: <strong style={{ color: 'var(--text-main)' }}>{bot.phase}</strong>
                </div>
              )}

              {typeof bot.lpValue === 'number' && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '0.76rem' }}>
                  <span style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    <TrendingUp size={13} /> LP評価額
                  </span>
                  <strong style={{ color: 'var(--accent)' }}>${bot.lpValue.toFixed(2)}</strong>
                </div>
              )}

              {typeof bot.currentPrice === 'number' && bot.currentPrice > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '0.76rem' }}>
                  <span style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    <Gauge size={13} /> 現在価格
                  </span>
                  <strong>{formatPrice(bot.currentPrice)} {bot.priceSuffix || ''}</strong>
                </div>
              )}

              {hasRange(bot.currentRange) && (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '9px',
                  borderRadius: '10px',
                  border: `1px solid ${inRange ? 'rgba(63,185,80,0.24)' : 'rgba(210,153,34,0.24)'}`,
                  background: inRange ? 'rgba(63,185,80,0.075)' : 'rgba(210,153,34,0.075)',
                  padding: '10px'
                }}>
                  {inRange !== null && (
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      color: inRange ? 'var(--success)' : 'var(--warning)',
                      fontSize: '0.82rem',
                      fontWeight: 850
                    }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        {inRange ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                        {inRange ? 'レンジ内で稼働中' : 'レンジ外'}
                      </span>
                    </div>
                  )}

                  <div style={{
                    position: 'relative',
                    height: '8px',
                    borderRadius: '999px',
                    background: 'rgba(255,255,255,0.1)',
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      position: 'absolute',
                      inset: 0,
                      background: inRange ? 'linear-gradient(90deg, rgba(63,185,80,0.28), rgba(78,242,194,0.65), rgba(63,185,80,0.28))' : 'rgba(210,153,34,0.32)'
                    }} />
                    {rangePct !== null && (
                      <div style={{
                        position: 'absolute',
                        top: '-3px',
                        left: `${rangePct}%`,
                        width: '4px',
                        height: '14px',
                        borderRadius: '999px',
                        background: '#fff',
                        boxShadow: '0 0 8px rgba(255,255,255,0.6)',
                        transform: 'translateX(-50%)'
                      }} />
                    )}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    <span>下限 {formatPrice(bot.currentRange!.lower)}</span>
                    <span>上限 {formatPrice(bot.currentRange!.upper)}</span>
                  </div>
                </div>
              )}

              {typeof bot.rebalances === 'number' && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '0.76rem' }}>
                  <span style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    <RotateCw size={13} /> 再配置
                  </span>
                  <strong>{bot.rebalances}回</strong>
                </div>
              )}

              {bot.isUnbalanced && (
                <div style={{
                  borderRadius: '8px',
                  background: 'rgba(255,159,67,0.1)',
                  border: '1px solid rgba(255,159,67,0.22)',
                  color: '#ffb86b',
                  padding: '8px',
                  fontSize: '0.7rem',
                  lineHeight: 1.45
                }}>
                  資金バランスに偏りがあります。
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
