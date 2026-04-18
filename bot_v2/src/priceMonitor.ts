import { initCetusSDK, TickMath } from '@cetusprotocol/cetus-sui-clmm-sdk';
import BN from 'bn.js';
import { config as globalConfig, BotConfig } from './config.js';
import { Logger } from './logger.js';

// Pyth Oracle 価格フィード
const PYTH_SUI_USD_FEED_ID = '23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744';
const PYTH_HERMES_URL = 'https://hermes.pyth.network';

export class PriceMonitor {
  private sdk!: ReturnType<typeof initCetusSDK>;
  private poolObjectId!: string;
  private priceHistory: { time: string, price: number }[] = [];

  // コイン情報（pool取得時に動的にセット）
  private decimalsA: number = 6;
  private decimalsB: number = 9;
  private coinTypeA: string = '';
  private coinTypeB: string = '';
  private isInitialized: boolean = false;

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

    this.poolObjectId = process.env.POOL_OBJECT_ID || (isTestnet ? TESTNET_DEMO_POOL : MAINNET_USDC_SUI_POOL);
    this.isInitialized = false;

    Logger.info(`PriceMonitor: Network=${network}, Pool=${this.poolObjectId.slice(0, 14)}...`);
  }

  private async initializePoolData() {
    if (this.isInitialized) return;
    
    try {
      const pool = await this.sdk.Pool.getPool(this.poolObjectId);
      if (pool) {
        this.coinTypeA = pool.coinTypeA;
        this.coinTypeB = pool.coinTypeB;
        
        // メタデータを取得してDecimalを確定させる
        const coinAMeta = await this.sdk.fullClient.getCoinMetadata({ coinType: this.coinTypeA });
        const coinBMeta = await this.sdk.fullClient.getCoinMetadata({ coinType: this.coinTypeB });
        
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

  getPriceHistory() {
    return this.priceHistory;
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

      const pool = await this.sdk.Pool.getPool(this.poolObjectId);
      if (!pool || !pool.current_sqrt_price) {
        throw new Error('Pool data unavailable');
      }

      const sqrtPriceBN = new BN(pool.current_sqrt_price.toString());
      
      // USDC の判定（Native USDC: 0xdba3... または Testnet の COIN_A）
      const isAUsdc = this.coinTypeA.includes('dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7') || 
                      this.coinTypeA.toLowerCase().includes('usdc') || 
                      this.coinTypeA.toLowerCase().includes('coin_a');
                      
      const isBUsdc = this.coinTypeB.includes('dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7') || 
                      this.coinTypeB.toLowerCase().includes('usdc') || 
                      this.coinTypeB.toLowerCase().includes('coin_a');
      
      let price: number;
      
      // 1 unit of A in terms of B
      const result = TickMath.sqrtPriceX64ToPrice(sqrtPriceBN, this.decimalsA, this.decimalsB).toNumber();
      
      if (isAUsdc) {
        // A=USDC, B=SUI. result = SUI quantity for 1 USDC.
        // Price (USDC/SUI) = 1 / result
        price = 1 / result;
      } else if (isBUsdc) {
        // A=SUI, B=USDC. result = USDC quantity for 1 SUI.
        // Price (USDC/SUI) = result
        price = result;
      } else {
        // Fallback: Assume B is USDC if it has 6 decimals, else A
        if (this.decimalsB === 6) {
          price = result;
        } else {
          price = 1 / result;
        }
      }

      // Pyth Oracle チェック
      const pythPrice = await this.getPythPrice();
      if (pythPrice > 0) {
        // 乖離チェック（5%以上離れていればPythを採用 または 警告）
        const diff = Math.abs(price - pythPrice) / pythPrice;
        if (diff > 0.05) {
          Logger.warn(`Price Divergence: Pool=$${price.toFixed(4)}, Pyth=$${pythPrice.toFixed(4)}. Using Pyth.`);
          price = pythPrice;
        }
      }

      Logger.info(`📈 Market Price: $${price.toFixed(4)} USDC/SUI (Tick: ${pool.current_tick_index})`);
      
      const now = new Date();
      const timeStr = now.toLocaleTimeString('ja-JP', { hour12: false });

      // 異常値フィルタ
      if (this.priceHistory.length > 0) {
        const lastPrice = this.priceHistory[this.priceHistory.length - 1].price;
        if (lastPrice > 0 && (price > lastPrice * 2 || price < lastPrice * 0.5)) {
          Logger.warn(`Price spikes/drops skipped: ${price.toFixed(4)} (Last: ${lastPrice.toFixed(4)})`);
          return lastPrice;
        }
      }

      this.priceHistory.push({ time: timeStr, price: Number(price.toFixed(4)) });
      if (this.priceHistory.length > 120) { // 履歴保持を120件に拡張
        this.priceHistory.shift();
      }

      return price;
    } catch (error) {
      Logger.error('Failed to fetch current price', error);
      const lastEntry = this.priceHistory[this.priceHistory.length - 1];
      return lastEntry ? lastEntry.price : 0;
    }
  }

  /**
   * 履歴データから過去の推移を復元する
   */
  restoreHistory(prices: { time: string, price: number }[]) {
    if (!prices || prices.length === 0) return;
    
    // 重複を避けつつ、最新の120件を保持
    this.priceHistory = [...prices].slice(-120);
    Logger.info(`📈 PriceMonitor: 価格履歴 ${this.priceHistory.length} 件を復元しました`);
  }

  isOutOfRange(currentPrice: number, lowerBound: number, upperBound: number): boolean {
    return currentPrice < lowerBound || currentPrice > upperBound;
  }
}
