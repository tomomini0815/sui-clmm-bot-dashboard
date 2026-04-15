import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient } from '@mysten/sui/client';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { TickMath, ClmmPoolUtil } from '@cetusprotocol/cetus-sui-clmm-sdk';
import Decimal from 'decimal.js';
import BN from 'bn.js';
import { config } from './config.js';
import { Logger } from './logger.js';
import { PriceMonitor } from './priceMonitor.js';

export class LpManager {
  private keypair: Ed25519Keypair;
  private suiClient: SuiClient;
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

  async addLiquidity(lowerPrice: number, upperPrice: number, amountUsdc: number): Promise<void> {
    Logger.startSpin(`Adding Liquidity (${lowerPrice.toFixed(4)}-${upperPrice.toFixed(4)} USDC, ${amountUsdc} USDC)...`);

    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();

      const pool = await sdk.Pool.getPool(poolId);
      if (!pool) throw new Error(`Pool ${poolId} not found`);

      const tickSpacing = parseInt(pool.tickSpacing.toString());

      // 正確な tick を TickMath で計算（USDC=6dec, SUI=9dec）
      const lowerTick = TickMath.priceToInitializableTickIndex(
        new Decimal(lowerPrice.toString()), 6, 9, tickSpacing
      );
      const upperTick = TickMath.priceToInitializableTickIndex(
        new Decimal(upperPrice.toString()), 6, 9, tickSpacing
      );

      Logger.info(`[Blockchain] Tick=[${lowerTick}, ${upperTick}], coinA=${pool.coinTypeA.slice(0, 20)}...`);

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
        is_open:            true,
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
        max_amount_a:        '0',
        max_amount_b:        '0',
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

  async collectFees(): Promise<number> {
    Logger.startSpin('Collecting fees on chain...');

    try {
      const posId = await this.getActivePositionId();
      if (!posId) {
        Logger.stopSpin('No active position to collect fees from.');
        return 0;
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

      Logger.stopSpin(`Fees collected! TX: ${response.digest}`);
      Logger.info(`🔗 View on Explorer: https://suivision.xyz/txblock/${response.digest}`);
      return { amount: 0, digest: response.digest }; // 本来は実際の額を入れるべきですが簡易化
    } catch (error: any) {
      Logger.stopSpin(`Fee collection failed: ${error.message}`);
      return { amount: 0, digest: '' };
    }
  }
}
