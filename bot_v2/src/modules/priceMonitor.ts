import { initCetusSDK, TickMath } from '@cetusprotocol/cetus-sui-clmm-sdk';
import BN from 'bn.js';
import { config as globalConfig, BotConfig } from '../config.js';
import { Logger } from './logger.js';

// Pyth Oracle 価格フィード
const PYTH_SUI_USD_FEED_ID = '23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744';
const PYTH_HERMES_URL = 'https://hermes.pyth.network';

async function retryOn429<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const errorStr = String(error.message || error);
    if (retries > 0 && (errorStr.includes('429') || errorStr.includes('Too Many Requests'))) {
      Logger.warn(`RPC 429 Rate Limit hit. Retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return retryOn429(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

export class PriceMonitor {
  private sdk!: ReturnType<typeof initCetusSDK>;
  private poolObjectId!: string;
  private priceHistory: { time: string; price: number; timestamp: number }[] = [];

  private decimalsA: number = 6;
  private decimalsB: number = 9;
  private coinTypeA: string = '';
  private coinTypeB: string = '';
  private isInitialized: boolean = false;

  private lastPriceTimestamp: number = 0;

  constructor(private config: BotConfig = globalConfig) {
    this.refreshConfig();
  }

  refreshConfig(newConfig?: BotConfig) {
    if (newConfig) {
      this.config = newConfig;
    }
    const isTestnet = this.config.rpcUrl.includes('testnet');
    const network = isTestnet ? 'testnet' : 'mainnet';

    this.sdk = initCetusSDK({
      network,
      fullNodeUrl: this.config.rpcUrl,
    });

    const MAINNET_USDC_SUI_POOL = '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105';
    const TESTNET_DEMO_POOL     = '0xf4f9663f288049ede73a9f19e3a655c74be8a9a84dd3e2c7f04c190c5c9f1fba';

    this.poolObjectId = this.config.poolObjectId || process.env.POOL_OBJECT_ID || (isTestnet ? TESTNET_DEMO_POOL : MAINNET_USDC_SUI_POOL);
    this.isInitialized = false;

    Logger.info(`PriceMonitor: Network=${network}, Pool=${this.poolObjectId.slice(0, 14)}...`);
  }

  private async initializePoolData() {
    if (this.isInitialized) return;
    
    try {
      const pool = await retryOn429(() => this.sdk.Pool.getPool(this.poolObjectId));
      if (pool) {
        this.coinTypeA = pool.coinTypeA;
        this.coinTypeB = pool.coinTypeB;
        
        const coinAMeta = await retryOn429(() => this.sdk.fullClient.getCoinMetadata({ coinType: this.coinTypeA }));
        const coinBMeta = await retryOn429(() => this.sdk.fullClient.getCoinMetadata({ coinType: this.coinTypeB }));
        
        if (coinAMeta) this.decimalsA = coinAMeta.decimals;
        if (coinBMeta) this.decimalsB = coinBMeta.decimals;
        
        Logger.info(`Pool Initialized: ID=${this.poolObjectId}`);
        Logger.info(` - CoinA: ${this.coinTypeA} (${coinAMeta?.symbol}, decimals=${this.decimalsA})`);
        Logger.info(` - CoinB: ${this.coinTypeB} (${coinBMeta?.symbol}, decimals=${this.decimalsB})`);
        this.isInitialized = true;
      }
    } catch (e) {
      Logger.error('Failed to initialize pool data', e);
    }
  }

  getSdk() {
    return this.sdk;
  }

  getPoolId() {
    return this.poolObjectId;
  }

  async getCoinTypeA() {
    await this.initializePoolData();
    return this.coinTypeA;
  }

  async getCoinTypeB() {
    await this.initializePoolData();
    return this.coinTypeB;
  }

  getPriceHistory() {
    return this.priceHistory;
  }

  getPriceDataAge(): number {
    if (this.lastPriceTimestamp === 0) return 999;
    return (Date.now() - this.lastPriceTimestamp) / 1000;
  }

  private async fetchWithTimeout(url: string, timeout = 10000): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      return response;
    } catch (e) {
      clearTimeout(id);
      throw e;
    }
  }

  async getPythPrice(): Promise<number> {
    try {
      const url = `${PYTH_HERMES_URL}/v2/updates/price/latest?ids[]=${PYTH_SUI_USD_FEED_ID}`;
      const response = await this.fetchWithTimeout(url);
      const data = await response.json();

      if (data.parsed && data.parsed.length > 0) {
        const priceData = data.parsed[0].price;
        const price = priceData.price * Math.pow(10, priceData.expo);
        return price;
      }
      throw new Error('No price data from Pyth');
    } catch (error: any) {
      Logger.error(`Failed to fetch Pyth price: ${error.message}`);
      return 0;
    }
  }

  async getCurrentPrice(): Promise<number> {
    try {
      if (!this.isInitialized) {
        await this.initializePoolData();
      }
      if (!this.isInitialized) {
        throw new Error('PriceMonitor is not initialized');
      }

      const pool = await retryOn429(() => this.sdk.Pool.getPool(this.poolObjectId));
      if (!pool || !pool.current_sqrt_price) {
        throw new Error('Pool data unavailable');
      }

      const sqrtPriceBN = new BN(pool.current_sqrt_price.toString());
      
      const isAUsdc = this.coinTypeA.includes('dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7') || 
                      this.coinTypeA.toLowerCase().includes('usdc') || 
                      this.coinTypeA.toLowerCase().includes('coin_a');
                      
      const isBUsdc = this.coinTypeB.includes('dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7') || 
                      this.coinTypeB.toLowerCase().includes('usdc') || 
                      this.coinTypeB.toLowerCase().includes('coin_a');
      
      let price: number;
      
      const result = TickMath.sqrtPriceX64ToPrice(sqrtPriceBN, this.decimalsA, this.decimalsB).toNumber();
      
      if (isAUsdc) {
        price = 1 / result;
      } else if (isBUsdc) {
        price = result;
      } else {
        const isBSui = this.coinTypeB.toLowerCase().includes('0x2::sui::sui');
        const isASui = this.coinTypeA.toLowerCase().includes('0x2::sui::sui');
        
        if (isBSui) {
          price = result;
        } else if (isASui) {
          price = 1 / result;
        } else {
          price = result;
        }
      }

      const isUsdcPool = this.coinTypeA.toLowerCase().includes('usdc') || 
                        this.coinTypeB.toLowerCase().includes('usdc') ||
                        this.coinTypeA.toLowerCase().includes('coin_a') ||
                        this.coinTypeB.toLowerCase().includes('coin_a');

      if (isUsdcPool) {
        const pythPrice = await this.getPythPrice();
        if (pythPrice > 0) {
          const diff = Math.abs(price - pythPrice) / pythPrice;
          if (diff > 0.05) {
            Logger.warn(`Price Divergence: Pool=$${price.toFixed(4)}, Pyth=$${pythPrice.toFixed(4)}. Using Pyth.`);
            price = pythPrice;
          }
        }
      }

      const coinAMeta = await retryOn429(() => this.sdk.fullClient.getCoinMetadata({ coinType: this.coinTypeA }));
      const coinBMeta = await retryOn429(() => this.sdk.fullClient.getCoinMetadata({ coinType: this.coinTypeB }));
      const coinASymbol = coinAMeta?.symbol || 'A';
      const coinBSymbol = coinBMeta?.symbol || 'B';
      
      Logger.info(`📈 Market Price: ${price.toFixed(4)} ${coinASymbol}/${coinBSymbol} (Tick: ${pool.current_tick_index})`);
      
      const now = new Date();
      const timeStr = now.toLocaleTimeString('ja-JP', { hour12: false });

      if (this.priceHistory.length > 0) {
        const lastPrice = this.priceHistory[this.priceHistory.length - 1].price;
        if (lastPrice > 0 && (price > lastPrice * 2 || price < lastPrice * 0.5)) {
          Logger.warn(`Price spikes/drops skipped: ${price.toFixed(4)} (Last: ${lastPrice.toFixed(4)})`);
          return lastPrice;
        }
      }

      const entry = { time: timeStr, price: Number(price.toFixed(4)), timestamp: Date.now() };
      this.priceHistory.push(entry);
      if (this.priceHistory.length > 240) {
        this.priceHistory.shift();
      }

      this.lastPriceTimestamp = Date.now();
      return price;
    } catch (error) {
      Logger.error('Failed to fetch current price', error);
      const lastEntry = this.priceHistory[this.priceHistory.length - 1];
      return lastEntry ? lastEntry.price : 0;
    }
  }

  fetchTWAP(windowMs: number = 5 * 60 * 1000): number {
    const now = Date.now();
    const cutoff = now - windowMs;
    const relevant = this.priceHistory.filter(p => p.timestamp >= cutoff);
    
    if (relevant.length === 0) {
      const last = this.priceHistory[this.priceHistory.length - 1];
      return last ? last.price : 0;
    }
    
    const sum = relevant.reduce((acc, p) => acc + p.price, 0);
    const twap = sum / relevant.length;
    Logger.info(`📊 TWAP(${windowMs / 60000}min): $${twap.toFixed(4)} (${relevant.length} samples)`);
    return twap;
  }

  calculateATR24h(): number {
    const window24h = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const cutoff = now - window24h;
    const relevant = this.priceHistory.filter(p => p.timestamp >= cutoff);
    
    const lastPrice = this.priceHistory[this.priceHistory.length - 1]?.price || 3.0;

    if (relevant.length < 2) {
      Logger.info(`⚠️ ATR24h: 履歴不足 (${relevant.length}件) → デフォルト5%使用`);
      return lastPrice * 0.05;
    }
    
    let totalRange = 0;
    for (let i = 1; i < relevant.length; i++) {
      totalRange += Math.abs(relevant[i].price - relevant[i - 1].price);
    }
    
    const atr = totalRange / (relevant.length - 1);
    const floor = lastPrice * 0.001;
    const finalAtr = Math.max(atr, floor);
    
    Logger.info(`📏 ATR24h: $${finalAtr.toFixed(4)} (Raw: $${atr.toFixed(4)}, ${relevant.length} samples)`);
    return finalAtr;
  }

  getEMA(period: number): number {
    const prices = this.priceHistory.map(p => p.price);
    if (prices.length < period) {
      const sum = prices.reduce((a, b) => a + b, 0);
      return prices.length > 0 ? sum / prices.length : 0;
    }
    
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    
    return ema;
  }

  evaluateTrend(): { trend: 'uptrend' | 'downtrend' | 'sideways'; ema20: number; ema50: number } {
    const ema20 = this.getEMA(20);
    const ema50 = this.getEMA(50);
    const currentPrice = this.priceHistory[this.priceHistory.length - 1]?.price || 0;
    
    if (ema20 === 0 || ema50 === 0 || this.priceHistory.length < 20) {
      return { trend: 'sideways', ema20, ema50 };
    }
    
    const deviation = Math.abs(ema20 - ema50) / ema50;
    
    let trend: 'uptrend' | 'downtrend' | 'sideways';
    if (deviation < 0.015) {
      trend = 'sideways';
    } else if (ema20 > ema50 && currentPrice > ema20) {
      trend = 'uptrend';
    } else if (ema20 < ema50 && currentPrice < ema20) {
      trend = 'downtrend';
    } else {
      trend = 'sideways';
    }
    
    Logger.info(`📊 Trend: ${trend} (EMA20=$${ema20.toFixed(4)}, EMA50=$${ema50.toFixed(4)})`);
    return { trend, ema20, ema50 };
  }

  restoreHistory(prices: { time: string; price: number; timestamp?: number }[]) {
    if (!prices || prices.length === 0) return;
    
    const now = Date.now();
    const interval = 30000; // 30秒
    this.priceHistory = [...prices].slice(-240).map((p, i, arr) => ({
      time: p.time,
      price: p.price,
      timestamp: p.timestamp || (now - (arr.length - 1 - i) * interval)
    }));
    
    if (this.priceHistory.length > 0) {
      this.lastPriceTimestamp = this.priceHistory[this.priceHistory.length - 1].timestamp;
    }
    
    Logger.info(`📈 PriceMonitor: 価格履歴 ${this.priceHistory.length} 件を復元しました`);
  }

  isOutOfRange(currentPrice: number, lowerBound: number, upperBound: number): boolean {
    return currentPrice < lowerBound || currentPrice > upperBound;
  }

  getMarketRegime() {
    const currentPrice = this.priceHistory[this.priceHistory.length - 1]?.price || 0;
    if (currentPrice === 0) return null;

    const atr = this.calculateATR24h();
    const volatilityPct = (atr / currentPrice) * 100;
    
    let volatility: 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME' = 'NORMAL';
    if (volatilityPct < 0.05) volatility = 'LOW';
    else if (volatilityPct > 0.2) volatility = 'HIGH';
    else if (volatilityPct > 0.5) volatility = 'EXTREME';

    const { trend, ema20, ema50 } = this.evaluateTrend();

    return {
      price: currentPrice,
      volatility,
      volatilityPct: Number(volatilityPct.toFixed(4)),
      trend,
      ema20: Number(ema20.toFixed(4)),
      ema50: Number(ema50.toFixed(4)),
      timestamp: Date.now()
    };
  }
}
