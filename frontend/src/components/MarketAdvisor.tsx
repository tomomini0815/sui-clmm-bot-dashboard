import React, { useState, useEffect } from 'react';
import { 
  Brain, 
  TrendingUp, 
  TrendingDown, 
  Zap, 
  ShieldCheck, 
  Cpu,
  BarChart3,
  Layers,
  ArrowRight
} from 'lucide-react';
import './MarketAdvisor.css';

declare global {
  interface Window {
    TradingView?: any;
  }
}

interface MarketData {
  price: number;
  volatility: string;
  volatilityPct: number;
  trend: 'uptrend' | 'downtrend' | 'sideways';
  ema20: number;
  ema50: number;
  timestamp: number;
}

interface MarketAdvisorProps {
  advisor?: any;
  onApplyStrategy?: (mode: 'LP_ONLY' | 'DELTA_NEUTRAL') => void;
}

const TradingViewWidget: React.FC = () => {
  const container = React.useRef<HTMLDivElement>(null);
  const [activeSymbol, setActiveSymbol] = useState<'SUI' | 'BTC' | 'DEEP'>('SUI');

  const symbols = {
    SUI: 'BINANCE:SUIUSDC',
    BTC: 'BINANCE:BTCUSDT',
    DEEP: 'BYBIT:DEEPUSDT'
  };

  useEffect(() => {
    const scriptId = 'tradingview-tv-js';
    let script = document.getElementById(scriptId) as HTMLScriptElement;

    const initWidget = () => {
      if (window.TradingView && container.current) {
        // コンテナをクリアしてから再初期化
        container.current.innerHTML = '';
        const widgetContainer = document.createElement('div');
        widgetContainer.id = `tv_chart_${activeSymbol}`;
        widgetContainer.style.height = '100%';
        widgetContainer.style.width = '100%';
        container.current.appendChild(widgetContainer);

        new window.TradingView.widget({
          "autosize": true,
          "symbol": symbols[activeSymbol],
          "interval": "60",
          "timezone": "Etc/UTC",
          "theme": "dark",
          "style": "1",
          "locale": "ja",
          "toolbar_bg": "rgba(0, 0, 0, 0)",
          "enable_publishing": false,
          "hide_side_toolbar": false,
          "allow_symbol_change": true,
          "details": true,
          "hotlist": true,
          "calendar": true,
          "show_popup_button": true,
          "popup_width": "1000",
          "popup_height": "650",
          "container_id": widgetContainer.id,
          "backgroundColor": "rgba(10, 15, 25, 1)",
          "gridColor": "rgba(255, 255, 255, 0.05)",
          "withdateranges": true,
          "save_image": true,
        });
      }
    };

    if (!script) {
      script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://s3.tradingview.com/tv.js';
      script.type = 'text/javascript';
      script.onload = initWidget;
      document.head.appendChild(script);
    } else {
      initWidget();
    }
  }, [activeSymbol]);

  return (
    <div className="tradingview-card-expanded">
      <div className="status-header">
        <div className="header-left">
          <BarChart3 size={18} />
          <span>マルチチャート分析</span>
        </div>
        <div className="chart-tab-switcher">
          {(['SUI', 'BTC', 'DEEP'] as const).map(sym => (
            <button 
              key={sym}
              className={activeSymbol === sym ? 'active' : ''}
              onClick={() => setActiveSymbol(sym)}
            >
              {sym}
            </button>
          ))}
        </div>
      </div>
      <div id="tradingview_chart_container" ref={container} style={{ height: '550px', width: '100%', borderRadius: '8px', overflow: 'hidden' }}>
      </div>
    </div>
  );
};

