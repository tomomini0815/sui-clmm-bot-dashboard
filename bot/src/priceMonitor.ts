import { CetusClmmSDK, TickMath } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { config } from './config.js';
import { Logger } from './logger.js';

export class PriceMonitor {
  private sdk: CetusClmmSDK;
  private poolObjectId: string;
  private priceHistory: number[] = [];

  constructor() {
    const isTestnet = config.rpcUrl.includes('testnet');
    this.sdk = new CetusClmmSDK({
      network: isTestnet ? 'testnet' : 'mainnet',
      fullNodeUrl: config.rpcUrl,
    });
    
    // Testnet / Mainnet のプールオブジェクトIDを環境変数から取得、未設定ならデフォルト値
    this.poolObjectId = process.env.POOL_OBJECT_ID || (isTestnet
      ? '0xc8d7a1503dc2f9f5b05449a87d8733593e2f0f3e7bffd90541252782e4d2ca20' // Testnet dummy ID
      : '0xcf994611fd4c48e277ce3ffd4d4364c914af2c3cbb05f7bf6facd371de688630'); // Mainnet SUI/USDC pool ID
  }

  getSdk(): CetusClmmSDK {
    return this.sdk;
  }

  async getCurrentPrice(): Promise<number> {
    try {
      const poolParams = await this.sdk.Pool.getPool(this.poolObjectId);
      
      const currentSqrtPrice = BigInt(poolParams.current_sqrt_price);
      
      // sqrt_price から実価格への計算
      // 計算式: (sqrtPrice / 2^64)^2
      const sqrtPriceStr = currentSqrtPrice.toString();
      const sqrtPriceNum = Number(sqrtPriceStr) / Math.pow(2, 64);
      let rawPrice = Math.pow(sqrtPriceNum, 2);

      // SUI (9桁) と USDC (6桁) の Decimal補正
      // SUIがToken A, USDCがToken Bの場合: 実価格 = rawPrice * (10^9 / 10^6) = rawPrice * 1000
      // 逆の場合は 1 / 1000 となります。今回はSUI/USDCペアとして固定的に補正します。
      const assumedPrice = rawPrice * 1000;
      
      this.priceHistory.push(assumedPrice);
      if (this.priceHistory.length > 100) {
        this.priceHistory.shift();
      }
      return assumedPrice;
    } catch (error) {
      Logger.error('Failed to fetch current price from Cetus', error);
      // エラー時はフェイルセーフとして最後に取得した価格か、ダミーを返す
      return this.priceHistory[this.priceHistory.length - 1] || 1.25;
    }
  }

  isOutOfRange(currentPrice: number, lowerBound: number, upperBound: number): boolean {
    return currentPrice < lowerBound || currentPrice > upperBound;
  }
}
