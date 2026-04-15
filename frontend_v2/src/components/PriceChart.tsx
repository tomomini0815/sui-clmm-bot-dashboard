import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Area } from 'recharts';

interface PriceChartProps {
  data: any[];
  pythData: any[];
  lowerBound: number;
  upperBound: number;
}

export const PriceChart: React.FC<PriceChartProps> = ({ data, pythData, lowerBound, upperBound }) => {
  const currentPrice = data.length > 0 ? data[data.length - 1].price : 0;
  const priceChange = data.length > 1 ? ((currentPrice - data[0].price) / data[0].price * 100) : 0;
  
  return (
    <div className="glass-panel" style={{ 
      height: '420px', 
      display: 'flex', 
      flexDirection: 'column',
    }}>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        marginBottom: '18px',
        flexWrap: 'wrap',
        gap: '12px'
      }}>
        <div>
          <h2 style={{ 
            fontSize: '1.1rem', 
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            SUI / USDC 価格チャート
          </h2>
          {data.length > 0 && (
            <p style={{ 
              fontSize: '0.8rem', 
              color: 'var(--text-muted)',
              marginTop: '4px'
            }}>
              最新: {data[data.length - 1].time} 更新
            </p>
          )}
        </div>
        
        {/* 凡例 */}
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', fontSize: '0.8rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ width: '20px', height: '3px', background: 'var(--accent)', borderRadius: '2px' }}></div>
            <span style={{ color: 'var(--text-muted)' }}>プール価格</span>
          </div>
          {pythData.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '20px', height: '3px', background: '#f97316', borderRadius: '2px', borderStyle: 'dashed' }}></div>
              <span style={{ color: 'var(--text-muted)' }}>市場価格 (Pyth)</span>
            </div>
          )}
        </div>
        
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          {currentPrice > 0 && (
            <div style={{
              background: priceChange >= 0 ? 'rgba(63, 185, 80, 0.1)' : 'rgba(248, 81, 73, 0.1)',
              padding: '8px 14px',
              borderRadius: '8px',
              border: `1px solid ${priceChange >= 0 ? 'rgba(63, 185, 80, 0.25)' : 'rgba(248, 81, 73, 0.25)'}`,
              fontSize: '0.85rem',
            }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '2px' }}>現在価格</div>
              <div style={{ fontWeight: 700, color: priceChange >= 0 ? 'var(--success)' : 'var(--danger)', fontSize: '1.1rem' }}>
                {currentPrice.toFixed(4)} USDC
              </div>
              <div style={{ 
                fontSize: '0.8rem', 
                fontWeight: 600, 
                color: priceChange >= 0 ? 'var(--success)' : 'var(--danger)',
                marginTop: '2px'
              }}>
                {priceChange >= 0 ? '↑' : '↓'} {Math.abs(priceChange).toFixed(2)}%
              </div>
            </div>
          )}
          
          {lowerBound > 0 && upperBound > 0 && (
            <div style={{
              background: 'rgba(88, 166, 255, 0.08)',
              padding: '8px 14px',
              borderRadius: '8px',
              border: '1px solid rgba(88, 166, 255, 0.2)',
              fontSize: '0.8rem',
            }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '4px' }}>レンジ幅</div>
              <div style={{ fontWeight: 600 }}>
                <span style={{ color: 'var(--danger)' }}>{lowerBound.toFixed(2)}</span>
                <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>〜</span>
                <span style={{ color: 'var(--success)' }}>{upperBound.toFixed(2)}</span>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                幅: {((upperBound - lowerBound) / lowerBound * 100).toFixed(1)}%
              </div>
            </div>
          )}
        </div>
      </div>
      
      <div style={{ flex: 1, width: '100%' }}>
        {data.length === 0 ? (
          <div style={{ 
            height: '100%', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.95rem'
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ marginBottom: '8px' }}>📊</div>
              <div>Botを起動すると価格チャートが表示されます</div>
              <div style={{ fontSize: '0.8rem', marginTop: '4px', opacity: 0.7 }}>
                3秒ごとに自動更新
              </div>
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 10, right: 30, left: 10, bottom: 10 }}>
              <defs>
                <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.2}/>
                  <stop offset="95%" stopColor="var(--accent)" stopOpacity={0}/>
                </linearGradient>
              </defs>
              
              <XAxis 
                dataKey="time" 
                stroke="var(--text-muted)" 
                fontSize={10} 
                tickLine={false} 
                axisLine={{ stroke: 'rgba(255, 255, 255, 0.08)' }}
                tick={{ fill: 'var(--text-muted)' }}
                interval="preserveStartEnd"
              />
              <YAxis 
                domain={[
                  (dataMin: number) => Number((dataMin * 0.995).toFixed(4)), 
                  (dataMax: number) => Number((dataMax * 1.005).toFixed(4))
                ]} 
                stroke="var(--text-muted)" 
                fontSize={10} 
                tickLine={false} 
                axisLine={{ stroke: 'rgba(255, 255, 255, 0.08)' }}
                tick={{ fill: 'var(--text-muted)' }}
                tickFormatter={(value) => value.toFixed(2)}
                width={60}
              />
              <Tooltip 
                contentStyle={{ 
                  background: 'rgba(22, 27, 34, 0.95)', 
                  border: '1px solid rgba(88, 166, 255, 0.25)', 
                  borderRadius: '10px',
                  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)'
                }}
                itemStyle={{ color: 'var(--accent)', fontWeight: 600 }}
                labelStyle={{ color: 'var(--text-muted)', marginBottom: '8px' }}
                formatter={(value: number) => [`${value.toFixed(4)} USDC`, 'SUI価格']}
              />
              
              {/* 上限レンジ */}
              {upperBound > 0 && (
                <ReferenceLine 
                  y={upperBound} 
                  stroke="var(--success)" 
                  strokeWidth={2}
                  strokeDasharray="4 4" 
                  label={{ 
                    position: 'top', 
                    value: '上限', 
                    fill: 'var(--success)', 
                    fontSize: 10,
                    fontWeight: 600
                  }} 
                />
              )}
              
              {/* 下限レンジ */}
              {lowerBound > 0 && (
                <ReferenceLine 
                  y={lowerBound} 
                  stroke="var(--danger)" 
                  strokeWidth={2}
                  strokeDasharray="4 4" 
                  label={{ 
                    position: 'bottom', 
                    value: '下限', 
                    fill: 'var(--danger)', 
                    fontSize: 10,
                    fontWeight: 600
                  }} 
                />
              )}
              
              {/* エリアチャート（グラデーション） */}
              <Area 
                type="monotone" 
                dataKey="price" 
                fill="url(#priceGradient)" 
                stroke="none"
              />
              
              {/* メインのライン（プール価格） */}
              <Line 
                type="monotone" 
                dataKey="price" 
                name="プール価格" 
                stroke="var(--accent)" 
                strokeWidth={2.5} 
                dot={false}
                activeDot={{ 
                  r: 5, 
                  stroke: 'var(--accent)', 
                  strokeWidth: 2,
                  fill: 'rgba(22, 27, 34, 0.95)'
                }}
              />
              
              {/* Pyth市場価格のライン */}
              {pythData.length > 0 && (
                <Line 
                  type="monotone" 
                  data={pythData}
                  dataKey="price" 
                  name="市場価格 (Pyth)" 
                  stroke="#f97316" 
                  strokeWidth={2} 
                  strokeDasharray="5 5"
                  dot={false}
                  activeDot={{ 
                    r: 4, 
                    stroke: '#f97316', 
                    strokeWidth: 2,
                    fill: 'rgba(22, 27, 34, 0.95)'
                  }}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
};
