import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient } from '@mysten/sui/client';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { TickMath, ClmmPoolUtil } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { Decimal } from 'decimal.js';
import BN from 'bn.js';
import { config } from './config.js';
import { Logger } from './logger.js';
import { PriceMonitor } from './priceMonitor.js';

export class LpManager {
  private keypair!: Ed25519Keypair;
  private suiClient!: SuiClient;
  private walletAddress: string = '';

  constructor(private priceMonitor: PriceMonitor) {
    this.refreshConfig();
  }

  refreshConfig() {
    this.suiClient = new SuiClient({ url: config.rpcUrl });

    try {
      if (config.privateKey && config.privateKey.startsWith('suiprivkey')) {
        const { secretKey } = decodeSuiPrivateKey(config.privateKey);
        this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
      } else if (config.privateKey && config.privateKey.replace('0x', '').length >= 64) {
        const privateKeyHex = config.privateKey.startsWith('0x')
          ? config.privateKey.slice(2)
          : config.privateKey;
        this.keypair = Ed25519Keypair.fromSecretKey(Buffer.from(privateKeyHex, 'hex'));
      } else {
        throw new Error('No valid private key configured');
      }
      this.walletAddress = this.keypair.getPublicKey().toSuiAddress();
      Logger.info(`LpManager: Wallet loaded. Address: ${this.walletAddress}`);
    } catch (e: any) {
      Logger.warn(`Invalid or missing private key (${e.message}). Running in read-only mode.`);
      this.keypair = new Ed25519Keypair();
      this.walletAddress = this.keypair.getPublicKey().toSuiAddress();
    }
  }

  getWalletAddress(): string {
    return this.walletAddress;
  }

  private getSdkWithSender() {
    const sdk = this.priceMonitor.getSdk();
    sdk.senderAddress = this.walletAddress;
    return sdk;
  }

  private async getActivePositionId(): Promise<string | null> {
    const sdk = this.getSdkWithSender();
    const poolId = this.priceMonitor.getPoolId();

    try {
      const positionList = await sdk.Position.getPositionList(this.walletAddress, [poolId]);
      if (positionList && positionList.length > 0) {
        const targetPos = positionList.find(p => p.pool === poolId);
        return targetPos ? targetPos.pos_object_id : null;
      }
    } catch (e) {
      Logger.error('Error fetching position list', e);
    }
    return null;
  }

  async hasExistingPosition(): Promise<boolean> {
    Logger.info('Checking existing LP positions on blockchain...');
    const posId = await this.getActivePositionId();
    return posId !== null;
  }

