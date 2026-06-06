diff --git a/bot_v2/src/modules/lpManager.ts b/bot_v2/src/modules/lpManager.ts
index 5a99e27..079e3aa 100644
--- a/bot_v2/src/modules/lpManager.ts
+++ b/bot_v2/src/modules/lpManager.ts
@@ -178,6 +178,46 @@ export class LpManager {
     return null;
   }
 
+  async getActivePositionIds(): Promise<string[]> {
+    const poolId = this.priceMonitor.getPoolId();
+    const activeIds: string[] = [];
+
+    try {
+      Logger.info(`LpManager: Scanning wallet for Cetus active positions on pool ${poolId}...`);
+      let hasNextPage = true;
+      let nextCursor: string | null | undefined = null;
+      const allObjects: any[] = [];
+
+      while (hasNextPage) {
+        const response: any = await retryOn429(() => this.suiClient.getOwnedObjects({
+          owner: this.walletAddress,
+          cursor: nextCursor,
+          options: { showType: true, showContent: true }
+        }));
+
+        if (response?.data) {
+          allObjects.push(...response.data);
+        }
+        hasNextPage = response?.hasNextPage ?? false;
+        nextCursor = response?.nextCursor ?? null;
+      }
+
+      const poolPositionNfts = allObjects.filter(o => {
+        const type = o.data?.type || '';
+        const fields = (o.data?.content as any)?.fields;
+        const liquidity = parseInt(fields?.liquidity || '0');
+        return type.endsWith('::position::Position') && fields?.pool === poolId && liquidity > 100;
+      });
+
+      for (const nft of poolPositionNfts) {
+        activeIds.push(nft.data!.objectId);
+      }
+    } catch (e) {
+      Logger.error('LpManager: Failed to scan wallet for multiple Cetus positions', e);
+    }
+    return activeIds;
+  }
+
   async hasExistingPosition(): Promise<boolean> {
     const posId = await this.getActivePositionId();
     return posId !== null;
@@ -217,10 +257,16 @@ export class LpManager {
     }
   }
 
-  async checkBalance(targetAddress?: string): Promise<{ suiBalance: number; usdcBalance: number; sufficient: boolean }> {
+  async checkBalance(targetAddress?: string): Promise<{ 
+    suiBalance: number; 
+    usdcBalance: number; 
+    sufficient: boolean;
+    coinABalance: number;
+    coinBBalance: number;
+  }> {
     if (!this.isInitialized) await this.initializePoolData();
     if (!this.isInitialized) {
-      return { suiBalance: 0, usdcBalance: 0, sufficient: false };
+      return { suiBalance: 0, usdcBalance: 0, sufficient: false, coinABalance: 0, coinBBalance: 0 };
     }
     const addr = targetAddress || this.walletAddress;
     try {
@@ -265,14 +311,42 @@ export class LpManager {
         }
       }
 
+      // プール固有のCoin AおよびCoin Bの残高を取得
+      let coinABalance = 0;
+      let coinBBalance = 0;
+
+      if (this.coinTypeA) {
+        try {
+          const balA = await retryOn429(() => this.suiClient.getBalance({
+            owner: addr,
+            coinType: this.coinTypeA,
+          }));
+          coinABalance = Number(balA.totalBalance) / Math.pow(10, this.decimalsA);
+        } catch (e) {
+          Logger.warn(`Failed to fetch CoinA balance for ${addr}`);
+        }
+      }
+
+      if (this.coinTypeB) {
+        try {
+          const balB = await retryOn429(() => this.suiClient.getBalance({
+            owner: addr,
+            coinType: this.coinTypeB,
+          }));
+          coinBBalance = Number(balB.totalBalance) / Math.pow(10, this.decimalsB);
+        } catch (e) {
+          Logger.warn(`Failed to fetch CoinB balance for ${addr}`);
+        }
+      }
+
       const MIN_OPERATIONAL_USDC = 0.1;
       const sufficient = suiAmount >= 0.01 && usdcAmount >= MIN_OPERATIONAL_USDC;
 
-      Logger.info(`💰 Balance for ${addr}: SUI=${suiAmount.toFixed(4)}, USDC=${usdcAmount.toFixed(4)}`);
-      return { suiBalance: suiAmount, usdcBalance: usdcAmount, sufficient };
+      Logger.info(`💰 Balance for ${addr}: SUI=${suiAmount.toFixed(4)}, USDC=${usdcAmount.toFixed(4)}, CoinA=${coinABalance.toFixed(4)}, CoinB=${coinBBalance.toFixed(4)}`);
+      return { suiBalance: suiAmount, usdcBalance: usdcAmount, sufficient, coinABalance, coinBBalance };
     } catch (e: any) {
       Logger.error(`Balance check failed for ${addr}`, e);
-      return { suiBalance: 0, usdcBalance: 0, sufficient: false };
+      return { suiBalance: 0, usdcBalance: 0, sufficient: false, coinABalance: 0, coinBBalance: 0 };
     }
   }
 
