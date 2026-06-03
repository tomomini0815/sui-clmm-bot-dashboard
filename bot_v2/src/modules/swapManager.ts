import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient } from '@mysten/sui/client';
import { Percentage, adjustForSlippage, d } from '@cetusprotocol/cetus-sui-clmm-sdk';
import BN from 'bn.js';
import { config as globalConfig, BotConfig } from '../config.js';
import { Logger } from './logger.js';
import { PriceMonitor } from './priceMonitor.js';
import { GasTracker } from '../gasTracker.js';
import { WalletTxQueue, globalTxQueue } from '../walletTxQueue.js';

const USDC_WUSDC_POOL_ID = '0x1efc96c99c9d91ac0f54f0ca78d2d9a6ba11377d29354c0a192c86f0495ddec7';

export class SwapManager {
  private keypair!: Ed25519Keypair;
  private suiClient!: SuiClient;
  private walletAddress: string = '';

  private isInitialized: boolean = false;
  private decimalsA: number = 6;
  private decimalsB: number = 9;
  private coinTypeA: string = '';
  private coinTypeB: string = '';
  private usdcDecimals: number = 6;
  private usdcIsA: boolean = true;

  private txQueue: WalletTxQueue = globalTxQueue;

  constructor(
    private priceMonitor: PriceMonitor,
    private gasTracker: GasTracker,
    private config: BotConfig = globalConfig,
    txQueue?: WalletTxQueue
  ) {
    this.suiClient = new SuiClient({ url: this.config.rpcUrl });
    if (txQueue) this.txQueue = txQueue;
  }

  setKeypair(keypair: Ed25519Keypair) {
    this.keypair = keypair;
    this.walletAddress = this.keypair.getPublicKey().toSuiAddress();
    this.isInitialized = false;
  }

  refreshConfig(newConfig?: BotConfig) {
    if (newConfig) {
      this.config = newConfig;
    }
    this.suiClient = new SuiClient({ url: this.config.rpcUrl });
    this.isInitialized = false;
  }

