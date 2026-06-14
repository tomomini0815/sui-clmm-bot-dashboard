import { useEffect, useRef, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import './MarketAdvisor.css';

declare global {
  interface Window {
    TradingView?: {
      widget: new (options: Record<string, unknown>) => unknown;
    };
  }
}

const symbols = {
  SUI: 'BINANCE:SUIUSDC',
  BTC: 'BINANCE:BTCUSDT',
  DEEP: 'BYBIT:DEEPUSDT',
} as const;

type SymbolKey = keyof typeof symbols;

export default function MarketAdvisor() {
  const container = useRef<HTMLDivElement>(null);
  const [activeSymbol, setActiveSymbol] = useState<SymbolKey>('SUI');

  useEffect(() => {
    const scriptId = 'tradingview-tv-js';

    const initWidget = () => {
      if (!window.TradingView || !container.current) return;

      container.current.innerHTML = '';
      const widgetContainer = document.createElement('div');
      widgetContainer.id = `tv_chart_${activeSymbol}`;
      widgetContainer.style.height = '100%';
      widgetContainer.style.width = '100%';
      container.current.appendChild(widgetContainer);

      new window.TradingView.widget({
        autosize: true,
        symbol: symbols[activeSymbol],
        interval: '60',
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
        locale: 'ja',
        toolbar_bg: 'rgba(0, 0, 0, 0)',
        enable_publishing: false,
        hide_side_toolbar: false,
        allow_symbol_change: true,
        details: true,
        hotlist: true,
        calendar: true,
        show_popup_button: true,
        popup_width: '1000',
        popup_height: '650',
        container_id: widgetContainer.id,
        backgroundColor: 'rgba(10, 15, 25, 1)',
        gridColor: 'rgba(255, 255, 255, 0.05)',
        withdateranges: true,
        save_image: true,
      });
    };

    const existingScript = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (existingScript) {
      initWidget();
      return;
    }

    const script = document.createElement('script');
    script.id = scriptId;
    script.src = 'https://s3.tradingview.com/tv.js';
    script.type = 'text/javascript';
    script.onload = initWidget;
    document.head.appendChild(script);
  }, [activeSymbol]);

  return (
    <section className="tradingview-card-expanded" aria-label="TradingViewチャート">
      <div className="status-header">
        <div className="header-left">
          <BarChart3 size={18} />
          <span>TradingView チャート</span>
        </div>
        <div className="chart-tab-switcher" aria-label="チャート銘柄">
          {(Object.keys(symbols) as SymbolKey[]).map(symbol => (
            <button
              key={symbol}
              className={activeSymbol === symbol ? 'active' : ''}
              onClick={() => setActiveSymbol(symbol)}
            >
              {symbol}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={container}
        style={{ height: '550px', width: '100%', borderRadius: '8px', overflow: 'hidden' }}
      />
    </section>
  );
}
