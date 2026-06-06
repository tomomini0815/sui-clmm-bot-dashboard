import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient } from '@mysten/sui/client';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { TickMath, ClmmPoolUtil, Percentage, d } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { Decimal } from 'decimal.js';
import BN from 'bn.js';
import { config as globalConfig, BotConfig } from '../config.js';
import { Logger } from './logger.js';
import { PriceMonitor } from './priceMonitor.js';
import { GasTracker } from '../gasTracker.js';
import { WalletTxQueue, globalTxQueue } from '../walletTxQueue.js';

async function retryOn429<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const errorStr = String(error.message || error);
    if (retries > 0 && (errorStr.includes('429') || errorStr.includes('Too Many Requests'))) {
      Logger.warn(`RPC 429 Rate Limit hit. Retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return retryOn429(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

export class LpManager {
  private keypair!: Ed25519Keypair;
  public suiClient!: SuiClient;
  private walletAddress: string = '';

  private isInitialized: boolean = false;
  public currentPositionNft: string | null = null;
  private decimalsA: number = 6;
  private decimalsB: number = 9;
  public coinTypeA: string = '';
  private coinTypeB: string = '';
  private usdcDecimals: number = 6;
  private usdcIsA: boolean = true;

  private txQueue: WalletTxQueue = globalTxQueue;

  constructor(
    private priceMonitor: PriceMonitor,
    private gasTracker: GasTracker,
    public config: BotConfig = globalConfig,
    txQueue?: WalletTxQueue
  ) {
    this.suiClient = new SuiClient({ url: this.config.rpcUrl });
    if (txQueue) this.txQueue = txQueue;
  }

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
      const pool = await retryOn429(() => sdk.Pool.getPool(poolId));
      
      if (pool) {
        this.coinTypeA = pool.coinTypeA;
        this.coinTypeB = pool.coinTypeB;
        
        const coinAMeta = await retryOn429(() => this.suiClient.getCoinMetadata({ coinType: this.coinTypeA }));
        const coinBMeta = await retryOn429(() => this.suiClient.getCoinMetadata({ coinType: this.coinTypeB }));
        
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

  async getActivePositionId(): Promise<string | null> {
    if (this.currentPositionNft) return this.currentPositionNft;
    const poolId = this.priceMonitor.getPoolId();

    try {
      Logger.info(`LpManager: Scanning wallet for Cetus position on pool ${poolId}...`);
      let hasNextPage = true;
      let nextCursor: string | null | undefined = null;
      const allObjects: any[] = [];

      while (hasNextPage) {
        const response: any = await retryOn429(() => this.suiClient.getOwnedObjects({
          owner: this.walletAddress,
          cursor: nextCursor,
          options: { showType: true, showContent: true }
        }));

        if (response?.data) {
          allObjects.push(...response.data);
        }
        hasNextPage = response?.hasNextPage ?? false;
        nextCursor = response?.nextCursor ?? null;
      }

      const poolPositionNfts = allObjects.filter(o => {
        const type = o.data?.type || '';
        const fields = (o.data?.content as any)?.fields;
        const liquidity = parseInt(fields?.liquidity || '0');
        return type.endsWith('::position::Position') && fields?.pool === poolId && liquidity > 0;
      });

      if (poolPositionNfts.length > 0) {
        const foundNft = poolPositionNfts[0];
        const liquid = parseInt((foundNft.data!.content as any).fields.liquidity || '0');
        
        if (liquid > 100) {
          Logger.success(`LpManager: Found active position ${foundNft.data!.objectId} (liquidity: ${liquid})`);
          this.currentPositionNft = foundNft.data!.objectId;
          return this.currentPositionNft;
        }
      }
    } catch (e) {
      Logger.error('LpManager: Failed to scan wallet for Cetus positions', e);
    }
    return null;
  }

  async getActivePositionIds(): Promise<string[]> {
    const poolId = this.priceMonitor.getPoolId();
    const activeIds: string[] = [];

    try {
      Logger.info(`LpManager: Scanning wallet for Cetus active positions on pool ${poolId}...`);
      let hasNextPage = true;
      let nextCursor: string | null | undefined = null;
      const allObjects: any[] = [];

      while (hasNextPage) {
        const response: any = await retryOn429(() => this.suiClient.getOwnedObjects({
          owner: this.walletAddress,
          cursor: nextCursor,
          options: { showType: true, showContent: true }
        }));

        if (response?.data) {
          allObjects.push(...response.data);
        }
        hasNextPage = response?.hasNextPage ?? false;
        nextCursor = response?.nextCursor ?? null;
      }

      const poolPositionNfts = allObjects.filter(o => {
        const type = o.data?.type || '';
        const fields = (o.data?.content as any)?.fields;
        const liquidity = parseInt(fields?.liquidity || '0');
        return type.endsWith('::position::Position') && fields?.pool === poolId && liquidity > 100;
      });

      for (const nft of poolPositionNfts) {
        activeIds.push(nft.data!.objectId);
      }
    } catch (e) {
      Logger.error('LpManager: Failed to scan wallet for multiple Cetus positions', e);
    }
    return activeIds;
  }

  async hasExistingPosition(): Promise<boolean> {
    const posId = await this.getActivePositionId();
    return posId !== null;
  }

  async getSuiAmountInLp(posId?: string): Promise<number> {
    if (!this.isInitialized) await this.initializePoolData();
    if (!this.isInitialized) return 0;
    const targetPosId = posId || await this.getActivePositionId();
    if (!targetPosId) return 0;

    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const positionList = await retryOn429(() => sdk.Position.getPositionList(this.walletAddress, [poolId]));
      const position = positionList.find(p => p.pos_object_id === targetPosId);
      
      if (!position) return 0;

      const isCoinASui = this.coinTypeA.toLowerCase().includes('0x2::sui::sui');
      const isCoinBSui = this.coinTypeB.toLowerCase().includes('0x2::sui::sui');

      let suiAmountRaw = 0;
      if (isCoinASui) {
        suiAmountRaw = Number((position as any).coin_amount_a);
      } else if (isCoinBSui) {
        suiAmountRaw = Number((position as any).coin_amount_b);
      } else {
        suiAmountRaw = this.usdcIsA ? Number((position as any).coin_amount_b) : Number((position as any).coin_amount_a);
      }
      return suiAmountRaw;
    } catch (e) {
      Logger.error('Failed to get SUI amount in LP', e);
      return 0;
    }
  }

  async getAccumulatedFeesUsd(posId: string): Promise<number> {
    if (!this.isInitialized) await this.initializePoolData();
    try {
      const sdk = this.getSdkWithSender();
      const position = await sdk.Position.getSimplePosition(posId);
      if (!position) return 0;
      return 0; 
    } catch (e) {
      return 0;
    }
  }

  async checkBalance(targetAddress?: string): Promise<{ 
    suiBalance: number; 
    usdcBalance: number; 
    sufficient: boolean;
    coinABalance: number;
    coinBBalance: number;
  }> {
    if (!this.isInitialized) await this.initializePoolData();
    if (!this.isInitialized) {
      return { suiBalance: 0, usdcBalance: 0, sufficient: false, coinABalance: 0, coinBBalance: 0 };
    }
    const addr = targetAddress || this.walletAddress;
    try {
      const suiBalance = await retryOn429(() => this.suiClient.getBalance({
        owner: addr,
      }));
      const suiAmount = Number(suiBalance.totalBalance) / 1e9;

      let usdcAmount = 0;
      if (this.isInitialized) {
        // 主要なUSDC CoinTypeをリスト化して合算チェック (wUSDC & Native USDC)
        const usdcTypes = [
          '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d7d2177a381::usdc::USDC', // wUSDC
          '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'  // Native USDC
        ];
        
        const poolUsdcType = this.usdcIsA ? this.coinTypeA : this.coinTypeB;
        if (poolUsdcType && !usdcTypes.includes(poolUsdcType)) {
          usdcTypes.push(poolUsdcType);
        }

        let totalUsdcRaw = 0;
        let fetchedAny = false;
        
        for (const coinType of usdcTypes) {
          try {
            const bal = await retryOn429(() => this.suiClient.getBalance({
              owner: addr,
              coinType: coinType,
            }));
            totalUsdcRaw += Number(bal.totalBalance);
            fetchedAny = true;
          } catch (e: any) {
            // silent
          }
        }
        
        if (fetchedAny) {
          usdcAmount = totalUsdcRaw / Math.pow(10, this.usdcDecimals);
        } else {
          Logger.warn(`Failed to fetch any USDC balance for ${addr}`);
        }
      }

      // プール固有のCoin AおよびCoin Bの残高を取得
      let coinABalance = 0;
      let coinBBalance = 0;

      if (this.coinTypeA) {
        try {
          const balA = await retryOn429(() => this.suiClient.getBalance({
            owner: addr,
            coinType: this.coinTypeA,
          }));
          coinABalance = Number(balA.totalBalance) / Math.pow(10, this.decimalsA);
        } catch (e) {
          Logger.warn(`Failed to fetch CoinA balance for ${addr}`);
        }
      }

      if (this.coinTypeB) {
        try {
          const balB = await retryOn429(() => this.suiClient.getBalance({
            owner: addr,
            coinType: this.coinTypeB,
          }));
          coinBBalance = Number(balB.totalBalance) / Math.pow(10, this.decimalsB);
        } catch (e) {
          Logger.warn(`Failed to fetch CoinB balance for ${addr}`);
        }
      }

      const MIN_OPERATIONAL_USDC = 0.1;
      const sufficient = suiAmount >= 0.01 && usdcAmount >= MIN_OPERATIONAL_USDC;

      Logger.info(`💰 Balance for ${addr}: SUI=${suiAmount.toFixed(4)}, USDC=${usdcAmount.toFixed(4)}, CoinA=${coinABalance.toFixed(4)}, CoinB=${coinBBalance.toFixed(4)}`);
      return { suiBalance: suiAmount, usdcBalance: usdcAmount, sufficient, coinABalance, coinBBalance };
    } catch (e: any) {
      Logger.error(`Balance check failed for ${addr}`, e);
      return { suiBalance: 0, usdcBalance: 0, sufficient: false, coinABalance: 0, coinBBalance: 0 };
    }
  }

  async addLiquidity(lowerPrice: number, upperPrice: number, amount: number, isUsdc: boolean = true): Promise<{ digest: string; gasCostUsdc: number; positionId?: string }> {
    if (!this.isInitialized) await this.initializePoolData();
    if (!this.isInitialized) throw new Error('LpManager is not initialized');

    Logger.startSpin(`Adding Liquidity (${lowerPrice.toFixed(4)}-${upperPrice.toFixed(4)}, ${amount.toFixed(4)} ${isUsdc ? 'USDC' : 'SUI'})...`);

    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const pool = await sdk.Pool.getPool(poolId);
      if (!pool) throw new Error(`Pool ${poolId} not found`);

      const tickSpacing = parseInt(pool.tickSpacing.toString());
      const currentSqrtPrice = new BN(pool.current_sqrt_price.toString());
      
      let lowerTick: number;
      let upperTick: number;
      
      const currentPoolPrice = TickMath.sqrtPriceX64ToPrice(currentSqrtPrice, this.decimalsA, this.decimalsB).toNumber();
      const centerPrice = (lowerPrice + upperPrice) / 2;
      const isInverse = Math.abs(currentPoolPrice - (1 / centerPrice)) < Math.abs(currentPoolPrice - centerPrice);

      if (isInverse) {
        const invLower = 1 / upperPrice;
        const invUpper = 1 / lowerPrice;
        lowerTick = TickMath.priceToInitializableTickIndex(new Decimal(invLower.toString()), this.decimalsA, this.decimalsB, tickSpacing);
        upperTick = TickMath.priceToInitializableTickIndex(new Decimal(invUpper.toString()), this.decimalsA, this.decimalsB, tickSpacing);
      } else {
        lowerTick = TickMath.priceToInitializableTickIndex(new Decimal(lowerPrice.toString()), this.decimalsA, this.decimalsB, tickSpacing);
        upperTick = TickMath.priceToInitializableTickIndex(new Decimal(upperPrice.toString()), this.decimalsA, this.decimalsB, tickSpacing);
      }

      if (lowerTick === upperTick) {
        upperTick += tickSpacing;
      }

      Logger.info(`[Blockchain] Range Ticks: [${lowerTick}, ${upperTick}], Current: ${pool.current_tick_index}`);


      const decimals = isUsdc ? this.usdcDecimals : (this.usdcIsA ? this.decimalsB : this.decimalsA);
      const amountBN = new BN(new Decimal(amount).mul(Math.pow(10, decimals)).toFixed(0));
      const isCoinA = isUsdc ? this.usdcIsA : !this.usdcIsA;

      const estResult = ClmmPoolUtil.estLiquidityAndcoinAmountFromOneAmounts(
        lowerTick,
        upperTick,
        amountBN,
        isCoinA,
        true,
        this.config.maxSlippage,
        currentSqrtPrice
      );

      const balances = await this.checkBalance();
      const GAS_RESERVE = 0.2; 
      const safeSuiBalance = Math.max(0, balances.suiBalance - GAS_RESERVE);
      
      const amountA_Needed = new Decimal(estResult.coinAmountA.toString()).div(Math.pow(10, this.decimalsA));
      const amountB_Needed = new Decimal(estResult.coinAmountB.toString()).div(Math.pow(10, this.decimalsB));
      
      let scale = 1.0;
      const amountA_Max = amountA_Needed.toNumber() * 1.03;
      const amountB_Max = amountB_Needed.toNumber() * 1.03;

      // Coin Aの残高チェック
      const isCoinASui = this.coinTypeA.toLowerCase().includes('0x2::sui::sui');
      if (isCoinASui) {
        if (amountA_Max > safeSuiBalance) {
          scale = Math.min(scale, safeSuiBalance / amountA_Max);
          Logger.warn(`SUI (CoinA) balance warning: Scaling LP to ${(scale * 100).toFixed(1)}%`);
        }
      } else {
        const balA = balances.coinABalance;
        if (amountA_Max > balA) {
          scale = Math.min(scale, balA / amountA_Max);
          Logger.warn(`${this.coinTypeA.split('::').pop()} (CoinA) balance warning: Scaling LP to ${(scale * 100).toFixed(1)}% (Needed: ${amountA_Max.toFixed(4)}, Available: ${balA.toFixed(4)})`);
        }
      }

      // Coin Bの残高チェック
      const isCoinBSui = this.coinTypeB.toLowerCase().includes('0x2::sui::sui');
      if (isCoinBSui) {
        if (amountB_Max > safeSuiBalance) {
          scale = Math.min(scale, safeSuiBalance / amountB_Max);
          Logger.warn(`SUI (CoinB) balance warning: Scaling LP to ${(scale * 100).toFixed(1)}%`);
        }
      } else {
        const balB = balances.coinBBalance;
        if (amountB_Max > balB) {
          scale = Math.min(scale, balB / amountB_Max);
          Logger.warn(`${this.coinTypeB.split('::').pop()} (CoinB) balance warning: Scaling LP to ${(scale * 100).toFixed(1)}% (Needed: ${amountB_Max.toFixed(4)}, Available: ${balB.toFixed(4)})`);
        }
      }

      const finalLiquidity = scale < 1.0 
        ? estResult.liquidityAmount.muln(Math.floor(scale * 1000)).divn(1000)
        : estResult.liquidityAmount;
        
      const finalAmountA = scale < 1.0
        ? estResult.coinAmountA.muln(Math.floor(scale * 1000)).divn(1000)
        : estResult.coinAmountA;
        
      const finalAmountB = scale < 1.0
        ? estResult.coinAmountB.muln(Math.floor(scale * 1000)).divn(1000)
        : estResult.coinAmountB;
        
      if (finalLiquidity.isZero()) {
        throw new Error('Calculated liquidity is zero. Insufficient SUI balance (below gas reserve) or USDC/DEEP balance.');
      }
        
      const txPayload = await sdk.Position.createAddLiquidityPayload({
        pool_id:            pool.poolAddress,
        coinTypeA:          pool.coinTypeA,
        coinTypeB:          pool.coinTypeB,
        tick_lower:         lowerTick,
        tick_upper:         upperTick,
        delta_liquidity:    finalLiquidity.toString(),
        max_amount_a:       new BN(finalAmountA.muln(1030).divn(1000)).toString(),
        max_amount_b:       new BN(finalAmountB.muln(1030).divn(1000)).toString(),
        collect_fee:        false,
        rewarder_coin_types:[],
        pos_id:             '',
      });

      const response = await this.txQueue.execute(
        () => this.suiClient.signAndExecuteTransaction({
          transaction: txPayload as any,
          signer: this.keypair,
          options: { showEffects: true, showEvents: true, showObjectChanges: true },
        }),
        'addLiquidity'
      );

      if (response.effects?.status?.status !== 'success') {
        throw new Error(`TX failed: ${response.effects?.status?.error}`);
      }

      const currentPrice = await this.priceMonitor.getCurrentPrice();
      const gasCostUsdc = this.gasTracker.recordGas(response.effects, currentPrice, 'addLiquidity');

      let positionId: string | undefined;
      if (response.objectChanges) {
        for (const change of response.objectChanges) {
          if (change.type === 'created' && change.objectType.endsWith('::position::Position')) {
            positionId = change.objectId;
            break;
          }
        }
      }

      if (positionId) {
        this.currentPositionNft = positionId;
        Logger.success(`LpManager: Found new position ID from transaction objectChanges: ${positionId}`);
      } else {
        this.currentPositionNft = null; // スキャンのため一旦リセット
        await this.getActivePositionId(); // キャッシュ再構築
      }

      Logger.stopSpin(`Liquidity added! TX: ${response.digest}`);
      return { digest: response.digest, gasCostUsdc, positionId };
    } catch (error: any) {
      Logger.stopSpin(`Failed to add liquidity: ${error.message}`);
      throw error;
    }
  }

  async hasActivePosition(): Promise<boolean> {
    if (!this.isInitialized) await this.initializePoolData();
    if (!this.isInitialized) return false;
    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const positionList = await retryOn429(() => sdk.Position.getPositionList(this.walletAddress, [poolId]));
      return positionList.some(pos => pos.pool === poolId && Number(pos.liquidity) > 0);
    } catch (error) {
      Logger.error('Failed to check active positions', error);
      return false;
    }
  }

  async forceCloseAllPositions(): Promise<void> {
    Logger.info('--- forceCloseAllPositions: Closing all positions on chain ---');
    if (!this.isInitialized) await this.initializePoolData();
    if (!this.isInitialized) throw new Error('LpManager is not initialized');
    
    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const positionList = await retryOn429(() => sdk.Position.getPositionList(this.walletAddress, [poolId]));
      
      if (positionList.length === 0) {
        Logger.info('No active position found.');
        this.currentPositionNft = null;
        return;
      }

      for (const pos of positionList) {
        try {
          if (Number(pos.liquidity) === 0) continue;
          if (pos.pool !== poolId) {
            Logger.info(`Skipping position ${pos.pos_object_id} because it belongs to a different pool (${pos.pool})`);
            continue;
          }
          Logger.info(`Closing position: ${pos.pos_object_id} (Liquidity: ${pos.liquidity})`);
          
          const pool = await sdk.Pool.getPool(pos.pool);
          const txPayload = await sdk.Position.removeLiquidityTransactionPayload({
            pool_id:             pool.poolAddress,
            pos_id:              pos.pos_object_id,
            coinTypeA:           pool.coinTypeA,
            coinTypeB:           pool.coinTypeB,
            delta_liquidity:     pos.liquidity.toString(),
            min_amount_a:        '0',
            min_amount_b:        '0',
            collect_fee:         true,
            rewarder_coin_types: [],
          });

          const response = await this.txQueue.execute(
            () => this.suiClient.signAndExecuteTransaction({
              transaction: txPayload as any,
              signer: this.keypair,
              options: { showEffects: true },
            }),
            'forceClose'
          );

          if (response.effects?.status?.status === 'success') {
            Logger.success(`Successfully closed position ${pos.pos_object_id}`);
          }
        } catch (innerError) {
          Logger.error(`Error processing position ${pos.pos_object_id}`, innerError);
        }
      }
      this.currentPositionNft = null;
    } catch (error) {
      Logger.error('Failed in forceCloseAllPositions', error);
      throw error;
    }
  }

  async closePosition(posId: string): Promise<void> {
    Logger.info(`--- closePosition: Closing position ${posId} on chain ---`);
    if (!this.isInitialized) await this.initializePoolData();
    if (!this.isInitialized) throw new Error('LpManager is not initialized');
    
    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const positionList = await retryOn429(() => sdk.Position.getPositionList(this.walletAddress, [poolId]));
      const pos = positionList.find(p => p.pos_object_id === posId);
      
      if (!pos) {
        Logger.warn(`Position ${posId} not found in wallet active list.`);
        return;
      }

      Logger.info(`Closing position: ${pos.pos_object_id} (Liquidity: ${pos.liquidity})`);

      // 流動性が0のポジションはremove_liquidityを呼ぶとCetusがerror code 3で失敗する
      // スキップして正常終了（stateから削除できるよう成功扱いにする）
      if (pos.liquidity.toString() === '0' || Number(pos.liquidity) === 0) {
        Logger.warn(`Position ${pos.pos_object_id} has zero liquidity. Skipping removeLiquidity (already empty/expired).`);
        return;
      }

      const pool = await sdk.Pool.getPool(poolId);
      const txPayload = await sdk.Position.removeLiquidityTransactionPayload({
        pool_id:             pool.poolAddress,
        pos_id:              pos.pos_object_id,
        coinTypeA:           pool.coinTypeA,
        coinTypeB:           pool.coinTypeB,
        delta_liquidity:     pos.liquidity.toString(),
        min_amount_a:        '0',
        min_amount_b:        '0',
        collect_fee:         true,
        rewarder_coin_types: [],
      });

      const response = await this.txQueue.execute(
        () => this.suiClient.signAndExecuteTransaction({
          transaction: txPayload as any,
          signer: this.keypair,
          options: { showEffects: true },
        }),
        'closePosition'
      );

      if (response.effects?.status?.status === 'success') {
        Logger.success(`Successfully closed position ${pos.pos_object_id}`);
      }
    } catch (error) {
      Logger.error(`Failed to close position ${posId}`, error);
      throw error;
    }
  }

  async collectFees(posId: string): Promise<{ amount: number, digest: string, gasCostUsdc: number }> {
    if (!this.isInitialized) await this.initializePoolData();
    if (!this.isInitialized) return { amount: 0, digest: '', gasCostUsdc: 0 };
    Logger.startSpin('Collecting fees on chain...');

    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const pool = await sdk.Pool.getPool(poolId);

      const txPayload = await sdk.Position.collectFeeTransactionPayload({
        pool_id:    poolId,
        pos_id:     posId,
        coinTypeA:  pool.coinTypeA,
        coinTypeB:  pool.coinTypeB,
      });

      const response = await this.txQueue.execute(
        () => this.suiClient.signAndExecuteTransaction({
          transaction: txPayload as any,
          signer: this.keypair,
          options: { showEffects: true, showEvents: true },
        }),
        'collectFees'
      );

      if (response.effects?.status?.status !== 'success') {
        throw new Error(`TX failed: ${response.effects?.status?.error}`);
      }

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

      Logger.stopSpin(`Fees collected: ${feeAmount.toFixed(4)} USDC`);
      return { amount: feeAmount, digest: response.digest, gasCostUsdc };
    } catch (error: any) {
      Logger.stopSpin(`Fee collection failed: ${error.message}`);
      return { amount: 0, digest: '', gasCostUsdc: 0 };
    }
  }

  async getPositionDetails(posId: string) {
    if (!this.isInitialized) await this.initializePoolData();
    if (!this.isInitialized) return null;
    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const positionList = await retryOn429(() => sdk.Position.getPositionList(this.walletAddress, [poolId]));
      const pos = positionList.find(p => p.pos_object_id === posId);
      
      if (!pos) return null;
      
      // LP価値の見積もり (簡易的にUSD価値を算出)
      const currentPrice = await this.priceMonitor.getCurrentPrice();
      const amountA = Number((pos as any).coin_amount_a);
      const amountB = Number((pos as any).coin_amount_b);
      
      let usdValue = 0;
      if (this.usdcIsA) {
        usdValue = amountA + (amountB * currentPrice);
      } else {
        usdValue = (amountA * currentPrice) + amountB;
      }

      return {
        posId,
        liquidity: pos.liquidity.toString(),
        amountA,
        amountB,
        usdValue
      };
    } catch {
      return null;
    }
  }
}