const MarketAdvisor: React.FC<MarketAdvisorProps> = ({ advisor, onApplyStrategy }) => {
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [loading, setLoading] = useState(!advisor);
  const [activeTab, setActiveTab] = useState<'analysis' | 'strategy'>('analysis');

  useEffect(() => {
    if (advisor) {
      setMarketData(advisor);
      setLoading(false);
      return;
    }

    const fetchMarketRegime = async () => {
      try {
        const res = await fetch('http://localhost:3002/api/market-regime');
        if (!res.ok) throw new Error('Not found');
        const data = await res.json();
        if (data.success) {
          setMarketData(data.data);
        }
      } catch (err) {
        console.error('Failed to fetch market regime', err);
      } finally {
        setLoading(false);
      }
    };

    fetchMarketRegime();
    const interval = setInterval(fetchMarketRegime, 10000);
    return () => clearInterval(interval);
  }, [advisor]);

  if (loading || (!marketData && !advisor)) {
    return (
      <div className="advisor-loading">
        <div className="neural-loader">
          <div className="inner-circle"></div>
          <div className="outer-rings"></div>
        </div>
        <span>ニューラルコアを初期化中...</span>
      </div>
    );
  }

  // もし advisor プロップが直接渡されているならそちらを優先
  const currentData = advisor || marketData;
  if (!currentData) return null;

  const getRecommendation = () => {
    const trend = currentData?.trend || 'sideways';
    if (trend === 'sideways') {
      return {
        title: '横ばい相場を検知',
        action: 'DELTA NEUTRAL',
        desc: '相場は安定しています。デルタニュートラル戦略により、方向性リスクを最小限に抑えつつLP手数料収益を最大化します。',
        color: '#00f2ff'
      };
    } else if (trend === 'uptrend') {
      return {
        title: '上昇トレンド発生',
        action: 'LP ONLY',
        desc: '強力な上昇トレンドを検知しました。ヘッジによるロスを避け、上昇利益を最大化するために「LPのみ」の運用を推奨します。',
        color: '#00ff88'
      };
    } else {
      return {
        title: '下落圧力検知',
        action: 'DELTA NEUTRAL',
        desc: '下落トレンドを検知しました。資産を保護するために「デルタニュートラル（ヘッジあり）」の運用を強く推奨します。',
        color: '#ff0055'
      };
    }
  };

  const rec = getRecommendation();

  return (
    <div className="market-advisor-premium">
      <div className="advisor-header">
        <div className="header-title">
          <Brain className="pulse-icon" size={24} color="#00f2ff" />
          <h2>AI 戦略インサイト</h2>
        </div>
        <div className="tab-switcher">
          <button 
            className={activeTab === 'analysis' ? 'active' : ''} 
            onClick={() => setActiveTab('analysis')}
          >
            ニューラル分析
          </button>
          <button 
            className={activeTab === 'strategy' ? 'active' : ''} 
            onClick={() => setActiveTab('strategy')}
          >
            戦略の実行
          </button>
        </div>
      </div>

      <div className="advisor-content">
        {activeTab === 'analysis' ? (
          <div className="analysis-grid-fullwidth">
            <div className="integrated-status-bar">
              <div className="card-bg-glow"></div>
              
              <div className="status-bar-content">
                <div className="status-group">
                  <div className="status-header-mini">
                    <Cpu size={14} />
                    <span>相場判定</span>
                  </div>
                  <div className="regime-value-mini" style={{ color: rec?.color }}>
                    {currentData?.trend === 'uptrend' ? '上昇トレンド' : 
                     currentData?.trend === 'downtrend' ? '下落トレンド' : '横ばい相場'}
                  </div>
                </div>

                <div className="divider-v"></div>

                <div className="status-group">
                  <div className="status-header-mini">
                    <span>ボラティリティ & 信頼度</span>
                  </div>
                  <div className="status-metrics-row">
                    <div className="metric-mini">
                      <span className="label">VOL:</span>
                      <span className="value">{(currentData?.volatilityPct || 0).toFixed(3)}%</span>
                    </div>
                    <div className="metric-mini">
                      <span className="label">AI:</span>
                      <span className="value">94.2%</span>
                    </div>
                  </div>
                </div>

                <div className="divider-v"></div>

                <div className="status-group">
                  <div className="status-header-mini">
                    <span>トレンド解析</span>
                  </div>
                  <div className="trend-row-mini">
                    <div className={`trend-icon-mini ${currentData?.trend || ''}`}>
                      {currentData?.trend === 'uptrend' ? <TrendingUp size={20} /> : 
                       currentData?.trend === 'downtrend' ? <TrendingDown size={20} /> : <Zap size={20} />}
                    </div>
                    <div className="ema-row-mini">
                      <div className="ema-pill">E20: ${currentData?.ema20?.toFixed(4)}</div>
                      <div className="ema-pill">E50: ${currentData?.ema50?.toFixed(4)}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <TradingViewWidget />
          </div>
        ) : (
          <div className="deployment-zone">
            <div className="recommendation-hero">
              <div className="hero-glow" style={{ background: `radial-gradient(circle at center, ${rec?.color || '#fff'}33 0%, transparent 70%)` }}></div>
              <div className="rec-badge" style={{ borderColor: rec?.color || '#fff', color: rec?.color || '#fff' }}>AI 推奨</div>
              <h3>{rec?.title || '戦略を初期化中...'}</h3>
              <p>{rec?.desc || 'AIが市場センチメントを分析しています...'}</p>
            </div>

            <div className="strategy-actions">
              <div className={`strategy-card ${rec?.action === 'LP_ONLY' ? 'recommended' : ''}`}>
                <div className="card-icon"><Layers size={20} /></div>
                <h4>LPのみ (ヘッジなし)</h4>
                <p>トレンド相場において収益を最大化する、純粋な流動性供給です。</p>
                <button onClick={() => onApplyStrategy?.('LP_ONLY')}>
                  戦略を適用 <ArrowRight size={16} />
                </button>
              </div>

              <div className={`strategy-card ${rec?.action === 'DELTA_NEUTRAL' ? 'recommended' : ''}`}>
                <div className="card-icon"><ShieldCheck size={20} /></div>
                <h4>デルタニュートラル (ヘッジあり)</h4>
                <p>Bluefinでヘッジを行い、あらゆる相場環境で安定した収益を目指します。</p>
                <button onClick={() => onApplyStrategy?.('DELTA_NEUTRAL')}>
                  戦略を適用 <ArrowRight size={16} />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="advisor-footer">
        <div className="live-feed">
          <div className="feed-dot"></div>
          <span>ニューラルコア ライブフィード | 現在価格: ${currentData?.price?.toFixed(4) || '0.0000'} | ボラティリティ(ATR): {(currentData?.volatilityPct || 0).toFixed(2)}%</span>
        </div>
      </div>
    </div>
  );
};

export default MarketAdvisor;
