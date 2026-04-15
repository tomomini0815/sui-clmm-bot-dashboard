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

  // 動的プール情報
  private isInitialized: boolean = false;
  private decimalsA: number = 6;
  private decimalsB: number = 9;
  private coinTypeA: string = '';
  private coinTypeB: string = '';
  private usdcDecimals: number = 6;
  private usdcIsA: boolean = true;

  constructor(private priceMonitor: PriceMonitor) {
    this.refreshConfig();
  }

  refreshConfig() {
    this.suiClient = new SuiClient({ url: config.rpcUrl });
    this.isInitialized = false;

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

  async addLiquidity(lowerPrice: number, upperPrice: number, amountUsdc: number): Promise<string> {
    if (!this.isInitialized) await this.initializePoolData();
    
    Logger.startSpin(`Adding Liquidity (${lowerPrice.toFixed(4)}-${upperPrice.toFixed(4)} USDC/SUI, ${amountUsdc} USDC)...`);

    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const pool = await sdk.Pool.getPool(poolId);
      if (!pool) throw new Error(`Pool ${poolId} not found`);

      const tickSpacing = parseInt(pool.tickSpacing.toString());
      const currentSqrtPrice = new BN(pool.current_sqrt_price.toString());
      
      // 正確な tick を計算（動的な Decimal を使用）
      // lowerTick / upperTick の計算において、SDK の priceTo... は「1単位のAに対するBの量」を引数に取る。
      // 私たちの "price" は「1 SUI = X USDC」なので、coinA/coinBの順序に応じて調整が必要。
      
      let lowerTick: number;
      let upperTick: number;
      
      if (this.usdcIsA) {
        // A=USDC, B=SUI。price=B/A なので、SDKの引数にそのまま使える。
        // ただし、私たちのUIのpriceは通常「1 SUI = X USDC」(A/B) なので、逆数にする必要がある。
        const invLower = 1 / upperPrice;
        const invUpper = 1 / lowerPrice;
        lowerTick = TickMath.priceToInitializableTickIndex(new Decimal(invLower.toString()), this.decimalsA, this.decimalsB, tickSpacing);
        upperTick = TickMath.priceToInitializableTickIndex(new Decimal(invUpper.toString()), this.decimalsA, this.decimalsB, tickSpacing);
      } else {
        // B=USDC, A=SUI。price=B/A なので、そのまま使える。
        lowerTick = TickMath.priceToInitializableTickIndex(new Decimal(lowerPrice.toString()), this.decimalsA, this.decimalsB, tickSpacing);
        upperTick = TickMath.priceToInitializableTickIndex(new Decimal(upperPrice.toString()), this.decimalsA, this.decimalsB, tickSpacing);
      }

      Logger.info(`[Blockchain] Range: [${lowerTick}, ${upperTick}], USDC_Is_A=${this.usdcIsA}, Decimals=[${this.decimalsA}, ${this.decimalsB}]`);

      // USDCの資金額をBNに変換（動的な Decimal を使用）
      const usdcAmountBN = new BN(Math.floor(amountUsdc * Math.pow(10, this.usdcDecimals)).toString());
      
      const estResult = ClmmPoolUtil.estLiquidityAndcoinAmountFromOneAmounts(
        lowerTick,
        upperTick,
        usdcAmountBN,
        this.usdcIsA,   // isA
        true,           // roundUp
        0.05,           // slippage
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
      Logger.stopSpin(`Liquidity added! TX: ${response.digest}`);
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
    } catch (error: any) {
      Logger.stopSpin(`Failed to remove liquidity: ${error.message}`);
      throw error;
    }
  }

  async collectFees(): Promise<{ amount: number, digest: string }> {
    if (!this.isInitialized) await this.initializePoolData();
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

      Logger.stopSpin(`Fees collected! TX: ${response.digest}, Amount: ${feeAmount.toFixed(4)} USDC`);
      return { amount: feeAmount, digest: response.digest };
    } catch (error: any) {
      Logger.stopSpin(`Fee collection failed: ${error.message}`);
      return { amount: 0, digest: '' };
    }
  }
}
