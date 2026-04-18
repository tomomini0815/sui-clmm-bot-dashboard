import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient } from '@mysten/sui/client';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { TickMath, ClmmPoolUtil, Percentage, adjustForSlippage, d } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { Decimal } from 'decimal.js';
import BN from 'bn.js';
import { config as globalConfig, BotConfig } from './config.js';
import { Logger } from './logger.js';
import { PriceMonitor } from './priceMonitor.js';
import { GasTracker } from './gasTracker.js';
import { Tracker } from './tracker.js';

export class LpManager {
  private keypair!: Ed25519Keypair;
  private suiClient!: SuiClient;
  private walletAddress: string = '';

  // 動的プール情報
  private isInitialized: boolean = false;
  private decimalsA: number = 6;
  private decimalsB: number = 9;
  private coinTypeA: string = '';
  private coinTypeB: string = '';
  private usdcDecimals: number = 6;
  private usdcIsA: boolean = true;

  constructor(
    private priceMonitor: PriceMonitor,
    private gasTracker: GasTracker,
    private tracker: Tracker,
    private config: BotConfig = globalConfig
  ) {
    this.suiClient = new SuiClient({ url: this.config.rpcUrl });
    // constructorでは初期化せず、明示的にsetKeypairを呼ぶまで待機
  }

  /**
   * セッション専用のキーペアをセットする
   */
  setKeypair(keypair: Ed25519Keypair) {
    this.keypair = keypair;
    this.walletAddress = this.keypair.getPublicKey().toSuiAddress();
    this.isInitialized = false;
    Logger.info(`LpManager: Keypair set. Address: ${this.walletAddress}`);
  }

