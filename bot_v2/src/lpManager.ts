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
  public currentPositionNft: string | null = null;
  private currentAmountA: number = 0;
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
    // 1. キャッシュがあればそれを返す
    if (this.currentPositionNft) return this.currentPositionNft;

    // 2. キャッシュがない場合、ウォレット全体をスキャンしてこのプールのPosition NFTを探す
    const poolId = this.priceMonitor.getPoolId();

    try {
      Logger.info(`LpManager: Deep-scanning wallet for any Cetus position belonging to pool ${poolId}...`);
      const objects = await this.suiClient.getOwnedObjects({
        owner: this.walletAddress,
        options: { showType: true, showContent: true }
      });

      // Broad filter: package IDに依存せず 'position::Position' を含むすべてのタイプをチェック
      // かつ、流動性 (liquidity) が 0 より大きいものだけを有効なポジションとする
      const poolPositionNfts = objects.data.filter(o => {
        const type = o.data?.type || '';
        const fields = (o.data?.content as any)?.fields;
        const liquidity = parseInt(fields?.liquidity || '0');
        return type.includes('position::Position') && fields?.pool === poolId && liquidity > 0;
      });

      if (poolPositionNfts.length > 0) {
        const foundNft = poolPositionNfts[0];
        const liquid = parseInt((foundNft.data!.content as any).fields.liquidity || '0');
        
        if (liquid > 100) { // 極小の塵を除外
          Logger.success(`LpManager: Found active position ${foundNft.data!.objectId} with liquidity ${liquid}`);
          this.currentPositionNft = foundNft.data!.objectId;
          return this.currentPositionNft;
        } else {
          Logger.info(`LpManager: Ignoring empty/dust position ${foundNft.data!.objectId} (liquidity: ${liquid})`);
        }
      }
    } catch (e) {
      Logger.error('LpManager: Failed to perform deep scan of wallet for Cetus positions', e);
    }
    return null;
  }

  async hasExistingPosition(): Promise<boolean> {
    Logger.info('Checking existing LP positions on blockchain...');
    const posId = await this.getActivePositionId();
    return posId !== null;
  }

  /**
   * 現在のLPポジション内に含まれる SUI の数量を取得する
   * (ヘッジ修復ロジックで使用)
   */
  async getSuiAmountInLp(): Promise<number> {
    if (!this.isInitialized) await this.initializePoolData();
    const posId = await this.getActivePositionId();
    if (!posId) return 0;

    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const positionList = await sdk.Position.getPositionList(this.walletAddress, [poolId]);
      const position = positionList.find(p => p.pos_object_id === posId);
      
      if (!position) return 0;

      // 型定義の齟齬を避けるため as any を使用
      const anyPos = position as any;
      const suiAmountRaw = this.usdcIsA ? anyPos.coinAmountB : anyPos.coinAmountA;
      
      // getPositionList から取得できる値はすでに decimal 調整後の文字列または数値である場合が多いが、
      // SDKの仕様に合わせて安全に数値変換
      return Number(suiAmountRaw);
    } catch (e) {
      Logger.error('Failed to get SUI amount in LP', e);
      return 0;
    }
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

      // 最小運用可能額 (0.1 USDC)
      const MIN_OPERATIONAL_USDC = 0.1;
      const sufficient = suiAmount >= 0.01 && usdcAmount >= MIN_OPERATIONAL_USDC;

      Logger.info(`💰 残高: SUI=${suiAmount.toFixed(4)}, USDC=${usdcAmount.toFixed(4)} → ${sufficient ? '✅ 運用可能' : '❌ 資金不足 (0.1 USDC以上必要)'}`);

      return { suiBalance: suiAmount, usdcBalance: usdcAmount, sufficient };
    } catch (e: any) {
      Logger.error('残高チェック失敗', e);
      return { suiBalance: 0, usdcBalance: 0, sufficient: false };
    }
  }

  async addLiquidity(lowerPrice: number, upperPrice: number, amount: number, isUsdc: boolean = true): Promise<{ digest: string; gasCostUsdc: number }> {
    if (!this.isInitialized) await this.initializePoolData();

    // 残高チェックは上位で行うため簡略化
    Logger.startSpin(`Adding Liquidity (${lowerPrice.toFixed(4)}-${upperPrice.toFixed(4)} USDC/SUI, ${amount.toFixed(4)} ${isUsdc ? 'USDC' : 'SUI'})...`);

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
        // Price = SUI / USDC
        // SUI/USDC が上がる = USDC/SUI が下がる
        const invLower = 1 / upperPrice;
        const invUpper = 1 / lowerPrice;
        lowerTick = TickMath.priceToInitializableTickIndex(new Decimal(invLower.toString()), this.decimalsA, this.decimalsB, tickSpacing);
        upperTick = TickMath.priceToInitializableTickIndex(new Decimal(invUpper.toString()), this.decimalsA, this.decimalsB, tickSpacing);
      } else {
        // Price = USDC / SUI
        lowerTick = TickMath.priceToInitializableTickIndex(new Decimal(lowerPrice.toString()), this.decimalsA, this.decimalsB, tickSpacing);
        upperTick = TickMath.priceToInitializableTickIndex(new Decimal(upperPrice.toString()), this.decimalsA, this.decimalsB, tickSpacing);
      }

      // SDKは lowerTick < upperTick を期待する
      if (lowerTick > upperTick) {
        const tmp = lowerTick;
        lowerTick = upperTick;
        upperTick = tmp;
      }
      // 同じティックになった場合は最低1スパン空ける
      if (lowerTick === upperTick) {
        upperTick += tickSpacing;
      }

      Logger.info(`[Blockchain] Range: [${lowerTick}, ${upperTick}], CurrentTick: ${pool.current_tick_index}, isUsdc: ${isUsdc}`);

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

      // --- 残高ガードロジック ---
      const balances = await this.checkBalance();
      const GAS_RESERVE = 0.2; // ガス代温存 (少額対応のため引き下げ)
      const safeSuiBalance = Math.max(0, balances.suiBalance - GAS_RESERVE);
      
      const amountA_Needed = new Decimal(estResult.coinAmountA.toString()).div(Math.pow(10, this.decimalsA));
      const amountB_Needed = new Decimal(estResult.coinAmountB.toString()).div(Math.pow(10, this.decimalsB));
      
      const usdcNeeded = this.usdcIsA ? amountA_Needed : amountB_Needed;
      const suiNeeded = this.usdcIsA ? amountB_Needed : amountA_Needed;
      
      let scale = 1.0;
      // max_amountに1.03倍(+3.0%バッファ)を指定するため、必要な残高も1.03倍で評価
      const suiNeededMax = suiNeeded.toNumber() * 1.03;
      const usdcNeededMax = usdcNeeded.toNumber() * 1.03;

      if (suiNeededMax > safeSuiBalance) {
        scale = Math.min(scale, safeSuiBalance / suiNeededMax);
        Logger.warn(`⚠️ SUI残高不足を検知: LP投入量を ${ (scale * 100).toFixed(1) }% に縮小して調整します。(Slippage考慮済み)`);
      }
      if (usdcNeededMax > balances.usdcBalance) {
        scale = Math.min(scale, balances.usdcBalance / usdcNeededMax);
        Logger.warn(`⚠️ USDC残高不足を検知: LP投入量を ${ (scale * 100).toFixed(1) }% に縮小して調整します。(Slippage考慮済み)`);
      }

      // 最終的な流動性と数量（ガード適用後）
      const finalLiquidity = scale < 1.0 
        ? estResult.liquidityAmount.muln(Math.floor(scale * 1000)).divn(1000)
        : estResult.liquidityAmount;
        
      const finalAmountA = scale < 1.0
        ? estResult.coinAmountA.muln(Math.floor(scale * 1000)).divn(1000)
        : estResult.coinAmountA;
        
      const finalAmountB = scale < 1.0
        ? estResult.coinAmountB.muln(Math.floor(scale * 1000)).divn(1000)
        : estResult.coinAmountB;
        
      const txPayload = await sdk.Position.createAddLiquidityPayload({
        pool_id:            pool.poolAddress,
        coinTypeA:          pool.coinTypeA,
        coinTypeB:          pool.coinTypeB,
        tick_lower:         lowerTick,
        tick_upper:         upperTick,
        delta_liquidity:    finalLiquidity.toString(),
        // 3.0% のバッファを追加して端数不足による MoveAbort を防ぐ (スリッページ対策を強化)
        max_amount_a:       new BN(finalAmountA.muln(1030).divn(1000)).toString(),
        max_amount_b:       new BN(finalAmountB.muln(1030).divn(1000)).toString(),
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

  /**
   * ウォレットが保有する該当プールの全ポジションをブロックチェーンから取得し、すべて強制クローズする
   * (セッション情報が消失した場合でも確実に資産を回収するための「大掃除」ロジック)
   */
  async forceCloseAllPositions(): Promise<void> {
    Logger.info('--- 既存の迷子ポジションをスキャンして全回収します ---');
    if (!this.isInitialized) await this.initializePoolData();
    
    try {
      const sdk = this.getSdkWithSender();
      const poolId = this.priceMonitor.getPoolId();
      const pool = await sdk.Pool.getPool(poolId);
      
      const positionList = await sdk.Position.getPositionList(this.walletAddress, [poolId]);
      
      if (positionList.length === 0) {
        Logger.info('回収すべき既存ポジションは見つかりませんでした。');
        return;
      }

      Logger.warn(`${positionList.length} 個のポジションを検知しました。一括解除を開始します...`);

      for (const pos of positionList) {
        try {
          Logger.info(`- ポジション回収中: ${pos.pos_object_id} (Liquidity: ${pos.liquidity})`);
          
          if (Number(pos.liquidity) === 0) {
            Logger.info(`  ! 流動性が 0 のためスキップします`);
            continue;
          }
        
          const txPayload = await sdk.Position.removeLiquidityTransactionPayload({
            pool_id:             poolId,
            pos_id:              pos.pos_object_id,
            coinTypeA:           pool.coinTypeA,
            coinTypeB:           pool.coinTypeB,
            delta_liquidity:     pos.liquidity.toString(),
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

          if (response.effects?.status?.status === 'success') {
            Logger.success(`  ✓ ポジション ${pos.pos_object_id} を正常に回収しました。`);
          } else {
            Logger.error(`  × ポジション ${pos.pos_object_id} の回収に失敗しました: ${response.effects?.status?.error}`);
          }
        } catch (innerError) {
          Logger.error(`  × ポジション ${pos.pos_object_id} 処理中にエラーが発生しました`, innerError);
        }
      }
      Logger.success('--- ポジション回収プロセス完了 ---');
    } catch (error) {
      Logger.error('ポジション一括回収中に重大なエラーが発生しました', error);
      throw error;
    }
  }

  async removeLiquidity(): Promise<{ digest: string; gasCostUsdc: number }> {
    // 下位互換性のため残すが、実態は forceCloseAllPositions を使用する
    await this.forceCloseAllPositions();
    return { digest: 'forced_check_complete', gasCostUsdc: 0 };
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
    
    // ガス代を計算して追加
    const currentPrice = await this.priceMonitor.getCurrentPrice();
    const gasCostUsdc = this.gasTracker.recordGas(null, currentPrice, 'swap'); 
    
    Logger.stopSpin(`Swap complete! Digest: ${res.digest}`);
    return { ...res, gasCostUsdc };
  }

  /**
   * SUI を USDC に戻す (全決済用)
   */
  async swapSuiToUsdc(amountSui: number): Promise<{ digest: string; amountOut: number }> {
    if (!this.isInitialized) await this.initializePoolData();
    Logger.startSpin(`Swapping ${amountSui.toFixed(4)} SUI to USDC...`);
    
    const suiAmountBN = new BN(Math.floor(amountSui * 1e9).toString());
    const res = await this.executeSwap(!this.usdcIsA, suiAmountBN);
    
    // ガス代を計算して追加
    const currentPrice = await this.priceMonitor.getCurrentPrice();
    const gasCostUsdc = this.gasTracker.recordGas(null, currentPrice, 'swap');

    Logger.stopSpin(`Swap complete! Digest: ${res.digest}`);
    return { ...res, gasCostUsdc };
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