  async addLiquidity(lowerPrice: number, upperPrice: number, amountUsdc: number): Promise<string> {
    Logger.startSpin(`Adding Liquidity (${lowerPrice.toFixed(4)}-${upperPrice.toFixed(4)} USDC, ${amountUsdc} USDC)...`);

    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();

      const pool = await sdk.Pool.getPool(poolId);
      if (!pool) throw new Error(`Pool ${poolId} not found`);

      const tickSpacing = parseInt(pool.tickSpacing.toString());
      
      // 現在の価格を取得
      const currentSqrtPrice = new BN(pool.current_sqrt_price.toString());
      const currentTick = TickMath.sqrtPriceX64ToTickIndex(currentSqrtPrice);
      
      // 正確な tick を TickMath で計算（USDC=6dec, SUI=9dec）
      // Cetusプールでは価格が逆転している可能性があるため、両方を試す
      const lowerTick = TickMath.priceToInitializableTickIndex(
        new Decimal(lowerPrice.toString()), 6, 9, tickSpacing
      );
      const upperTick = TickMath.priceToInitializableTickIndex(
        new Decimal(upperPrice.toString()), 6, 9, tickSpacing
      );

      Logger.info(`[Blockchain] CurrentTick=${currentTick}, Range=[${lowerTick}, ${upperTick}], coinA=${pool.coinTypeA.slice(0, 20)}...`);
      
      // 現在価格がレンジ内にあるか確認
      if (currentTick < lowerTick || currentTick > upperTick) {
        Logger.warn(`現在価格がレンジ外です: currentTick=${currentTick}, range=[${lowerTick}, ${upperTick}]`);
        Logger.info(`価格を反転して再計算します...`);
        
        // 価格を反転（1/price）
        const invertedLower = 1 / upperPrice;
        const invertedUpper = 1 / lowerPrice;
        
        const lowerTickInverted = TickMath.priceToInitializableTickIndex(
          new Decimal(invertedLower.toString()), 9, 6, tickSpacing
        );
        const upperTickInverted = TickMath.priceToInitializableTickIndex(
          new Decimal(invertedUpper.toString()), 9, 6, tickSpacing
        );
        
        Logger.info(`反転価格: CurrentTick=${currentTick}, Range=[${lowerTickInverted}, ${upperTickInverted}]`);
      }

      // fix_amount_aの代わりに直接流動性（delta_liquidity）を計算して追加する
      // SUIの支払い分割エラーを回避する
      const usdcAmountBN = new BN(Math.floor(amountUsdc * 1e6).toString());
      const curSqrtPriceBN = new BN(pool.current_sqrt_price.toString());
      Logger.info(`[Blockchain] USDC amount: ${amountUsdc} USDC (${usdcAmountBN.toString()} raw)`);

      const estResult = ClmmPoolUtil.estLiquidityAndcoinAmountFromOneAmounts(
        lowerTick,
        upperTick,
        usdcAmountBN,
        true,          // isA (USDC is coinA)
        true,          // roundUp
        0.05,          // slippage
        curSqrtPriceBN
      );

      const txPayload = await sdk.Position.createAddLiquidityPayload({
        pool_id:            pool.poolAddress,
        coinTypeA:          pool.coinTypeA,
        coinTypeB:          pool.coinTypeB,
        tick_lower:         lowerTick,
        tick_upper:         upperTick,
        delta_liquidity:    estResult.liquidityAmount.toString(),
        max_amount_a:       estResult.coinAmountA.toString(),
        max_amount_b:       estResult.coinAmountB.toString(),
        collect_fee:        false,
        rewarder_coin_types:[],
        pos_id:             '',
      });

      const response = await this.suiClient.signAndExecuteTransaction({
        transaction: txPayload as any,
        signer: this.keypair,
        options: { showEffects: true, showEvents: true },
      });

      if (response.effects?.status?.status !== 'success') {
        throw new Error(`TX failed: ${response.effects?.status?.error}`);
      }
      Logger.stopSpin(`Liquidity added! TX: ${response.digest}`);
      Logger.info(`🔗 View on Explorer: https://suivision.xyz/txblock/${response.digest}`);
      return response.digest;
    } catch (error: any) {
      Logger.stopSpin(`Failed to add liquidity: ${error.message}`);
      throw error;
    }
  }

  async removeLiquidity(): Promise<void> {
    Logger.startSpin('Removing existing Liquidity...');

    try {
      const posId = await this.getActivePositionId();
      if (!posId) {
        Logger.stopSpin('No active position found to remove.');
        return;
      }

      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();

      const positionList = await sdk.Position.getPositionList(this.walletAddress, [poolId]);
      const targetPos = positionList.find(p => p.pos_object_id === posId);
      if (!targetPos) throw new Error('Position data missing from SDK');

      const pool = await sdk.Pool.getPool(poolId);

      Logger.info(`[Blockchain] Removing LP position: ${posId}`);

      // removeLiquidityTransactionPayload + 正しいフィールド名
      const txPayload = await sdk.Position.removeLiquidityTransactionPayload({
        pool_id:             poolId,
        pos_id:              posId,
        coinTypeA:           pool.coinTypeA,
        coinTypeB:           pool.coinTypeB,
        delta_liquidity:     targetPos.liquidity.toString(),
        min_amount_a:        '0',
        min_amount_b:        '0',
        collect_fee:         true,
        rewarder_coin_types: [],
      });

      const response = await this.suiClient.signAndExecuteTransaction({
        transaction: txPayload as any,
        signer: this.keypair,
        options: { showEffects: true },
      });

      if (response.effects?.status?.status !== 'success') {
        throw new Error(`TX failed: ${response.effects?.status?.error}`);
      }
      Logger.stopSpin(`Liquidity removed! TX: ${response.digest}`);
      Logger.info(`🔗 View on Explorer: https://suivision.xyz/txblock/${response.digest}`);
    } catch (error: any) {
      Logger.stopSpin(`Failed to remove liquidity: ${error.message}`);
      throw error;
    }
  }

  async collectFees(): Promise<{ amount: number, digest: string }> {
    Logger.startSpin('Collecting fees on chain...');

    try {
      const posId = await this.getActivePositionId();
      if (!posId) {
        Logger.stopSpin('No active position to collect fees from.');
        return { amount: 0, digest: '' };
      }

      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const pool = await sdk.Pool.getPool(poolId);

      Logger.info(`[Blockchain] Collecting fees for position: ${posId}`);

      // collectFeeTransactionPayload + 正しいフィールド名
      const txPayload = await sdk.Position.collectFeeTransactionPayload({
        pool_id:    poolId,
        pos_id:     posId,
        coinTypeA:  pool.coinTypeA,
        coinTypeB:  pool.coinTypeB,
      });

      const response = await this.suiClient.signAndExecuteTransaction({
        transaction: txPayload as any,
        signer: this.keypair,
        options: { showEffects: true, showEvents: true },
      });

      if (response.effects?.status?.status !== 'success') {
        throw new Error(`TX failed: ${response.effects?.status?.error}`);
      }

      // 実際の手数料額を計算（イベントから取得）
      let feeAmount = 0;
      if (response.events && response.events.length > 0) {
        // CetusのFee収集イベントから金額を取得
        for (const event of response.events) {
          if (event.type.includes('Liquidity') || event.type.includes('Fee')) {
            const parsed = event.parsedJson as any;
            if (parsed && (parsed.amount_a || parsed.amount_b)) {
              // USDC (coinA) の手数料を計算（6桁）
              if (parsed.amount_a) {
                feeAmount += Number(parsed.amount_a) / 1e6;
              }
              // SUI (coinB) の手数料を計算（9桁）→ USDC換算は省略
              if (parsed.amount_b) {
                const suiFee = Number(parsed.amount_b) / 1e9;
                // 簡易的にSUI価格を掛けてUSDC換算（正確にはoracle価格を使用）
                feeAmount += suiFee * 3.0; // 仮のSUI価格 $3.00
              }
            }
          }
        }
      }

      Logger.stopSpin(`Fees collected! TX: ${response.digest}, Amount: ${feeAmount.toFixed(4)} USDC`);
      Logger.info(`🔗 View on Explorer: https://suivision.xyz/txblock/${response.digest}`);
      return { amount: feeAmount, digest: response.digest };
    } catch (error: any) {
      Logger.stopSpin(`Fee collection failed: ${error.message}`);
      return { amount: 0, digest: '' };
    }
  }
}