  refreshConfig(newConfig?: BotConfig) {
    if (newConfig) {
      this.config = newConfig;
    }
    this.suiClient = new SuiClient({ url: this.config.rpcUrl });
    
    // グローバル設定に秘密鍵がある場合のみ読み込む（単体起動用）
    if (this.config.privateKey) {
      try {
        if (this.config.privateKey.startsWith('suiprivkey')) {
          const { secretKey } = decodeSuiPrivateKey(this.config.privateKey);
          this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
        } else if (this.config.privateKey.replace('0x', '').length >= 64) {
          const privateKeyHex = this.config.privateKey.startsWith('0x')
            ? this.config.privateKey.slice(2)
            : this.config.privateKey;
          this.keypair = Ed25519Keypair.fromSecretKey(Buffer.from(privateKeyHex, 'hex'));
        }
        this.walletAddress = this.keypair.getPublicKey().toSuiAddress();
        this.isInitialized = false;
      } catch (e) {
        Logger.warn('Failed to load global private key.');
      }
    }
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
        
        // USDC判定 (MainnetのUSDCまたはTestnetのCOIN_A)
        const isAUsdc = this.coinTypeA.toLowerCase().includes('usdc') || this.coinTypeA.toLowerCase().includes('coin_a');
        const isBUsdc = this.coinTypeB.toLowerCase().includes('usdc') || this.coinTypeB.toLowerCase().includes('coin_a');
        
        if (isAUsdc) {
          this.usdcIsA = true;
          this.usdcDecimals = this.decimalsA;
        } else if (isBUsdc) {
          this.usdcIsA = false;
          this.usdcDecimals = this.decimalsB;
        } else {
          // デフォルトはAをUSDCとみなす
          this.usdcIsA = true;
          this.usdcDecimals = this.decimalsA;
        }
        
        Logger.info(`LpManager Initialized: CoinA=${coinAMeta?.symbol}(${this.decimalsA}), CoinB=${coinBMeta?.symbol}(${this.decimalsB}), USDC_Is_A=${this.usdcIsA}`);
        this.isInitialized = true;
      }
    } catch (e) {
      Logger.error('LpManager: Failed to initialize pool data', e);
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

  /**
   * ウォレット残高チェック
   * Insufficient balance エラーを防止
   */
  async checkBalance(): Promise<{ suiBalance: number; usdcBalance: number; sufficient: boolean }> {
    if (!this.isInitialized) await this.initializePoolData();
    try {
      // SUI残高
      const suiBalance = await this.suiClient.getBalance({
        owner: this.walletAddress,
      });
      const suiAmount = Number(suiBalance.totalBalance) / 1e9;

      // USDC残高
      let usdcAmount = 0;
      if (this.isInitialized) {
        const usdcCoinType = this.usdcIsA ? this.coinTypeA : this.coinTypeB;
        try {
          const usdcBalance = await this.suiClient.getBalance({
            owner: this.walletAddress,
            coinType: usdcCoinType,
          });
          usdcAmount = Number(usdcBalance.totalBalance) / Math.pow(10, this.usdcDecimals);
        } catch {
          Logger.warn('USDC残高の取得に失敗');
        }
      }

      // ガス用SUI (最低0.01 SUI) + LP用USDC がウォレットにあるか
      const sufficient = suiAmount >= 0.01 && usdcAmount >= this.config.lpAmountUsdc * 0.5;

      Logger.info(`💰 残高: SUI=${suiAmount.toFixed(4)}, USDC=${usdcAmount.toFixed(4)} → ${sufficient ? '✅ 十分' : '❌ 不足'}`);

      return { suiBalance: suiAmount, usdcBalance: usdcAmount, sufficient };
    } catch (e: any) {
      Logger.error('残高チェック失敗', e);
      return { suiBalance: 0, usdcBalance: 0, sufficient: false };
    }
  }

  async addLiquidity(lowerPrice: number, upperPrice: number, amountUsdc: number): Promise<{ digest: string; gasCostUsdc: number }> {
    if (!this.isInitialized) await this.initializePoolData();

    // 残高チェック
    if (this.config.balanceCheckEnabled) {
      const balance = await this.checkBalance();
      if (!balance.sufficient) {
        throw new Error(`Insufficient balance: SUI=${balance.suiBalance.toFixed(4)}, USDC=${balance.usdcBalance.toFixed(4)}. 必要: USDC ≥ ${(amountUsdc * 0.5).toFixed(4)} + SUI ≥ 0.01`);
      }
    }
    
    Logger.startSpin(`Adding Liquidity (${lowerPrice.toFixed(4)}-${upperPrice.toFixed(4)} USDC/SUI, ${amountUsdc} USDC)...`);

    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const pool = await sdk.Pool.getPool(poolId);
      if (!pool) throw new Error(`Pool ${poolId} not found`);

      const tickSpacing = parseInt(pool.tickSpacing.toString());
      const currentSqrtPrice = new BN(pool.current_sqrt_price.toString());
      
      let lowerTick: number;
      let upperTick: number;
      
      if (this.usdcIsA) {
        const invLower = 1 / upperPrice;
        const invUpper = 1 / lowerPrice;
        lowerTick = TickMath.priceToInitializableTickIndex(new Decimal(invLower.toString()), this.decimalsA, this.decimalsB, tickSpacing);
        upperTick = TickMath.priceToInitializableTickIndex(new Decimal(invUpper.toString()), this.decimalsA, this.decimalsB, tickSpacing);
      } else {
        lowerTick = TickMath.priceToInitializableTickIndex(new Decimal(lowerPrice.toString()), this.decimalsA, this.decimalsB, tickSpacing);
        upperTick = TickMath.priceToInitializableTickIndex(new Decimal(upperPrice.toString()), this.decimalsA, this.decimalsB, tickSpacing);
      }

      Logger.info(`[Blockchain] Range: [${lowerTick}, ${upperTick}], USDC_Is_A=${this.usdcIsA}, Decimals=[${this.decimalsA}, ${this.decimalsB}]`);

      const usdcAmountBN = new BN(Math.floor(amountUsdc * Math.pow(10, this.usdcDecimals)).toString());
      
      const estResult = ClmmPoolUtil.estLiquidityAndcoinAmountFromOneAmounts(
        lowerTick,
        upperTick,
        usdcAmountBN,
        this.usdcIsA,
        true,
        this.config.maxSlippage,
        currentSqrtPrice
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

      // ガス代を記録
      const currentPrice = await this.priceMonitor.getCurrentPrice();
      const gasCostUsdc = this.gasTracker.recordGas(response.effects, currentPrice, 'addLiquidity');

      Logger.stopSpin(`Liquidity added! TX: ${response.digest}`);
      return { digest: response.digest, gasCostUsdc };
    } catch (error: any) {
      Logger.stopSpin(`Failed to add liquidity: ${error.message}`);
      throw error;
    }
  }

  async removeLiquidity(): Promise<{ digest: string; gasCostUsdc: number }> {
    Logger.startSpin('Removing existing Liquidity...');

    try {
      const posId = await this.getActivePositionId();
      if (!posId) {
        Logger.stopSpin('No active position found to remove.');
        return { digest: '', gasCostUsdc: 0 };
      }

      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();

      const positionList = await sdk.Position.getPositionList(this.walletAddress, [poolId]);
      const targetPos = positionList.find(p => p.pos_object_id === posId);
      if (!targetPos) throw new Error('Position data missing from SDK');

      const pool = await sdk.Pool.getPool(poolId);

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

      // ガス代を記録
      const currentPrice = await this.priceMonitor.getCurrentPrice();
      const gasCostUsdc = this.gasTracker.recordGas(response.effects, currentPrice, 'removeLiquidity');

      Logger.stopSpin(`Liquidity removed! TX: ${response.digest}`);
      return { digest: response.digest, gasCostUsdc };
    } catch (error: any) {
      Logger.stopSpin(`Failed to remove liquidity: ${error.message}`);
      throw error;
    }
  }

  async collectFees(): Promise<{ amount: number, digest: string, gasCostUsdc: number }> {
    if (!this.isInitialized) await this.initializePoolData();
    Logger.startSpin('Collecting fees on chain...');

    try {
      const posId = await this.getActivePositionId();
      if (!posId) {
        Logger.stopSpin('No active position to collect fees from.');
        return { amount: 0, digest: '', gasCostUsdc: 0 };
      }

      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const pool = await sdk.Pool.getPool(poolId);

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

      // ガス代を記録
      const currentPrice = await this.priceMonitor.getCurrentPrice();
      const gasCostUsdc = this.gasTracker.recordGas(response.effects, currentPrice, 'collectFees');

      let feeAmount = 0;
      if (response.events && response.events.length > 0) {
        for (const event of response.events) {
          if (event.type.includes('Liquidity') || event.type.includes('Fee')) {
            const parsed = event.parsedJson as any;
            if (parsed && (parsed.amount_a || parsed.amount_b)) {
              if (this.usdcIsA && parsed.amount_a) {
                feeAmount += Number(parsed.amount_a) / Math.pow(10, this.decimalsA);
              } else if (!this.usdcIsA && parsed.amount_b) {
                feeAmount += Number(parsed.amount_b) / Math.pow(10, this.decimalsB);
              }
            }
          }
        }
      }

      Logger.stopSpin(`Fees collected! TX: ${response.digest}, Amount: ${feeAmount.toFixed(4)} USDC, Gas: $${gasCostUsdc.toFixed(4)}`);
      return { amount: feeAmount, digest: response.digest, gasCostUsdc };
    } catch (error: any) {
      Logger.stopSpin(`Fee collection failed: ${error.message}`);
      return { amount: 0, digest: '', gasCostUsdc: 0 };
    }
  }

  /**
   * USDC を SUI に交換する (LP用)
   */
  async swapUsdcToSui(amountUsdc: number): Promise<{ digest: string; amountOut: number }> {
    if (!this.isInitialized) await this.initializePoolData();
    Logger.startSpin(`Swapping ${amountUsdc} USDC to SUI...`);
    
    const usdcAmountBN = new BN(Math.floor(amountUsdc * Math.pow(10, this.usdcDecimals)).toString());
    const res = await this.executeSwap(this.usdcIsA, usdcAmountBN);
    
    Logger.stopSpin(`Swap complete! Digest: ${res.digest}`);
    return res;
  }

  /**
   * SUI を USDC に戻す (全決済用)
   */
  async swapSuiToUsdc(amountSui: number): Promise<{ digest: string; amountOut: number }> {
    if (!this.isInitialized) await this.initializePoolData();
    Logger.startSpin(`Swapping ${amountSui.toFixed(4)} SUI to USDC...`);
    
    const suiAmountBN = new BN(Math.floor(amountSui * 1e9).toString());
    const res = await this.executeSwap(!this.usdcIsA, suiAmountBN);
    
    Logger.stopSpin(`Swap complete! Digest: ${res.digest}`);
    return res;
  }

  private async executeSwap(a2b: boolean, amountInBN: BN): Promise<{ digest: string; amountOut: number }> {
    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const pool = await sdk.Pool.getPool(poolId);
      if (!pool) throw new Error("Pool not found");

      // プリスワップ (見積もり)
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

      if (!res) {
        throw new Error("Swap estimation result is null");
      }

      // スリッページ計算 (0.5%)
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

      const response = await this.suiClient.signAndExecuteTransaction({
        transaction: txPayload as any,
        signer: this.keypair,
        options: { showEffects: true, showEvents: true },
      });

      if (response.effects?.status?.status !== 'success') {
        throw new Error(`Swap TX failed: ${response.effects?.status?.error}`);
      }

      // ガス代記録
      const currentPrice = await this.priceMonitor.getCurrentPrice();
      this.gasTracker.recordGas(response.effects, currentPrice, 'swap');

      const amountOut = Number(res.estimatedAmountOut) / Math.pow(10, a2b ? this.decimalsB : this.decimalsA);
      return { digest: response.digest, amountOut };
    } catch (e: any) {
      Logger.error(`Execution failed: ${e.message}`);
      throw e;
    }
  }
}
