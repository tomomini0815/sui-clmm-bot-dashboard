import { initCetusSDK, TickMath } from '@cetusprotocol/cetus-sui-clmm-sdk';
import BN from 'bn.js';
import { config } from './config.js';
import { Logger } from './logger.js';

export class PriceMonitor {
  private sdk: ReturnType<typeof initCetusSDK>;
  private poolObjectId: string;
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

  async getCurrentPrice(): Promise<number> {
    try {
      const pool = await this.sdk.Pool.getPool(this.poolObjectId);

      if (!pool || !pool.current_sqrt_price) {
        throw new Error('Pool data unavailable');
      }

      // Cetus SDK 公式メソッドで正確な価格変換
      // sqrtPriceX64ToPrice(sqrtPrice, decimalsA, decimalsB) → coinA per 1 coinB の人間可読価格
      // USDC-SUI プール: decimalsA=6(USDC), decimalsB=9(SUI)
      // → USDC per SUI = SUIの価格
      const sqrtPriceBN = new BN(pool.current_sqrt_price.toString());
      const priceDecimal = TickMath.sqrtPriceX64ToPrice(sqrtPriceBN, this.decimalsA, this.decimalsB);
      const price = priceDecimal.toNumber();

      Logger.info(`Pool tick=${pool.current_tick_index}, SUI price=${price.toFixed(4)} USDC`);

      const now = new Date();
      const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

      this.priceHistory.push({ time: timeStr, price: Number(price.toFixed(4)) });
      if (this.priceHistory.length > 60) {
        this.priceHistory.shift();
      }

      return price;
    } catch (error) {
      Logger.error('Failed to fetch current price from Cetus', error);
      const lastEntry = this.priceHistory[this.priceHistory.length - 1];
      return lastEntry ? lastEntry.price : 0;
    }
  }

  isOutOfRange(currentPrice: number, lowerBound: number, upperBound: number): boolean {
    return currentPrice < lowerBound || currentPrice > upperBound;
  }
}