  private async initializePoolData() {
    if (this.isInitialized) return;
    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const pool = await sdk.Pool.getPool(poolId);
      
      if (pool) {
        this.coinTypeA = pool.coinTypeA;
        this.coinTypeB = pool.coinTypeB;
        
        const coinAMeta = await this.suiClient.getCoinMetadata({ coinType: this.coinTypeA });
        const coinBMeta = await this.suiClient.getCoinMetadata({ coinType: this.coinTypeB });
        
        this.decimalsA = coinAMeta?.decimals ?? 9;
        this.decimalsB = coinBMeta?.decimals ?? 9;
        
        const isAUsdc = this.coinTypeA.toLowerCase().includes('usdc') || this.coinTypeA.toLowerCase().includes('coin_a');
        const isBUsdc = this.coinTypeB.toLowerCase().includes('usdc') || this.coinTypeB.toLowerCase().includes('coin_a');
        
        if (isAUsdc) {
          this.usdcIsA = true;
          this.usdcDecimals = this.decimalsA;
        } else if (isBUsdc) {
          this.usdcIsA = false;
          this.usdcDecimals = this.decimalsB;
        } else {
          this.usdcIsA = true;
          this.usdcDecimals = this.decimalsA;
        }
        this.isInitialized = true;
      }
    } catch (e) {
      Logger.error('SwapManager: Failed to initialize pool data', e);
    }
  }

  private getSdkWithSender() {
    const sdk = this.priceMonitor.getSdk();
    sdk.senderAddress = this.walletAddress;
    return sdk;
  }

  async swapUsdcToSui(amountUsdc: number): Promise<{ digest: string; amountOut: number; gasCostUsdc: number }> {
    if (!this.isInitialized) await this.initializePoolData();
    Logger.startSpin(`Swapping ${amountUsdc.toFixed(4)} USDC to SUI...`);
    
    const usdcAmountBN = new BN(Math.floor(amountUsdc * Math.pow(10, this.usdcDecimals)).toString());
    const res = await this.executeSwap(this.usdcIsA, usdcAmountBN);
    
    const currentPrice = await this.priceMonitor.getCurrentPrice();
    const gasCostUsdc = this.gasTracker.recordGas(null, currentPrice, 'swap'); 
    
    Logger.stopSpin(`USDC -> SUI Swap complete! Digest: ${res.digest}`);
    return { ...res, gasCostUsdc };
  }

  async swapSuiToUsdc(amountSui: number): Promise<{ digest: string; amountOut: number; gasCostUsdc: number }> {
    if (!this.isInitialized) await this.initializePoolData();
    Logger.startSpin(`Swapping ${amountSui.toFixed(4)} SUI to USDC...`);
    
    const suiAmountBN = new BN(Math.floor(amountSui * 1e9).toString());
    const res = await this.executeSwap(!this.usdcIsA, suiAmountBN);
    
    const currentPrice = await this.priceMonitor.getCurrentPrice();
    const gasCostUsdc = this.gasTracker.recordGas(null, currentPrice, 'swap');

    Logger.stopSpin(`SUI -> USDC Swap complete! Digest: ${res.digest}`);
    return { ...res, gasCostUsdc };
  }

  async swapSuiToDeep(amountSui: number): Promise<{ digest: string; amountOut: number; gasCostUsdc: number }> {
    if (!this.isInitialized) await this.initializePoolData();
    Logger.startSpin(`Swapping ${amountSui.toFixed(4)} SUI to DEEP...`);
    
    const suiAmountBN = new BN(Math.floor(amountSui * 1e9).toString());
    const res = await this.executeSwap(false, suiAmountBN); // a2b = false (B to A)
    
    const currentPrice = await this.priceMonitor.getCurrentPrice();
    const gasCostUsdc = this.gasTracker.recordGas(null, currentPrice, 'swap');
    
    Logger.stopSpin(`SUI -> DEEP Swap complete! Digest: ${res.digest}`);
    return { ...res, gasCostUsdc };
  }

  async swapDeepToSui(amountDeep: number): Promise<{ digest: string; amountOut: number; gasCostUsdc: number }> {
    if (!this.isInitialized) await this.initializePoolData();
    Logger.startSpin(`Swapping ${amountDeep.toFixed(4)} DEEP to SUI...`);
    
    const deepAmountBN = new BN(Math.floor(amountDeep * 1e6).toString());
    const res = await this.executeSwap(true, deepAmountBN); // a2b = true (A to B)
    
    const currentPrice = await this.priceMonitor.getCurrentPrice();
    const gasCostUsdc = this.gasTracker.recordGas(null, currentPrice, 'swap');
    
    Logger.stopSpin(`DEEP -> SUI Swap complete! Digest: ${res.digest}`);
    return { ...res, gasCostUsdc };
  }

  private async executeSwap(a2b: boolean, amountInBN: BN): Promise<{ digest: string; amountOut: number }> {
    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const pool = await sdk.Pool.getPool(poolId);
      if (!pool) throw new Error("Pool not found");

      const res = await sdk.Swap.preswap({
        pool: pool,
        currentSqrtPrice: pool.current_sqrt_price,
        coinTypeA: pool.coinTypeA,
        coinTypeB: pool.coinTypeB,
        decimalsA: this.decimalsA,
        decimalsB: this.decimalsB,
        a2b,
        byAmountIn: true,
        amount: amountInBN.toString(),
      });

      if (!res) throw new Error("Swap estimation result is null");

      const slippage = Percentage.fromDecimal(d(this.config.maxSlippage * 100));
      const amountLimit = adjustForSlippage(
        new BN(res.estimatedAmountOut),
        slippage,
        false
      );

      const txPayload = await sdk.Swap.createSwapTransactionPayload({
        pool_id: poolId,
        coinTypeA: pool.coinTypeA,
        coinTypeB: pool.coinTypeB,
        a2b,
        by_amount_in: true,
        amount: amountInBN.toString(),
        amount_limit: amountLimit.toString(),
      });

      const response = await this.txQueue.execute(
        () => this.suiClient.signAndExecuteTransaction({
          transaction: txPayload as any,
          signer: this.keypair,
          options: { showEffects: true, showEvents: true },
        }),
        'swap'
      );

      if (response.effects?.status?.status !== 'success') {
        throw new Error(`Swap TX failed: ${response.effects?.status?.error}`);
      }

      const currentPrice = await this.priceMonitor.getCurrentPrice();
      this.gasTracker.recordGas(response.effects, currentPrice, 'swap');

      const amountOut = Number(res.estimatedAmountOut) / Math.pow(10, a2b ? this.decimalsB : this.decimalsA);
      return { digest: response.digest, amountOut };
    } catch (e: any) {
      Logger.error(`Execution failed: ${e.message}`);
      throw e;
    }
  }

  async swapNativeUsdcToWUsdc(amountUsdc: number): Promise<{ digest: string; amountOut: number }> {
    Logger.info(`SwapManager: Swapping ${amountUsdc.toFixed(2)} Native USDC to wUSDC...`);
    const amountInBN = new BN(Math.floor(amountUsdc * 1e6).toString());
    
    try {
      const sdk = this.getSdkWithSender();
      const pool = await sdk.Pool.getPool(USDC_WUSDC_POOL_ID);
      if (!pool) throw new Error("USDC/wUSDC Pool not found on Cetus.");

      const a2b = pool.coinTypeA.includes('dba3'); 

      const res = await sdk.Swap.preswap({
        pool: pool,
        currentSqrtPrice: pool.current_sqrt_price,
        coinTypeA: pool.coinTypeA,
        coinTypeB: pool.coinTypeB,
        decimalsA: 6,
        decimalsB: 6,
        a2b,
        byAmountIn: true,
        amount: amountInBN.toString(),
      });

      if (!res) throw new Error("Swap estimation failed");
      const slippage = Percentage.fromDecimal(d(0.01 * 100)); // 1.0% slippage
      const amountLimit = adjustForSlippage(new BN(res.estimatedAmountOut), slippage, false);

      const txPayload = await sdk.Swap.createSwapTransactionPayload({
        pool_id: USDC_WUSDC_POOL_ID,
        coinTypeA: pool.coinTypeA,
        coinTypeB: pool.coinTypeB,
        a2b,
        by_amount_in: true,
        amount: amountInBN.toString(),
        amount_limit: amountLimit.toString(),
      });

      const response = await this.txQueue.execute(
        () => this.suiClient.signAndExecuteTransaction({
          transaction: txPayload as any,
          signer: this.keypair,
          options: { showEffects: true, showEvents: true },
        }),
        'swapUsdcToWUsdc'
      );

      if (response.effects?.status?.status !== 'success') {
        throw new Error(`Swap TX failed: ${response.effects?.status?.error}`);
      }

      const amountOut = Number(res.estimatedAmountOut) / 1e6;
      Logger.success(`SwapManager: Swapped Native USDC to ${amountOut.toFixed(4)} wUSDC!`);
      return { digest: response.digest, amountOut };
    } catch (e: any) {
      Logger.error(`SwapManager: USDC -> wUSDC Swap failed: ${e.message}`);
      throw e;
    }
  }
}
