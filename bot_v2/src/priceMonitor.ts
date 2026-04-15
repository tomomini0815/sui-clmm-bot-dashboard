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

  // コインのDecimal（poolから取得後にセット）
  private decimalsA: number = 6;  // USDC
  private decimalsB: number = 9;  // SUI

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

    // ネットワーク別の正規 Pool ID
    // Mainnet: USDC-SUI プール (TVL $4.5M, fee 0.25%)
    // Testnet: テストトークンプール (TSTA-SUI)
    const MAINNET_USDC_SUI_POOL = '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105';
    const TESTNET_DEMO_POOL     = '0xf4f9663f288049ede73a9f19e3a655c74be8a9a84dd3e2c7f04c190c5c9f1fba';

    this.poolObjectId = process.env.POOL_OBJECT_ID || (isTestnet ? TESTNET_DEMO_POOL : MAINNET_USDC_SUI_POOL);

    Logger.info(`PriceMonitor: Network=${network}, Pool=${this.poolObjectId.slice(0, 14)}...`);
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

  /**
   * Pyth OracleからSUI/USD価格を取得
   */
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
      // 常にプール価格を使用（Pythは使用しない）
      const pool = await this.sdk.Pool.getPool(this.poolObjectId);

      if (!pool || !pool.current_sqrt_price) {
        throw new Error('Pool data unavailable');
      }

      // Cetus SDK 公式メソッドで正確な価格変換
      const sqrtPriceBN = new BN(pool.current_sqrt_price.toString());
      const priceDecimal = TickMath.sqrtPriceX64ToPrice(sqrtPriceBN, this.decimalsA, this.decimalsB);
      let price = priceDecimal.toNumber();

      // 価格が異常に大きい場合は逆に計算
      if (price > 10000) {
        price = 1 / price;
      }

      Logger.info(`Pool tick=${pool.current_tick_index}, SUI price=$${price.toFixed(4)} USDC`);

      const now = new Date();
      const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

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