@@ -348,20 +422,38 @@ export class LpManager {
       const amountA_Needed = new Decimal(estResult.coinAmountA.toString()).div(Math.pow(10, this.decimalsA));
       const amountB_Needed = new Decimal(estResult.coinAmountB.toString()).div(Math.pow(10, this.decimalsB));
       
-      const usdcNeeded = this.usdcIsA ? amountA_Needed : amountB_Needed;
-      const suiNeeded = this.usdcIsA ? amountB_Needed : amountA_Needed;
-      
       let scale = 1.0;
-      const suiNeededMax = suiNeeded.toNumber() * 1.03;
-      const usdcNeededMax = usdcNeeded.toNumber() * 1.03;
-
-      if (suiNeededMax > safeSuiBalance) {
-        scale = Math.min(scale, safeSuiBalance / suiNeededMax);
-        Logger.warn(`SUI balance warning: Scaling LP to ${(scale * 100).toFixed(1)}%`);
+      const amountA_Max = amountA_Needed.toNumber() * 1.03;
+      const amountB_Max = amountB_Needed.toNumber() * 1.03;
+
+      // Coin Aの残高チェック
+      const isCoinASui = this.coinTypeA.toLowerCase().includes('0x2::sui::sui');
+      if (isCoinASui) {
+        if (amountA_Max > safeSuiBalance) {
+          scale = Math.min(scale, safeSuiBalance / amountA_Max);
+          Logger.warn(`SUI (CoinA) balance warning: Scaling LP to ${(scale * 100).toFixed(1)}%`);
+        }
+      } else {
+        const balA = balances.coinABalance;
+        if (amountA_Max > balA) {
+          scale = Math.min(scale, balA / amountA_Max);
+          Logger.warn(`${this.coinTypeA.split('::').pop()} (CoinA) balance warning: Scaling LP to ${(scale * 100).toFixed(1)}% (Needed: ${amountA_Max.toFixed(4)}, Available: ${balA.toFixed(4)})`);
+        }
       }
-      if (usdcNeededMax > balances.usdcBalance) {
-        scale = Math.min(scale, balances.usdcBalance / usdcNeededMax);
-        Logger.warn(`USDC balance warning: Scaling LP to ${(scale * 100).toFixed(1)}%`);
+
+      // Coin Bの残高チェック
+      const isCoinBSui = this.coinTypeB.toLowerCase().includes('0x2::sui::sui');
+      if (isCoinBSui) {
+        if (amountB_Max > safeSuiBalance) {
+          scale = Math.min(scale, safeSuiBalance / amountB_Max);
+          Logger.warn(`SUI (CoinB) balance warning: Scaling LP to ${(scale * 100).toFixed(1)}%`);
+        }
+      } else {
+        const balB = balances.coinBBalance;
+        if (amountB_Max > balB) {
+          scale = Math.min(scale, balB / amountB_Max);
+          Logger.warn(`${this.coinTypeB.split('::').pop()} (CoinB) balance warning: Scaling LP to ${(scale * 100).toFixed(1)}% (Needed: ${amountB_Max.toFixed(4)}, Available: ${balB.toFixed(4)})`);
+        }
       }
 
       const finalLiquidity = scale < 1.0 
@@ -376,6 +468,10 @@ export class LpManager {
         ? estResult.coinAmountB.muln(Math.floor(scale * 1000)).divn(1000)
         : estResult.coinAmountB;
         
+      if (finalLiquidity.isZero()) {
+        throw new Error('Calculated liquidity is zero. Insufficient SUI balance (below gas reserve) or USDC/DEEP balance.');
+      }
+        
       const txPayload = await sdk.Position.createAddLiquidityPayload({
         pool_id:            pool.poolAddress,
         coinTypeA:          pool.coinTypeA,
diff --git a/bot_v2/src/modules/stateManager.ts b/bot_v2/src/modules/stateManager.ts
index 8a0931f..6fcceb8 100644
--- a/bot_v2/src/modules/stateManager.ts
+++ b/bot_v2/src/modules/stateManager.ts
@@ -4,17 +4,24 @@ import { Logger } from './logger.js';
 
 export interface BotState {
   phase: 'A' | 'B' | 'C' | 'D';
-  lpPositionId: string | null;
+  lpPositionId: string | null;          // 互換性のため残す
+  lpPositionIdBelow: string | null;     // 下側ポジションID
+  lpPositionIdAbove: string | null;     // 上側ポジションID
   bluefinOrderId: string | null;
   bluefinSide: 'short' | 'long' | 'none';
   basePrice: number;
-  rangeLower: number;
-  rangeUpper: number;
+  rangeLower: number;                   // 互換性のため残す
+  rangeUpper: number;                   // 互換性のため残す
+  rangeLowerBelow: number;              // 下側レンジ下限
+  rangeUpperBelow: number;              // 下側レンジ上限
+  rangeLowerAbove: number;              // 上側レンジ下限
+  rangeUpperAbove: number;              // 上側レンジ上限
   rangeWidth: number;
   totalCapital: number;
   rebalanceCount24h: number;
   lastRebalanceAt: number;
   rebalanceHistory: number[]; 
+  breachStartAt?: number;
 }
 
 export class StateManager {
diff --git a/bot_v2/src/strategy.ts b/bot_v2/src/strategy.ts
index e3343db..42f28c6 100644
--- a/bot_v2/src/strategy.ts
+++ b/bot_v2/src/strategy.ts
@@ -338,136 +338,277 @@ export class Strategy {
       const GAS_RESERVE = 0.3; // ガス代確保分 (SUI)
       const safeSuiTotal = Math.max(0, balance.suiBalance - GAS_RESERVE);
 
-      // DEEP残高取得（Bot2プールのcoinTypeAがDEEPのはず）
-      let deepBalance = 0;
-      const deepCoinType = this.bot2.lpManager.coinTypeA;
-      if (deepCoinType) {
-        try {
-          const deepBal = await this.bot1.lpManager.suiClient.getBalance({
-            owner: this.bot1.lpManager.getWalletAddress(),
-            coinType: deepCoinType
-          });
-          deepBalance = Number(deepBal.totalBalance) / 1e6; // DEEP decimals = 6
-        } catch (e) {
-          Logger.warn('[PHASE_A] DEEP残高取得失敗。0として処理します。');
+      // DEEP残高取得（Bot2プール�      if (this.config.strategyMode === 'range_order') {
+        Logger.info('[PHASE_A] === 指値レンジ戦略 (Range Order - 上下両側配置) で再配分を実行します ===');
+
+        const offset = this.config.rangeOrderOffsetPct || 0.005;
+        const width = this.config.rangeOrderWidthPct || 0.001;
+
+        // 目標残高の算出（全体の資金を4等分 = 各ボットの 50% ずつ）
+        const bot1UsdcNeeded = bot1AllocUsdc * 0.50;
+        const bot1SuiNeeded  = (bot1AllocUsdc * 0.50) / price1;
+        const bot2SuiNeeded  = (bot2AllocUsdc * 0.50) / price1;
+        const bot2DeepNeeded = (bot2AllocUsdc * 0.50) / (price2 * price1);
+
+        Logger.info(`[PHASE_A] 目標(各25%): Bot1 USDC=$${bot1UsdcNeeded.toFixed(2)} / SUI=${bot1SuiNeeded.toFixed(4)} | Bot2 SUI=${bot2SuiNeeded.toFixed(4)} / DEEP=${bot2DeepNeeded.toFixed(2)}`);
+
+        // 1. DEEP残高の調整
+        if (deepBalance > bot2DeepNeeded + 1.0) {
+          const deepToSell = deepBalance - bot2DeepNeeded;
+          Logger.info(`[PHASE_A] 余剰DEEPを売却します: ${deepToSell.toFixed(2)} DEEP -> SUI`);
+          await this.bot2.swapManager.swapDeepToSui(deepToSell);
+        } else if (deepBalance < bot2DeepNeeded - 1.0) {
+          const deepToBuy = bot2DeepNeeded - deepBalance;
+          const preBal = await this.bot1.lpManager.checkBalance();
+          const suiToSwap = Math.min(deepToBuy * price2, Math.max(0, preBal.suiBalance - 1.0));
+          if (suiToSwap > 0.05) {
+            Logger.info(`[PHASE_A] 不足DEEPを補うため SUIをスワップします: ${suiToSwap.toFixed(4)} SUI -> DEEP`);
+            await this.bot2.swapManager.swapSuiToDeep(suiToSwap);
+          }
         }
-      }
 
-      // ── Step 2: 全資産をUSDC建てで合算 ──
-      const suiValueUsdc  = safeSuiTotal * price1;
-      const deepValueUsdc = deepBalance  * price2 * price1; // DEEP→SUI→USDC換算
-      const totalAssetsUsdc = balance.usdcBalance + suiValueUsdc + deepValueUsdc;
+        // 最新残高を更新
+        let currentBal = await this.bot1.lpManager.checkBalance();
+
+        // 2. USDC残高の調整
+        if (currentBal.usdcBalance > bot1UsdcNeeded + 0.1) {
+          const usdcToSell = currentBal.usdcBalance - bot1UsdcNeeded;
+          if (usdcToSell > 0.1) {
+            Logger.info(`[PHASE_A] 余剰USDCを売却します: ${usdcToSell.toFixed(2)} USDC -> SUI`);
+            await this.bot1.swapManager.swapUsdcToSui(usdcToSell);
+          }
+        } else if (currentBal.usdcBalance < bot1UsdcNeeded - 0.1) {
+          const usdcToBuy = bot1UsdcNeeded - currentBal.usdcBalance;
+          const suiToSell = Math.min(usdcToBuy / price1, Math.max(0, currentBal.suiBalance - 1.0));
+          if (suiToSell > 0.05) {
+            Logger.info(`[PHASE_A] 不足USDCを補うため SUIを売却します: ${suiToSell.toFixed(4)} SUI -> USDC`);
+            await this.bot1.swapManager.swapSuiToUsdc(suiToSell);
+          }
+        }
 
-      Logger.info(`[PHASE_A] 全資産 (ガス代 ${GAS_RESERVE} SUI確保後):`);
-      Logger.info(`  USDC:  $${balance.usdcBalance.toFixed(2)}`);
-      Logger.info(`  SUI:   ${safeSuiTotal.toFixed(4)} SUI (≈ $${suiValueUsdc.toFixed(2)})`);
-      Logger.info(`  DEEP:  ${deepBalance.toFixed(2)} DEEP (≈ $${deepValueUsdc.toFixed(2)})`);
-      Logger.info(`  合計:  ≈ $${totalAssetsUsdc.toFixed(2)} USDC`);
+        // 最新の残高でLPを構築
+        const finalBal = await this.bot1.lpManager.checkBalance();
+        const finalDeepObj = await this.bot1.lpManager.suiClient.getBalance({
+          owner: this.bot1.lpManager.getWalletAddress(),
+          coinType: deepCoinType
+        });
+        const finalDeep = Number(finalDeepObj.totalBalance) / 1e6;
+
+        // 古いポジションを全クローズ
+        this.bot1.currentPhase = CyclePhase.A;
+        await this.bot1.lpManager.forceCloseAllPositions();
+        this.bot1.state.lpPositionId = null;
+        this.bot1.state.lpPositionIdBelow = null;
+        this.bot1.state.lpPositionIdAbove = null;
+
+        this.bot2.currentPhase = CyclePhase.A;
+        await this.bot2.lpManager.forceCloseAllPositions();
+        this.bot2.state.lpPositionId = null;
+        this.bot2.state.lpPositionIdBelow = null;
+        this.bot2.state.lpPositionIdAbove = null;
+
+        // ── Bot1 (SUI/USDC) below LP (USDC 100%) ──
+        const bot1LowerBelow = price1 * (1 - offset - width);
+        const bot1UpperBelow = price1 * (1 - offset);
+        const bot1LpUsdc = Math.min(finalBal.usdcBalance, bot1UsdcNeeded * 1.02);
+
+        Logger.info(`[Bot1] SUI/USDC below指値LP構築 (レンジ: $${bot1LowerBelow.toFixed(4)}-$${bot1UpperBelow.toFixed(4)}, USDC: $${bot1LpUsdc.toFixed(2)})...`);
+        const lpRes1Below = await this.bot1.lpManager.addLiquidity(bot1LowerBelow, bot1UpperBelow, bot1LpUsdc, true);
+        const pos1Below = lpRes1Below.positionId || (await this.bot1.lpManager.getActivePositionIds())[0];
+        if (pos1Below) {
+          this.bot1.state.lpPositionIdBelow = pos1Below;
+          this.bot1.state.rangeLowerBelow  = bot1LowerBelow;
+          this.bot1.state.rangeUpperBelow  = bot1UpperBelow;
+          Logger.success(`[Bot1] ✅ below指値LP構築完了: ${pos1Below}`);
+        }
 
-      if (totalAssetsUsdc < 1.0) {
-        Logger.warn('[PHASE_A] 総資産が $1.00 未満のため待機します。');
-        return;
-      }
+        // 残高を再取得（SUI消費を反映）
+        const finalBal2 = await this.bot1.lpManager.checkBalance();
+
+        // ── Bot1 (SUI/USDC) above LP (SUI 100%) ──
+        const bot1LowerAbove = price1 * (1 + offset);
+        const bot1UpperAbove = price1 * (1 + offset + width);
+        const bot1LpSui = Math.min(finalBal2.suiBalance - 0.5, bot1SuiNeeded * 1.02); // ガス用に最低0.5 SUI
+
+        if (bot1LpSui > 0.05) {
+          Logger.info(`[Bot1] SUI/USDC above指値LP構築 (レンジ: $${bot1LowerAbove.toFixed(4)}-$${bot1UpperAbove.toFixed(4)}, SUI: ${bot1LpSui.toFixed(4)})...`);
+          const lpRes1Above = await this.bot1.lpManager.addLiquidity(bot1LowerAbove, bot1UpperAbove, bot1LpSui, false);
+          const activeIds1 = await this.bot1.lpManager.getActivePositionIds();
+          const pos1Above = lpRes1Above.positionId || activeIds1.find(id => id !== pos1Below);
+          if (pos1Above) {
+            this.bot1.state.lpPositionIdAbove = pos1Above;
+            this.bot1.state.rangeLowerAbove  = bot1LowerAbove;
+            this.bot1.state.rangeUpperAbove  = bot1UpperAbove;
+            Logger.success(`[Bot1] ✅ above指値LP構築完了: ${pos1Above}`);
+          }
+        }
+
+        // 残高を再取得
+        const finalBal3 = await this.bot1.lpManager.checkBalance();
+
+        // ── Bot2 (DEEP/SUI) below LP (SUI 100%) ──
+        const bot2LowerBelow = price2 * (1 - offset - width);
+        const bot2UpperBelow = price2 * (1 - offset);
+        const bot2LpSui = Math.min(finalBal3.suiBalance - 0.3, bot2SuiNeeded * 1.02); // さらにガス用に0.3 SUI
+
+        if (bot2LpSui > 0.05) {
+          Logger.info(`[Bot2] DEEP/SUI below指値LP構築 (レンジ: ${bot2LowerBelow.toFixed(6)}-${bot2UpperBelow.toFixed(6)}, SUI: ${bot2LpSui.toFixed(4)})...`);
+          const lpRes2Below = await this.bot2.lpManager.addLiquidity(bot2LowerBelow, bot2UpperBelow, bot2LpSui, false);
+          const activeIds2 = await this.bot2.lpManager.getActivePositionIds();
+          const pos2Below = lpRes2Below.positionId || activeIds2.find(id => id !== pos1Below && id !== this.bot1.state.lpPositionIdAbove);
+          if (pos2Below) {
+            this.bot2.state.lpPositionIdBelow = pos2Below;
+            this.bot2.state.rangeLowerBelow  = bot2LowerBelow;
+            this.bot2.state.rangeUpperBelow  = bot2UpperBelow;
+            Logger.success(`[Bot2] ✅ below指値LP構築完了: ${pos2Below}`);
+          }
+        }
+
+        // ── Bot2 (DEEP/SUI) above LP (DEEP 100%) ──
+        const bot2LowerAbove = price2 * (1 + offset);
+        const bot2UpperAbove = price2 * (1 + offset + width);
+        const bot2LpDeep = Math.min(finalDeep, bot2DeepNeeded * 1.02);
+
+        Logger.info(`[Bot2] DEEP/SUI above指値LP構築 (レンジ: ${bot2LowerAbove.toFixed(6)}-${bot2UpperAbove.toFixed(6)}, DEEP: ${bot2LpDeep.toFixed(2)})...`);
+        const lpRes2Above = await this.bot2.lpManager.addLiquidity(bot2LowerAbove, bot2UpperAbove, bot2LpDeep, true);
+        const activeIds2_final = await this.bot2.lpManager.getActivePositionIds();
+        const pos2Above = lpRes2Above.positionId || activeIds2_final.find(id => id !== pos1Below && id !== this.bot1.state.lpPositionIdAbove && id !== this.bot2.state.lpPositionIdBelow);
+        if (pos2Above) {
+          this.bot2.state.lpPositionIdAbove = pos2Above;
+          this.bot2.state.rangeLowerAbove  = bot2LowerAbove;
+          this.bot2.state.rangeUpperAbove  = bot2UpperAbove;
+          Logger.success(`[Bot2] ✅ above指値LP構築完了: ${pos2Above}`);
+        }
+
+        this.bot1.state.basePrice   = price1;
+        this.bot1.state.phase       = 'B';
+        this.bot1.currentPhase      = CyclePhase.B;
 
-      // ── Step 3: Bot1 / Bot2 に 50:50 配分 ──
-      const bot1AllocUsdc = totalAssetsUsdc * 0.50;
-      const bot2AllocUsdc = totalAssetsUsdc * 0.50;
-      Logger.info(`[PHASE_A] 資金配分: Bot1 ≈$${bot1AllocUsdc.toFixed(2)}, Bot2 ≈$${bot2AllocUsdc.toFixed(2)}`);
-
-      // ── Step 3.5: SUI不足を自動補充（USDC → SUI スワップ）──
-      // Bot2のLP構築とガス代に必要なSUI量を事前に確保する
-      // Bot1はUSDCからSUIをスワップするが、そのSUIはBot1のLPに消費される。
-      // Bot2のLPにも別途SUIが必要なため、それを先に確保しておく。
-      const bot2SuiNeededEst = (bot2AllocUsdc * 0.50) / price1; // Bot2が必要なSUI（概算）
-      const totalSuiNeeded   = GAS_RESERVE + bot2SuiNeededEst;
-      const suiShortfall     = totalSuiNeeded - balance.suiBalance;
-
-      if (suiShortfall > 0.05 && balance.usdcBalance > 1.0) {
-        // 不足分 + 余裕10%をUSDCでスワップ（ただしUSDCの30%を上限）
-        const suiShortfallUsdc = suiShortfall * price1 * 1.10;
-        const swapUsdcForSui   = Math.min(suiShortfallUsdc, balance.usdcBalance * 0.30);
-
-        if (swapUsdcForSui > 0.3) {
-          Logger.info(`[PHASE_A] ⚠️ SUI不足を検知 (残高: ${balance.suiBalance.toFixed(4)} SUI, 必要: ${totalSuiNeeded.toFixed(4)} SUI)`);
-          Logger.info(`[PHASE_A] 🔄 USDC $${swapUsdcForSui.toFixed(2)} → SUI を自動スワップして補充します...`);
-          const autoSuiSwap = await this.bot1.swapManager.swapUsdcToSui(swapUsdcForSui);
-          Logger.success(`[PHASE_A] ✅ SUI自動補充完了: ${autoSuiSwap.amountOut.toFixed(4)} SUI を獲得`);
+        this.bot2.state.basePrice   = price2;
+        this.bot2.state.phase       = 'B';
+        this.bot2.currentPhase      = CyclePhase.B;
+
+        Logger.success('[PHASE_A] ===== 指値レンジ戦略 統合フェーズA 完了 =====');
+      } else {
+        // ── 従来のデルタニュートラル（DN）戦略フェーズA ──
+        Logger.info('[Bot1] === フェーズA 開始 (SUI/USDC) ===');
+        this.bot1.currentPhase = CyclePhase.A;
+        await this.bot1.lpManager.forceCloseAllPositions();
+        this.bot1.state.lpPositionId = null;
+
+        // Bot1: 割当の50%をUSDC→SUIにスワップ（LP用SUI確保）
+        // ウォレット全体のUSDCの45%を上限にして安全にスワップ
+        const bot1SwapUsdc = Math.min(bot1AllocUsdc * 0.50, balance.usdcBalance * 0.45);
+        if (bot1SwapUsdc > 0.5) {
+          Logger.info(`[Bot1] USDC $${bot1SwapUsdc.toFixed(2)} → SUI スワップ...`);
+          const swapRes1 = await this.bot1.swapManager.swapUsdcToSui(bot1SwapUsdc);
           await this.tracker.recordEvent(
-            'SUI自動補充',
-            `SUI残高不足のため USDC $${swapUsdcForSui.toFixed(2)} → ${autoSuiSwap.amountOut.toFixed(4)} SUI に自動スワップしました`,
-            price1, autoSuiSwap.digest
+            '初期スワップ',
+            `[Bot1] USDC $${bot1SwapUsdc.toFixed(2)} を SUI にスワップ。獲得: ${swapRes1.amountOut.toFixed(4)} SUI`,
+            price1, swapRes1.digest
           ).catch(() => {});
         }
-      }
 
-      // ════════════════════════════════════════
-      //  Bot1 (SUI/USDC) フェーズA
-      // ════════════════════════════════════════
-      Logger.info('[Bot1] === フェーズA 開始 (SUI/USDC) ===');
-      this.bot1.currentPhase = CyclePhase.A;
-      await this.bot1.lpManager.forceCloseAllPositions();
-      this.bot1.state.lpPositionId = null;
+        // スワップ後の最新残高でLP構築（残っているUSDCを使用）
+        const bot1Bal = await this.bot1.lpManager.checkBalance();
+        const bot1LpUsdc = Math.min(bot1Bal.usdcBalance, bot1AllocUsdc * 0.52); // 少し余裕を持たせる
+        const bot1Lower = price1 * (1 - this.bot1.state.rangeWidth);
+        const bot1Upper = price1 * (1 + this.bot1.state.rangeWidth);
 
-      // Bot1: 割当の50%をUSDC→SUIにスワップ（LP用SUI確保）
-      // ウォレット全体のUSDCの45%を上限にして安全にスワップ
-      const bot1SwapUsdc = Math.min(bot1AllocUsdc * 0.50, balance.usdcBalance * 0.45);
-      if (bot1SwapUsdc > 0.5) {
-        Logger.info(`[Bot1] USDC $${bot1SwapUsdc.toFixed(2)} → SUI スワップ...`);
-        const swapRes1 = await this.bot1.swapManager.swapUsdcToSui(bot1SwapUsdc);
+        Logger.info(`[Bot1] SUI/USDC LP構築 (レンジ: $${bot1Lower.toFixed(4)}-$${bot1Upper.toFixed(4)}, USDC: $${bot1LpUsdc.toFixed(2)})...`);
+        const lpRes1 = await this.bot1.lpManager.addLiquidity(bot1Lower, bot1Upper, bot1LpUsdc, true);
         await this.tracker.recordEvent(
-          '初期スワップ',
-          `[Bot1] USDC $${bot1SwapUsdc.toFixed(2)} を SUI にスワップ。獲得: ${swapRes1.amountOut.toFixed(4)} SUI`,
-          price1, swapRes1.digest
+          'LP提供',
+          `[Bot1] SUI-USDC LP構築完了。レンジ: $${bot1Lower.toFixed(4)}-$${bot1Upper.toFixed(4)}`,
+          price1, lpRes1.digest
         ).catch(() => {});
-      }
 
-      // スワップ後の最新残高でLP構築（残っているUSDCを使用）
-      const bot1Bal = await this.bot1.lpManager.checkBalance();
-      const bot1LpUsdc = Math.min(bot1Bal.usdcBalance, bot1AllocUsdc * 0.52); // 少し余裕を持たせる
-      const bot1Lower = price1 * (1 - this.bot1.state.rangeWidth);
-      const bot1Upper = price1 * (1 + this.bot1.state.rangeWidth);
-
-      Logger.info(`[Bot1] SUI/USDC LP構築 (レンジ: $${bot1Lower.toFixed(4)}-$${bot1Upper.toFixed(4)}, USDC: $${bot1LpUsdc.toFixed(2)})...`);
-      const lpRes1 = await this.bot1.lpManager.addLiquidity(bot1Lower, bot1Upper, bot1LpUsdc, true);
-      await this.tracker.recordEvent(
-        'LP提供',
-        `[Bot1] SUI-USDC LP構築完了。レンジ: $${bot1Lower.toFixed(4)}-$${bot1Upper.toFixed(4)}`,
-        price1, lpRes1.digest
-      ).catch(() => {});
+        const pos1 = lpRes1.positionId || await this.bot1.lpManager.getActivePositionId();
+        if (pos1) {
+          this.bot1.state.lpPositionId = pos1;
+          this.bot1.state.basePrice   = price1;
+          this.bot1.state.rangeLower  = bot1Lower;
+          this.bot1.state.rangeUpper  = bot1Upper;
+          this.bot1.state.phase       = 'B';
+          this.bot1.currentPhase      = CyclePhase.B;
+          Logger.success(`[Bot1] ✅ フェーズA完了。ポジション: ${pos1}`);
+        } else {
+          Logger.warn('[Bot1] ⚠️ ポジションIDの取得に失敗。次のサイクルで再試行します。');
+        }
 
-      const pos1 = lpRes1.positionId || await this.bot1.lpManager.getActivePositionId();
-      if (pos1) {
-        this.bot1.state.lpPositionId = pos1;
-        this.bot1.state.basePrice   = price1;
-        this.bot1.state.rangeLower  = bot1Lower;
-        this.bot1.state.rangeUpper  = bot1Upper;
-        this.bot1.state.phase       = 'B';
-        this.bot1.currentPhase      = CyclePhase.B;
-        Logger.success(`[Bot1] ✅ フェーズA完了。ポジション: ${pos1}`);
-      } else {
-        Logger.warn('[Bot1] ⚠️ ポジションIDの取得に失敗。次のサイクルで再試行します。');
-      }
+        // ════════════════════════════════════════
+        //  Bot2 (DEEP/SUI) フェーズA
+        // ════════════════════════════════════════
+        Logger.info('[Bot2] === フェーズA 開始 (DEEP/SUI) ===');
+        this.bot2.currentPhase = CyclePhase.A;
+        await this.bot2.lpManager.forceCloseAllPositions();
+        this.bot2.state.lpPositionId = null;
+
+        // Bot2: DEEP と SUI を 50:50 で用意する
+        // 必要なDEEP量 = bot2割当の半分 ÷ (DEEP/USDCレート)
+        const bot2DeepNeeded = (bot2AllocUsdc * 0.50) / (price2 * price1);
+        const bot2SuiNeeded  = (bot2AllocUsdc * 0.50) / price1;
+
+        Logger.info(`[Bot2] 目標: DEEP ${bot2DeepNeeded.toFixed(2)} + SUI ${bot2SuiNeeded.toFixed(4)}`);
+        Logger.info(`[Bot2] 現在: DEEP ${deepBalance.toFixed(2)} + SUI (safe) ${safeSuiTotal.toFixed(4)}`);
+
+        // DEEPが不足している場合のみ SUI → DEEP スワップ
+        const deepShortfall = bot2DeepNeeded - deepBalance;
+        if (deepShortfall > 1.0) {
+          // 不足DEEPをSUIから調達（現在のSUI残高を再取得）
+          const preBal2 = await this.bot1.lpManager.checkBalance();
+          const availSuiForDeep = Math.max(0, preBal2.suiBalance - GAS_RESERVE);
+          const suiForDeepSwap  = Math.min(
+            deepShortfall * price2,     // 不足分のSUI換算
+            availSuiForDeep * 0.40      // 利用可能SUIの40%を上限
+          );
+
+          if (suiForDeepSwap > 0.05) {
+            Logger.info(`[Bot2] DEEPが不足 (${deepShortfall.toFixed(2)} DEEP不足)。SUI ${suiForDeepSwap.toFixed(4)} → DEEP スワップ...`);
+            const swapDeepRes = await this.bot2.swapManager.swapSuiToDeep(suiForDeepSwap);
+            await this.tracker.recordEvent(
+              '初期スワップ',
+              `[Bot2] SUI ${suiForDeepSwap.toFixed(4)} を DEEP にスワップ。獲得: ${swapDeepRes.amountOut.toFixed(4)} DEEP`,
+              price1, swapDeepRes.digest
+            ).catch(() => {});
+          }
+        }
 
-      // ════════════════════════════════════════
-      //  Bot2 (DEEP/SUI) フェーズA
-      // ════════════════════════════════════════
-      Logger.info('[Bot2] === フェーズA 開始 (DEEP/SUI) ===');
-      this.bot2.currentPhase = CyclePhase.A;
-      await this.bot2.lpManager.forceCloseAllPositions();
-      this.bot2.state.lpPositionId = null;
+        // SUIはBot1のLP構築後に残った分を使用（ガス代確保後）
+        const bot2FinalBal  = await this.bot1.lpManager.checkBalance();
+        const bot2AvailSui  = Math.max(0, bot2FinalBal.suiBalance - GAS_RESERVE);
+        const bot2SuiForLp  = Math.min(bot2AvailSui * 0.95, bot2SuiNeeded * 1.10);
 
-      // Bot2: DEEP と SUI を 50:50 で用意する
-      // 必要なDEEP量 = bot2割当の半分 ÷ (DEEP/USDCレート)
-      const bot2DeepNeeded = (bot2AllocUsdc * 0.50) / (price2 * price1);
-      const bot2SuiNeeded  = (bot2AllocUsdc * 0.50) / price1;
+        if (bot2SuiForLp > 0.1) {
+          const bot2Lower = price2 * (1 - this.bot2.state.rangeWidth);
+          const bot2Upper = price2 * (1 + this.bot2.state.rangeWidth);
 
-      Logger.info(`[Bot2] 目標: DEEP ${bot2DeepNeeded.toFixed(2)} + SUI ${bot2SuiNeeded.toFixed(4)}`);
-      Logger.info(`[Bot2] 現在: DEEP ${deepBalance.toFixed(2)} + SUI (safe) ${safeSuiTotal.toFixed(4)}`);
+          Logger.info(`[Bot2] DEEP/SUI LP構築 (レンジ: ${bot2Lower.toFixed(6)}-${bot2Upper.toFixed(6)}, SUI: ${bot2SuiForLp.toFixed(4)})...`);
+          const lpRes2 = await this.bot2.lpManager.addLiquidity(bot2Lower, bot2Upper, bot2SuiForLp, false);
+          await this.tracker.recordEvent(
+            'LP提供',
+            `[Bot2] DEEP-SUI LP構築完了。レンジ: ${bot2Lower.toFixed(6)}-${bot2Upper.toFixed(6)}`,
+            price1, lpRes2.digest
+          ).catch(() => {});
+
+          const pos2 = lpRes2.positionId || await this.bot2.lpManager.getActivePositionId();
+          if (pos2) {
+            this.bot2.state.lpPositionId = pos2;
+            this.bot2.state.basePrice   = price2;
+            this.bot2.state.rangeLower  = bot2Lower;
+            this.bot2.state.rangeUpper  = bot2Upper;
+            this.bot2.state.phase       = 'B';
+            this.bot2.currentPhase      = CyclePhase.B;
+            Logger.success(`[Bot2] ✅ フェーズA完了。ポジション: ${pos2}`);
+          } else {
+            Logger.warn('[Bot2] ⚠️ ポジションIDの取得に失敗。次のサイクルで再試行します。');
+          }
+        } else {
+          Logger.warn(`[Bot2] SUI残高不足のためBot2 LP構築をスキップ (利用可能: ${bot2SuiForLp.toFixed(4)} SUI)。SUIを入金後、再度ボットを起動してください。`);
+        }
 
-      // DEEPが不足している場合のみ SUI → DEEP スワップ
-      const deepShortfall = bot2DeepNeeded - deepBalance;
-      if (deepShortfall > 1.0) {
-        // 不足DEEPをSUIから調達（現在のSUI残高を再取得）
+        Logger.success('[PHASE_A] ===== 両ボット統合フェーズA 完了 =====');
+      }EEPをSUIから調達（現在のSUI残高を再取得）
         const preBal2 = await this.bot1.lpManager.checkBalance();
         const availSuiForDeep = Math.max(0, preBal2.suiBalance - GAS_RESERVE);
         const suiForDeepSwap  = Math.min(
diff --git a/ecosystem.config.cjs b/ecosystem.config.cjs
index df2517f..feaba55 100644
--- a/ecosystem.config.cjs
+++ b/ecosystem.config.cjs
@@ -2,7 +2,7 @@ module.exports = {
   apps: [
     {
       name: 'sui-bot-backend',
-      script: 'bot_v2/dist/index.js',
+      script: 'dist/index.js',
       cwd: 'bot_v2',
       watch: false,
       autorestart: true,
diff --git a/frontend/src/App.tsx b/frontend/src/App.tsx
index 4073557..fd8cd74 100644
--- a/frontend/src/App.tsx
+++ b/frontend/src/App.tsx
@@ -1,5 +1,5 @@
-import { useState, useEffect } from 'react';
-import { Activity, DollarSign, Repeat, PowerOff, TrendingUp, BarChart3, Wallet } from 'lucide-react';
+import { useState, useEffect, useCallback, useRef } from 'react';
+import { Activity, DollarSign, Repeat, PowerOff, TrendingUp, BarChart3, Wallet, CheckCircle, AlertCircle, Loader } from 'lucide-react';
 import { StatCard } from './components/StatCard';
 import { PriceChart } from './components/PriceChart';
 import { BalanceChart } from './components/BalanceChart';
@@ -18,6 +18,13 @@ import { MultiBotPanel } from './components/MultiBotPanel';
 import MarketAdvisor from './components/MarketAdvisor';
 import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit';
 
+// トースト通知の型
+interface Toast {
+  id: number;
+  message: string;
+  type: 'success' | 'error' | 'loading';
+}
+
 function App() {
   const currentAccount = useCurrentAccount();
   
@@ -25,6 +32,22 @@ function App() {
   const [isSettingsOpen, setIsSettingsOpen] = useState(false);
   const [isHelpOpen, setIsHelpOpen] = useState(false);
   const [allSessions, setAllSessions] = useState<any[]>([]);
+  const [toasts, setToasts] = useState<Toast[]>([]);
+  const [isActionPending, setIsActionPending] = useState(false);
+  const toastIdRef = useRef(0);
+
+  const showToast = useCallback((message: string, type: Toast['type'] = 'success', duration = 3000) => {
+    const id = ++toastIdRef.current;
+    setToasts(prev => [...prev, { id, message, type }]);
+    if (type !== 'loading') {
+      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
+    }
+    return id;
+  }, []);
+
+  const dismissToast = useCallback((id: number) => {
+    setToasts(prev => prev.filter(t => t.id !== id));
+  }, []);
   
   const [sessionId, setSessionId] = useState(() => localStorage.getItem('session_id') || '');
   const [botWalletAddress, setBotWalletAddress] = useState(() => localStorage.getItem('bot_wallet_address') || '');
@@ -239,21 +262,19 @@ function App() {
       }
     };
     fetchStats();
-    const interval = setInterval(fetchStats, 3000);
+    const interval = setInterval(fetchStats, 5000); // 5秒間隔でポーリング（ボタン操作との競合を減らす）
     return () => clearInterval(interval);
   }, [apiUrl, sessionId]);
 
   const handleApplyAdvisorRecommendation = async (mode: 'LP_ONLY' | 'DELTA_NEUTRAL') => {
-    if (!sessionId) return;
+    if (!sessionId || isActionPending) return;
+    const isHedge = mode === 'DELTA_NEUTRAL';
+    const updatedConfig = { ...stats.config, hedgeEnabled: isHedge, hedgeMode: isHedge ? 'bluefin' : 'simulate', rangeWidth: 0.04 };
+    // 楽観的UI更新
+    setStats(prev => ({ ...prev, config: { ...prev.config, ...updatedConfig } }));
+    setIsActionPending(true);
+    const loadingId = showToast(`AI戦略「${mode}」を適用中...`, 'loading');
     try {
-      const isHedge = mode === 'DELTA_NEUTRAL';
-      const updatedConfig = {
-        ...stats.config,
-        hedgeEnabled: isHedge,
-        hedgeMode: isHedge ? 'bluefin' : 'simulate',
-        rangeWidth: 0.04 
-      };
-
       const response = await fetch(`${apiUrl}/api/config`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
@@ -264,44 +285,57 @@ function App() {
           hedgeRatio: (updatedConfig.hedgeRatio * 100).toString(),
         }),
       });
-
       const data = await response.json();
+      dismissToast(loadingId);
       if (data.success) {
-        alert(`AI Strategy Applied: ${mode}. Bot is rebalancing...`);
-        // 最新のステータスを取得
-        const statsRes = await fetch(`${apiUrl}/api/stats?sessionId=${sessionId}`);
-        const statsData = await statsRes.json();
-        if (statsData.success) {
-          setStats(statsData.data);
-        }
+        showToast(`✅ AI戦略「${mode}」を適用しました。ボットがリバランス中...`);
+      } else {
+        showToast('AI戦略の適用に失敗しました', 'error');
       }
     } catch (err) {
-      console.error('Failed to apply strategy', err);
-      alert('Failed to apply AI strategy.');
+      dismissToast(loadingId);
+      showToast('AI戦略の適用に失敗しました', 'error');
+    } finally {
+      setIsActionPending(false);
     }
   };
 
   const toggleBotState = async () => {
-    if (!sessionId) return;
-    
+    if (!sessionId || isActionPending) return;
+    const nextActive = !isBotActive;
+    // 楽観的UI更新（即時反応）
+    setIsBotActive(nextActive);
+    setIsActionPending(true);
+    const loadingId = showToast(nextActive ? 'ボットを起動中...⚙️' : 'ボットを停止中...', 'loading');
     try {
-      const endpoint = isBotActive ? '/api/stop' : '/api/start';
+      const endpoint = nextActive ? '/api/start' : '/api/stop';
       const response = await fetch(`${apiUrl}${endpoint}`, { 
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ sessionId })
       });
       const data = await response.json();
+      dismissToast(loadingId);
       if (data.success) {
-        setIsBotActive(!isBotActive);
+        showToast(nextActive ? '✅ ボットを起動しました' : '⏹️ ボットを停止しました', 'success');
+      } else {
+        // ロールバック
+        setIsBotActive(!nextActive);
+        showToast('操作に失敗しました', 'error');
       }
     } catch (e) {
-      console.error('Failed to communicate with bot backend', e);
-      alert('Network Error: Make sure your backend API is running at ' + apiUrl);
+      dismissToast(loadingId);
+      setIsBotActive(!nextActive); // ロールバック
+      showToast('通信エラー: バックエンドが起動中か確認してください', 'error', 5000);
+    } finally {
+      setIsActionPending(false);
     }
   };
 
   const handleUpdateCapital = async (newAmount: number) => {
+    // 楽観的UI更新
+    setStats(prev => ({ ...prev, config: { ...prev.config, lpAmountUsdc: newAmount } }));
+    const loadingId = showToast('運用資金を更新中...', 'loading');
     try {
       const response = await fetch(`${apiUrl}/api/config`, {
         method: 'POST',
@@ -316,18 +350,26 @@ function App() {
         }),
       });
       const data = await response.json();
+      dismissToast(loadingId);
       if (data.success) {
-        setStats(prev => ({ ...prev, config: { ...prev.config, lpAmountUsdc: newAmount } }));
-        alert(`✅ 運用資金を ${newAmount} USDC に更新しました`);
+        showToast(`✅ 運用資金を ${newAmount} USDC に更新しました`);
+      } else {
+        showToast('更新に失敗しました', 'error');
       }
     } catch (e) {
-      alert('更新に失敗しました。バックエンドが起動中か確認してください。');
+      dismissToast(loadingId);
+      showToast('更新に失敗しました。バックエンドが起動中か確認してください。', 'error', 5000);
     }
   };
 
   const handleUpdateStrategyMode = async (mode: 'balanced' | 'range_order', hedgeEnabled: boolean) => {
-    if (!sessionId) return;
-    
+    if (!sessionId || isActionPending) return;
+    // 楽観的UI更新（即時反応）
+    const prevConfig = stats.config;
+    setStats(prev => ({ ...prev, config: { ...prev.config, strategyMode: mode, hedgeEnabled } }));
+    setIsActionPending(true);
+    const modeText = mode === 'balanced' ? 'ヘッジあり' : 'ヘッジなし';
+    const loadingId = showToast(`戦略を「${modeText}」に切り替え中...`, 'loading');
     try {
       const response = await fetch(`${apiUrl}/api/config`, {
         method: 'POST',
@@ -335,7 +377,7 @@ function App() {
         body: JSON.stringify({
           sessionId,
           strategyMode: mode,
-          hedgeEnabled: hedgeEnabled,
+          hedgeEnabled,
           lpAmountUsdc: stats.config.lpAmountUsdc,
           rangeWidth: (stats.config.rangeWidth * 100).toString(),
           hedgeRatio: (stats.config.hedgeRatio * 100).toString(),
@@ -343,26 +385,31 @@ function App() {
         }),
       });
       const data = await response.json();
+      dismissToast(loadingId);
       if (data.success) {
-        setStats(prev => ({ ...prev, config: { ...prev.config, strategyMode: mode, hedgeEnabled: hedgeEnabled } }));
-        // ボットが稼働中の場合はリバランスがトリガーされる旨を通知
-        const modeText = mode === 'balanced' ? 'ヘッジあり (バランス型)' : 'ヘッジなし (指値レンジ型)';
-        if (isBotActive) {
-          alert(`🚀 戦略を 「${modeText}」 に切り替えました。即座にリセット・再構築が実行されます。`);
-        } else {
-          alert(`✅ 戦略を 「${modeText}」 に設定しました。`);
-        }
+        showToast(isBotActive ? `🚀 「${modeText}」に切り替えました。再構築を実行します。` : `✅ 「${modeText}」に設定しました。`);
+      } else {
+        setStats(prev => ({ ...prev, config: prevConfig })); // ロールバック
+        showToast('戦略の切り替えに失敗しました', 'error');
       }
     } catch (e) {
-      alert('戦略の切り替えに失敗しました。');
+      dismissToast(loadingId);
+      setStats(prev => ({ ...prev, config: prevConfig })); // ロールバック
+      showToast('戦略の切り替えに失敗しました', 'error');
+    } finally {
+      setIsActionPending(false);
     }
   };
 
   const handleToggleHedge = async () => {
-    if (!sessionId) return;
+    if (!sessionId || isActionPending) return;
     const nextHedgeEnabled = !stats.config.hedgeEnabled;
     const nextStrategyMode = nextHedgeEnabled ? 'balanced' : 'range_order';
-    
+    // 楽観的UI更新（即時反応）
+    const prevConfig = stats.config;
+    setStats(prev => ({ ...prev, config: { ...prev.config, strategyMode: nextStrategyMode, hedgeEnabled: nextHedgeEnabled } }));
+    setIsActionPending(true);
+    const loadingId = showToast(`ヘッジを「${nextHedgeEnabled ? 'ON' : 'OFF'}」に切り替え中...`, 'loading');
     try {
       const response = await fetch(`${apiUrl}/api/config`, {
         method: 'POST',
@@ -378,29 +425,29 @@ function App() {
         }),
       });
       const data = await response.json();
+      dismissToast(loadingId);
       if (data.success) {
-        setStats(prev => ({ 
-          ...prev, 
-          config: { 
-            ...prev.config, 
-            strategyMode: nextStrategyMode, 
-            hedgeEnabled: nextHedgeEnabled 
-          } 
-        }));
-        
-        if (isBotActive) {
-          alert(`🚀 ヘッジを「${nextHedgeEnabled ? 'ON' : 'OFF'}」に切り替えました。ボットのリバランス・クローズが即座に実行されます。`);
-        } else {
-          alert(`✅ ヘッジを「${nextHedgeEnabled ? 'ON' : 'OFF'}」に設定しました。`);
-        }
+        showToast(isBotActive
+          ? `🚀 ヘッジ「${nextHedgeEnabled ? 'ON' : 'OFF'}」。リバランスを実行します。`
+          : `✅ ヘッジを「${nextHedgeEnabled ? 'ON' : 'OFF'}」に設定しました。`);
+      } else {
+        setStats(prev => ({ ...prev, config: prevConfig })); // ロールバック
+        showToast('ヘッジの切り替えに失敗しました', 'error');
       }
     } catch (e) {
-      alert('ヘッジの切り替えに失敗しました。');
+      dismissToast(loadingId);
+      setStats(prev => ({ ...prev, config: prevConfig })); // ロールバック
+      showToast('ヘッジの切り替えに失敗しました', 'error');
+    } finally {
+      setIsActionPending(false);
     }
   };
 
   const handleUpdateRangeWidth = async (newWidth: number) => {
     if (!sessionId) return;
+    // 楽観的UI更新
+    setStats(prev => ({ ...prev, config: { ...prev.config, rangeWidth: newWidth / 100 } }));
+    const loadingId = showToast(`レンジ幅を ±${newWidth.toFixed(1)}% に更新中...`, 'loading');
     try {
       const response = await fetch(`${apiUrl}/api/config`, {
         method: 'POST',
@@ -416,17 +463,15 @@ function App() {
         }),
       });
       const data = await response.json();
+      dismissToast(loadingId);
       if (data.success) {
-        setStats(prev => ({ 
-          ...prev, 
-          config: { 
-            ...prev.config, 
-            rangeWidth: newWidth / 100 
-          } 
-        }));
+        showToast(`✅ レンジ幅を ±${newWidth.toFixed(1)}% に設定しました`);
+      } else {
+        showToast('レンジ幅の更新に失敗しました', 'error');
       }
     } catch (e) {
-      console.error('Failed to update range width', e);
+      dismissToast(loadingId);
+      showToast('レンジ幅の更新に失敗しました', 'error');
     }
   };
 
@@ -449,6 +494,37 @@ function App() {
 
   return (
     <div className="dashboard-container">
+      {/* トースト通知システム */}
+      <div style={{
+        position: 'fixed', top: '20px', right: '20px', zIndex: 9999,
+        display: 'flex', flexDirection: 'column', gap: '8px', pointerEvents: 'none'
+      }}>
+        {toasts.map(toast => (
+          <div key={toast.id} style={{
+            display: 'flex', alignItems: 'center', gap: '10px',
+            padding: '12px 16px', borderRadius: '12px',
+            background: toast.type === 'success' ? 'rgba(34, 197, 94, 0.15)'
+              : toast.type === 'error' ? 'rgba(239, 68, 68, 0.15)'
+              : 'rgba(88, 166, 255, 0.15)',
+            border: `1px solid ${
+              toast.type === 'success' ? 'rgba(34, 197, 94, 0.4)'
+              : toast.type === 'error' ? 'rgba(239, 68, 68, 0.4)'
+              : 'rgba(88, 166, 255, 0.4)'
+            }`,
+            backdropFilter: 'blur(12px)',
+            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
+            color: 'white', fontSize: '0.85rem', fontWeight: 600,
+            minWidth: '260px', maxWidth: '360px',
+            animation: 'slideInRight 0.25s ease-out',
+            pointerEvents: 'auto'
+          }}>
+            {toast.type === 'success' && <CheckCircle size={16} color="#22c55e" style={{ flexShrink: 0 }} />}
+            {toast.type === 'error' && <AlertCircle size={16} color="#ef4444" style={{ flexShrink: 0 }} />}
+            {toast.type === 'loading' && <Loader size={16} color="#58a6ff" style={{ flexShrink: 0, animation: 'spin 1s linear infinite' }} />}
+            <span style={{ flex: 1 }}>{toast.message}</span>
+          </div>
+        ))}
+      </div>
       <header className="header">
         <div className="header-title-section">
           <h1>
@@ -521,6 +597,7 @@ function App() {
           {sessionId && (
             <button
               onClick={handleToggleHedge}
+              disabled={isActionPending}
               style={{
                 display: 'flex',
                 alignItems: 'center',
@@ -532,8 +609,9 @@ function App() {
                 borderRadius: '12px',
                 fontSize: '0.85rem',
                 fontWeight: 700,
-                cursor: 'pointer',
-                transition: 'all 0.2s',
+                cursor: isActionPending ? 'not-allowed' : 'pointer',
+                opacity: isActionPending ? 0.7 : 1,
+                transition: 'all 0.15s',
                 border: '1px solid',
                 boxShadow: stats.config?.hedgeEnabled ? '0 0 8px rgba(255, 159, 67, 0.15)' : 'none',
               }}
diff --git a/frontend/src/index.css b/frontend/src/index.css
index f12ad88..272a110 100644
--- a/frontend/src/index.css
+++ b/frontend/src/index.css
@@ -132,6 +132,16 @@ body {
   animation: pulse-slow 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
 }
 
+@keyframes slideInRight {
+  from { opacity: 0; transform: translateX(24px); }
+  to   { opacity: 1; transform: translateX(0); }
+}
+
+@keyframes spin {
+  from { transform: rotate(0deg); }
+  to   { transform: rotate(360deg); }
+}
+
 /* シンプルで高品質なボタン */
 button.primary-btn {
   background: var(--accent);
