import { initCetusSDK, TickMath } from '@cetusprotocol/cetus-sui-clmm-sdk';
import BN from 'bn.js';
import { config } from './config.js';
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

  constructor() {
    this.refreshConfig();
  }

  refreshConfig() {
    const isTestnet = config.rpcUrl.includes('testnet');
    const network = isTestnet ? 'testnet' : 'mainnet';

    this.sdk = initCetusSDK({
      network,
      fullNodeUrl: config.rpcUrl,
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
        
        Logger.info(`Pool Initialized: CoinA=${coinAMeta?.symbol}(${this.decimalsA}), CoinB=${coinBMeta?.symbol}(${this.decimalsB})`);
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

  async getPythPrice(): Promise<number> {
    try {
      const url = `${PYTH_HERMES_URL}/v2/updates/price/latest?ids[]=${PYTH_SUI_USD_FEED_ID}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.parsed && data.parsed.length > 0) {
        const priceData = data.parsed[0].price;
        const price = priceData.price * Math.pow(10, priceData.expo);
        Logger.info(`Pyth Oracle: SUI = $${price.toFixed(4)} USD`);
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
      
      // SUIの価格（USDC建て）を計算する
      // Cetus SDK の sqrtPriceX64ToPrice(sqrt, decA, decB) は「1単位のAに対するBの量」を返す。
      // SUI(B)のUSDC(A)価格を知りたい場合：
      // 1. SDKの計算結果(B in A)をそのまま使う場合 -> B=SUI, A=USDC なら SUI価格。
      // 2. 逆にする必要がある場合もある。
      
      // USDCがどちらのコインか判定
      const isAUsdc = this.coinTypeA.toLowerCase().includes('usdc');
      const isBUsdc = this.coinTypeB.toLowerCase().includes('usdc');
      
      let price: number;
      
      if (isAUsdc) {
        // AがUSDCの場合、1 unit A (USDC) あたりの B (SUI) の量
        // 例: 0.93 SUI / 1 USDC
        // SUI価格(USDC建て) = 1 / 0.93 = 1.07 USDC/SUI
        const bInA = TickMath.sqrtPriceX64ToPrice(sqrtPriceBN, this.decimalsA, this.decimalsB).toNumber();
        price = 1 / bInA;
      } else if (isBUsdc) {
        // BがUSDCの場合、1 unit A (SUI) あたりの B (USDC) の量
        // 例: 1.07 USDC / 1 SUI
        // SUI価格(USDC建て) = 1.07 USDC/SUI
        price = TickMath.sqrtPriceX64ToPrice(sqrtPriceBN, this.decimalsA, this.decimalsB).toNumber();
      } else {
        // どちらもUSDCでない場合はデフォルトの計算（USDC建てと仮定）
        price = TickMath.sqrtPriceX64ToPrice(sqrtPriceBN, this.decimalsA, this.decimalsB).toNumber();
        if (price > 1000) price = 1 / price; // 保険
      }

      Logger.info(`Pool tick=${pool.current_tick_index}, SUI price=$${price.toFixed(4)} USDC (A=${isBUsdc?'SUI':'USDC'})`);

      const now = new Date();
      const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

      // 異常な乖離（10倍以上の急変など）を無視して履歴を保護
      if (this.priceHistory.length > 0) {
        const lastPrice = this.priceHistory[this.priceHistory.length - 1].price;
        if (lastPrice > 0 && (price > lastPrice * 5 || price < lastPrice / 5)) {
          Logger.warn(`異常な価格を検知したためスキップしました: ${price.toFixed(4)} (前回: ${lastPrice.toFixed(4)})`);
          return lastPrice;
        }
      }

      this.priceHistory.push({ time: timeStr, price: Number(price.toFixed(4)) });
      if (this.priceHistory.length > 60) {
        this.priceHistory.shift();
      }

      return price;
    } catch (error) {
      Logger.error('Failed to fetch current price', error);
      const lastEntry = this.priceHistory[this.priceHistory.length - 1];
      return lastEntry ? lastEntry.price : 0;
    }
  }

  isOutOfRange(currentPrice: number, lowerBound: number, upperBound: number): boolean {
    return currentPrice < lowerBound || currentPrice > upperBound;
  }
}
