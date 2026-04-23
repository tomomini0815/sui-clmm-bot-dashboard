import React from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Wallet, ChevronDown, ChevronUp } from 'lucide-react';

interface BalanceHistoryItem {
  timestamp: string;
  suiBalance: number;
  usdcBalance: number;
  bluefinMargin: number;
  totalValueUsdc: number;
  time: string;
  date: string;
}

interface BalanceChartProps {
  data: BalanceHistoryItem[];
}

export const BalanceChart = React.memo<BalanceChartProps>(({ data }) => {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [timeRange, setTimeRange] = React.useState<'1D' | '1W' | '1M' | 'ALL'>('1D');

  // 選択されたレンジに基づいてデータをフィルタリング（全フックは早期リターンの前に宣言）
  const filteredData = React.useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];
    if (timeRange === 'ALL') return data;
    
    const now = new Date();
    const cutoff = new Date();
    
    if (timeRange === '1D') cutoff.setHours(now.getHours() - 24);
    else if (timeRange === '1W') cutoff.setDate(now.getDate() - 7);
    else if (timeRange === '1M') cutoff.setMonth(now.getMonth() - 1);
    
    return data.filter(item => {
      const d = new Date(item.timestamp);
      return !isNaN(d.getTime()) && d >= cutoff;
    });
  }, [data, timeRange]);

  // データが全くない場合の表示
  if (!data || data.length === 0) {
    return (
      <div className="glass-panel" style={{ marginBottom: '24px', padding: '16px', cursor: 'pointer' }} onClick={() => setIsExpanded(!isExpanded)}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Wallet size={20} style={{ color: 'var(--text-muted)' }} />
            <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>資産残高推移</h3>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>データ収集中...</span>
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </div>
        {isExpanded && (
          <div style={{ height: '150px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '8px', marginTop: '16px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
             <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>スナップショットを記録中です。数分お待ちください。</p>
          </div>
        )}
      </div>
    );
  }

  // チャートを表示するかどうかの判定
  const hasEnoughData = Array.isArray(filteredData) && filteredData.length >= 2;
  const latestData = Array.isArray(data) && data.length > 0 ? data[data.length - 1] : null;

  if (!latestData) return null;

  const currentTotal = latestData.totalValueUsdc || 0;
  const initialData = Array.isArray(data) && data.length > 0 ? data[0] : latestData;
  const initialTotal = initialData.totalValueUsdc || currentTotal;
  const totalChange = currentTotal - initialTotal;
  const totalChangePercent = initialTotal > 0 ? (totalChange / initialTotal) * 100 : 0;

  return (
    <div className="glass-panel balance-chart-container" style={{ 
      padding: '24px', 
      transition: 'all 0.3s ease'
    }}>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        cursor: 'pointer' 
      }} onClick={() => setIsExpanded(!isExpanded)}>
        
        {/* 左側: タイトル */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h3 style={{ fontSize: '0.9rem', fontWeight: 700, margin: 0, color: 'var(--text-main)', whiteSpace: 'nowrap' }}>資産残高推移</h3>
        </div>

        {/* 右側: 期間選択 ＋ 資産情報 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* レンジセレクター (右側に移動) */}
          <div style={{ 
            display: 'flex', 
            background: 'rgba(255, 255, 255, 0.05)', 
            borderRadius: '8px', 
            padding: '2px',
            border: '1px solid rgba(255, 255, 255, 0.08)'
          }}>
            {(['1D', '1W', '1M', 'ALL'] as const).map(range => (
              <button
                key={range}
                onClick={(e) => { e.stopPropagation(); setTimeRange(range); }}
                style={{
                  padding: '4px 10px',
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  borderRadius: '6px',
                  background: timeRange === range ? 'var(--accent)' : 'transparent',
                  color: timeRange === range ? 'white' : 'var(--text-muted)',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                {range === 'ALL' ? '全期間' : range === '1D' ? '1日' : range === '1W' ? '1週間' : '1ヶ月'}
              </button>
            ))}
          </div>

          <div style={{ textAlign: 'right' }}>
            <div style={{ 
              fontSize: isExpanded ? '1.2rem' : '1.4rem', 
              fontWeight: 800, 
              color: 'var(--text-main)',
              lineHeight: 1 
            }}>
              ${currentTotal.toFixed(2)}
            </div>
            <div style={{ 
              fontSize: '0.75rem', 
              fontWeight: 600, 
              color: totalChange >= 0 ? 'var(--success)' : 'var(--danger)',
              marginTop: '2px'
            }}>
              {totalChange >= 0 ? '+' : ''}{totalChange.toFixed(2)} ({totalChangePercent.toFixed(2)}%)
            </div>
          </div>
          <div style={{ color: 'var(--text-muted)' }}>
            {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </div>
        </div>
      </div>

      {isExpanded && (
        <div style={{ marginTop: '20px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '20px' }}>
          <div style={{ width: '100%', height: 260 }}>
            {!hasEnoughData ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '12px' }}>
                <div style={{ fontSize: '2rem' }}>📈</div>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center' }}>
                  最初のデータポイントを記録しました (${currentTotal.toFixed(2)})。<br/>
                  2点目の記録（10分後）からグラフが表示されます。
                </p>
                <div style={{ fontSize: '0.75rem', color: 'var(--accent)', background: 'rgba(88,166,255,0.1)', padding: '4px 12px', borderRadius: '20px' }}>
                  現在: {latestData.time} 時点の残高を維持
                </div>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={filteredData}
                  margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="var(--accent)" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
                  <XAxis 
                    dataKey="time" 
                    hide={filteredData.length > 50}
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                  />
                  <YAxis hide domain={['auto', 'auto']} />
                  <Tooltip
                    contentStyle={{ 
                      backgroundColor: 'rgba(13, 17, 23, 0.95)', 
                      border: '1px solid var(--border-panel)',
                      borderRadius: '8px',
                      fontSize: '0.8rem'
                    }}
                    labelStyle={{ color: 'var(--text-muted)', marginBottom: '4px' }}
                    formatter={(value: any) => [`$${Number(value).toFixed(2)}`, '総資産']}
                  />
                  <Area
                    type="monotone"
                    dataKey="totalValueUsdc"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorTotal)"
                    animationDuration={1000}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginTop: '16px' }}>
            <div style={{ padding: '8px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '2px' }}>Wallet SUI</div>
              <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{latestData.suiBalance.toFixed(3)}</div>
            </div>
            <div style={{ padding: '8px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '2px' }}>Wallet USDC</div>
              <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>${latestData.usdcBalance.toFixed(2)}</div>
            </div>
            <div style={{ padding: '8px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '2px' }}>Bluefin</div>
              <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>${latestData.bluefinMargin.toFixed(2)}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
