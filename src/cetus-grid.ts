// ============================================================
// src/cetus-grid.ts  — Cetus DEX アダプタ（直接SuiClient版）
// CetusSDK内部RPCは使用せず、@mysten/suiで直接オンチェーンアクセス
// ============================================================

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { initCetusSDK, clmmMainnet, clmmTestnet, TransactionUtil, ClmmPoolUtil, TickMath } from "@cetusprotocol/cetus-sui-clmm-sdk";
import BN from "bn.js";
import type { IGridAdapter, LpPosition, PositionRange, Dex } from "./types.js";
import { calcSide, generateId } from "./utils.js";

// Cetus CLMMのメインネット設定
const CETUS_MAINNET_PACKAGE = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const CETUS_POSITION_TYPE = `${CETUS_MAINNET_PACKAGE}::position::Position`;

// Cetus プールアドレスマッピング（メインネットのみ）
const POOL_CONFIG: Record<string, string> = {
  "DEEP/SUI": "0xe01243f37f712ef87e556afb9b1d03d0fae13f96d324ec912daffc339dfdcbd2",
  "SUI/USDC": "0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105",
};

export class CetusGridAdapter implements IGridAdapter {
  readonly dex: Dex = "cetus";
  /** デコード済みウォレットアドレス（秘密鍵ではない） */
  readonly walletAddress: string;
  private client: SuiClient;
  private keypair: Ed25519Keypair | null = null;
  private sdk: any;
  private rpcUrl: string;

  constructor(walletPrivateKey: string) {
    const envRpc = process.env.SUI_RPC_URL;
    if (!envRpc) {
      throw new Error("[Cetus] SUI_RPC_URL is not defined in environment variables. Mainnet RPC is required.");
    }
    this.rpcUrl = envRpc;
    this.client = new SuiClient({ url: this.rpcUrl });

    // 秘密鍵のデコードとKeypair生成
    let address = "";
    if (walletPrivateKey && !walletPrivateKey.startsWith("0x")) {
      try {
        const { secretKey } = decodeSuiPrivateKey(walletPrivateKey);
        this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
        address = this.keypair.getPublicKey().toSuiAddress();
        console.log(`[Cetus] Keypair loaded. Address: ${address}`);
      } catch (e) {
        console.error("[Cetus] Failed to decode private key:", e);
      }
    } else if (walletPrivateKey.startsWith("0x")) {
      address = walletPrivateKey;
    }
    this.walletAddress = address;

    // Cetus SDK をメインネット設定に固定し、自前RPCで初期化
    this.sdk = initCetusSDK({
      ...clmmMainnet,
      network: "mainnet",
      fullNodeUrl: this.rpcUrl,
      simulationAccount: { address },
    } as any);
    this.sdk.senderAddress = address;

    console.log(`[Cetus] Initialized on MAINNET ONLY`);
    console.log(`[Cetus] RPC: ${this.rpcUrl}`);
    console.log(`[Cetus] Address: ${address}`);
  }

  /**
   * ウォレットのトークン残高を直接SuiClient経由で取得（ページネーション対応）
   */
  async getWalletBalances(walletAddress: string): Promise<Record<string, string>> {
    try {
      const balances: Record<string, bigint> = {};
      let hasNextPage = true;
      let nextCursor: string | null | undefined = undefined;

      while (hasNextPage) {
        const coins = await this.client.getAllCoins({
          owner: walletAddress,
          cursor: nextCursor || undefined,
        });

        for (const coin of coins.data) {
          const parts = coin.coinType.split("::");
          const symbol = parts[parts.length - 1] || "UNKNOWN";
          balances[symbol] = (balances[symbol] || 0n) + BigInt(coin.balance);
        }

        hasNextPage = coins.hasNextPage;
        nextCursor = coins.nextCursor;
      }

      const result: Record<string, string> = {};
      for (const [sym, bal] of Object.entries(balances)) {
        result[sym] = bal.toString();
      }
      console.log(`[Cetus] Balances: ${JSON.stringify(result)}`);
      return result;
    } catch (e) {
      console.error("[Cetus] Failed to fetch balances:", e);
      return { SUI: "0" };
    }
  }

  async getAllPositions(walletAddress: string, knownIds?: string[], existingPositions?: Record<string, LpPosition>): Promise<LpPosition[]> {
    console.log(`[Cetus] Fetching positions for ${walletAddress} via SuiClient (known: ${knownIds?.length ?? 0})`);
    try {
      const allObjects: any[] = [];

      if (knownIds && knownIds.length > 0) {
        // 追跡中の既知ポジションIDがある場合は、それらだけをマルチゲット（1tx相当）で高速取得
        const chunks: string[][] = [];
        for (let i = 0; i < knownIds.length; i += 50) {
          chunks.push(knownIds.slice(i, i + 50));
        }
        for (const chunk of chunks) {
          const resp = await this.client.multiGetObjects({
            ids: chunk,
            options: {
              showContent: true,
              showType: true,
            },
          });
          if (resp) {
            allObjects.push(...resp);
          }
        }
      } else {
        // 既知IDがない場合（起動初回時など）のみ、全件のページネーションスキャンを行う
        let hasNextPage = true;
        let nextCursor: string | null = null;
        let pageCount = 0;

        while (hasNextPage && pageCount < 100) {
          const resp = await this.client.getOwnedObjects({
            owner: walletAddress,
            filter: {
              // メインネットのCetus Position型でフィルタ
              StructType: CETUS_POSITION_TYPE,
            },
            options: {
              showContent: true,
              showType: true,
            },
            limit: 50,
            cursor: nextCursor || undefined,
          });

          if (resp.data) {
            allObjects.push(...resp.data);
          }
          hasNextPage = resp.hasNextPage;
          nextCursor = resp.nextCursor || null;
          pageCount++;
        }
        console.log(`[Cetus] Loaded ${allObjects.length} raw position objects across ${pageCount} pages.`);
      }

      if (allObjects.length === 0) {
        console.log("[Cetus] No Cetus positions found for this wallet.");
        return [];
      }

      const poolAddresses = Object.values(POOL_CONFIG);
      const poolDataMap: Record<string, any> = {};
      const currentTickMap: Record<string, number> = {};

      for (const pName of Object.keys(POOL_CONFIG)) {
        const addr = POOL_CONFIG[pName];
        try {
          poolDataMap[addr] = await this.sdk.Pool.getPool(addr);
          currentTickMap[pName] = await this.getCurrentTick(pName);
        } catch (e) {
          console.warn(`[Cetus] Failed to pre-fetch data for pool ${pName}: ${e}`);
        }
      }

      const positions: LpPosition[] = [];

      for (const obj of allObjects) {
        if (!obj || !obj.data?.content || obj.data.content.dataType !== "moveObject") continue;
        const fields = (obj.data.content as any).fields;
        if (!fields) continue;

        const posPool = fields.pool ?? "";
        // 異なるプールのポジションは無視する
        if (!poolAddresses.includes(posPool)) {
          continue;
        }

        const poolName = Object.keys(POOL_CONFIG).find(key => POOL_CONFIG[key] === posPool) ?? "DEEP/SUI";
        const poolData = poolDataMap[posPool];
        if (!poolData) {
          continue; // キャッシュデータがない場合はスキップ
        }
        const currentTick = currentTickMap[poolName] ?? 0;

        const tickLower = parseInt(
          fields.tick_lower_index?.fields?.bits ??
          fields.tick_lower_index?.bits ??
          fields.tick_lower ??
          "0"
        );
        const tickUpper = parseInt(
          fields.tick_upper_index?.fields?.bits ??
          fields.tick_upper_index?.bits ??
          fields.tick_upper ??
          "0"
        );
        const liquidity = fields.liquidity ?? "0";
        if (BigInt(liquidity) === 0n) {
          continue;
        }

        // Cetus SDKを使って流動性からトークン量を計算
        const sqrtPriceX64 = new BN(poolData.current_sqrt_price);
        const sqrtPriceLowerX64 = TickMath.tickIndexToSqrtPriceX64(tickLower);
        const sqrtPriceUpperX64 = TickMath.tickIndexToSqrtPriceX64(tickUpper);

        const amounts = ClmmPoolUtil.getCoinAmountFromLiquidity(
          new BN(liquidity),
          sqrtPriceX64,
          sqrtPriceLowerX64,
          sqrtPriceUpperX64,
          true
        );

        const amountA = amounts.coinA.toString();
        const amountB = amounts.coinB.toString();

        const side = calcSide(tickLower, tickUpper, currentTick, BigInt(amountA), BigInt(amountB));
        const positionId = obj.data.objectId;

        let uncollectedFeeA = "0";
        let uncollectedFeeB = "0";
        const feeCalcStart = Date.now();
        for (let feeAttempt = 0; feeAttempt < 2; feeAttempt++) {
          try {
            const fees = await Promise.race([
              this.sdk.Position.calculateFee({
                pool_id: posPool,
                pos_id: positionId,
                coinTypeA: poolData.coinTypeA,
                coinTypeB: poolData.coinTypeB,
              }),
              new Promise<any>((_, reject) => setTimeout(() => reject(new Error("FeeTimeout")), 8000))
            ]);
            uncollectedFeeA = fees.feeOwedA.toString();
            uncollectedFeeB = fees.feeOwedB.toString();
            break;
          } catch (e) {
            if (feeAttempt === 0) {
              await new Promise(r => setTimeout(r, 500)); // リトライ前に500ms待機
            }
          }
        }

        // 既存のstate情報（gridIndex, bandId, mode, openedAt等）を保持する
        const existing = existingPositions?.[positionId];
        positions.push({
          positionId,
          dex: this.dex,
          pool: poolName,
          tickLower,
          tickUpper,
          currentTick,
          side,
          amountA,
          amountB,
          usdValue: 0,
          uncollectedFeeA,
          uncollectedFeeB,
          origin: existing?.origin ?? "bot",
          mode: existing?.mode ?? "grid",
          gridIndex: existing?.gridIndex ?? 0,
          bandId: existing?.bandId ?? 0,
          walletAddress,
          openedAt: existing?.openedAt ?? Date.now(),
          isActive: true,
        });
      }

      console.log(`[Cetus] Found ${positions.length} active positions for DEEP/SUI pool.`);
      return positions;
    } catch (e) {
      console.error("[Cetus] Failed to fetch positions via SuiClient:", e);
      return [];
    }
  }


  async getCurrentTick(pool: string): Promise<number> {
    try {
      const poolObjId = POOL_CONFIG[pool] || POOL_CONFIG["DEEP/SUI"];

      const poolObj = await this.client.getObject({
        id: poolObjId,
        options: { showContent: true },
      });

      if (poolObj.data?.content?.dataType === "moveObject") {
        const fields = (poolObj.data.content as any).fields;
        const tick = parseInt(
          fields?.current_tick_index?.fields?.bits ??
          fields?.current_tick_index?.bits ??
          fields?.current_tick_index ??
          "0"
        );
        console.log(`[Cetus] Current tick from chain: ${tick}`);
        return tick;
      }
    } catch (e) {
      console.warn(`[Cetus] Failed to get pool tick, using fallback: ${e}`);
    }
    // フォールバック: DEEP/SUIのおおよその価格tick
    return pool === "DEEP/SUI" ? -35000 : 0;
  }

  async getCurrentPrice(pool: string): Promise<number> {
    const tick = await this.getCurrentTick(pool);
    return Math.pow(1.0001, tick);
  }

  async getPoolTickSpacing(pool: string): Promise<number> {
    try {
      const poolObjId = POOL_CONFIG[pool] || POOL_CONFIG["DEEP/SUI"];
      const poolData = await this.sdk.Pool.getPool(poolObjId);
      return parseInt(poolData.tickSpacing ?? "60");
    } catch {
      return pool === "SUI/USDC" ? 2 : 60;
    }
  }

  /**
   * LP流動性の新規追加（発注）
   * Cetus SDK の Transaction Building を使用し、自前のSuiClientで送信
   */
  async openPosition(
    pool: string,
    range: PositionRange,
    walletAddress: string
  ): Promise<string> {
    if (!this.keypair) throw new Error("[Cetus] Keypair not loaded - cannot sign transaction");

    const poolObjId = POOL_CONFIG[pool];

    console.log(`[Cetus] Opening LP Position pool=${poolObjId} ticks=[${range.tickLower},${range.tickUpper}]`);

    try {
      // 事前にプール情報をキャッシュにロード
      const poolData = await this.sdk.Pool.getPool(poolObjId);
      console.log("[Cetus] Loaded poolData keys:", Object.keys(poolData));
      console.log("[Cetus] poolData coinTypeA:", poolData.coinTypeA);
      console.log("[Cetus] poolData coinTypeB:", poolData.coinTypeB);

      const curSqrtPrice = new BN(poolData.current_sqrt_price);

      let finalAmountA = range.amountA;
      let finalAmountB = range.amountB;
      const currentTick = await this.getCurrentTick(pool);

      // 物理的な位置関係に基づく判定
      let fixAmountA = range.side === "sell";

      if (currentTick <= range.tickLower) {
        // レンジが現在価格より完全に上（物理） ＝ CoinA (USDC/DEEP) のみが必要
        finalAmountB = "0";
        fixAmountA = true; // CoinA固定
        console.log(`[Cetus] One-sided range (Above current price). Forcing amount_b="0" and fix_amount_a=true.`);
      } else if (currentTick >= range.tickUpper) {
        // レンジが現在価格より完全に下（物理） ＝ CoinB (SUI) のみが必要
        finalAmountA = "0";
        fixAmountA = false; // CoinB固定
        console.log(`[Cetus] One-sided range (Below current price). Forcing amount_a="0" and fix_amount_a=false.`);
      } else {
        // レンジが現在価格を跨いでいる（overlapping） ＝ 両方のトークンが必要
        const balances = await this.getWalletBalances(walletAddress);
        const { symbolA, symbolB } = this.getPoolSymbols(pool);
        if (finalAmountA === "0" || finalAmountA === "") {
          finalAmountA = balances[symbolA] ?? "0";
        }
        if (finalAmountB === "0" || finalAmountB === "") {
          if (symbolB === "SUI") {
            const bal = BigInt(balances[symbolB] ?? "0");
            const buf = BigInt(process.env.GAS_BUFFER_MIST ?? "100000000");
            finalAmountB = bal > buf ? (bal - buf).toString() : "0";
          } else {
            finalAmountB = balances[symbolB] ?? "0";
          }
        }
      }

      const rawParams = {
        pool_id: poolObjId,
        coinTypeA: poolData.coinTypeA || "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
        coinTypeB: poolData.coinTypeB || "0x2::sui::SUI",
        tick_lower: String(range.tickLower),
        tick_upper: String(range.tickUpper),
        amount_a: finalAmountA,
        amount_b: finalAmountB,
        fix_amount_a: fixAmountA,
        is_increase: false,
        slippage: 0.05,
        is_open: true,
        collect_fee: false,
      };

      // TransactionUtil で params を修正（NaN BigIntエラーを防止）
      const params = TransactionUtil.fixAddLiquidityFixTokenParams(rawParams as any, 0.05, curSqrtPrice);

      console.log("[Cetus] createAddLiquidityFixTokenPayload params (fixed):", JSON.stringify(params));

      // Cetus SDK でトランザクションブロックを構築
      const txb = await this.sdk.Position.createAddLiquidityFixTokenPayload(params);

      // 自前のSuiClientで署名・送信（suiet.appではなく.envのRPCを使用）
      const txResponse = await this.client.signAndExecuteTransaction({
        signer: this.keypair,
        transaction: txb,
        options: { showEffects: true },
      });

      console.log(`[Cetus] LP Created. Tx: ${txResponse.digest}`);

      // effectsから作成されたポジションオブジェクトIDを抽出
      // created配列からCetus Position型のみを抽出
      let positionId = "";
      const created = (txResponse as any).effects?.created;
      if (Array.isArray(created)) {
        for (const c of created) {
          const objType = c?.reference?.objectId ? c : null;
          // 最初の created オブジェクトIDを使用（Cetus Position NFT）
          if (c?.reference?.objectId) {
            positionId = c.reference.objectId;
            break;
          }
        }
      }

      if (!positionId) {
        // フォールバック: digestからポジションIDを探す
        console.warn("[Cetus] Could not extract position ID from effects, using digest-based fallback");
        positionId = `cetus-pos-${txResponse.digest}`;
      }

      console.log(`[Cetus] Position ID: ${positionId}`);
      return positionId;
    } catch (e) {
      console.error("[Cetus] openPosition failed:", e);
      throw e;
    }
  }

  async closePosition(
    positionId: string,
    walletAddress: string
  ): Promise<{ amountA: string; amountB: string }> {
    if (!this.keypair) throw new Error("[Cetus] Keypair not loaded");

    console.log(`[Cetus] Closing position: ${positionId}`);

    try {
      // ポジション情報を取得して流動性を確認
      const posObj = await this.client.getObject({
        id: positionId,
        options: { showContent: true },
      });
      if (!posObj.data || !posObj.data.content || posObj.data.content.dataType !== "moveObject") {
        throw new Error(`[Cetus] Failed to retrieve metadata for position: ${positionId}`);
      }
      const fields = (posObj.data.content as any).fields;
      if (!fields) {
        throw new Error(`[Cetus] Position object fields are missing for ${positionId}`);
      }

      const poolObjId = fields.pool ?? "0xe01243f37f712ef87e556afb9b1d03d0fae13f96d324ec912daffc339dfdcbd2";
      const liquidity = fields.liquidity ?? "0";

      if (BigInt(liquidity) === 0n) {
        console.warn(`[Cetus] Position ${positionId} has 0 liquidity. Skipping removeLiquidity.`);
        return { amountA: "0", amountB: "0" };
      }

      // 事前にプール情報をキャッシュにロード
      const poolData = await this.sdk.Pool.getPool(poolObjId);


      const txb = await this.sdk.Position.removeLiquidityTransactionPayload({
        pool_id: poolObjId,
        pos_id: positionId,
        coinTypeA: poolData.coinTypeA || "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
        coinTypeB: poolData.coinTypeB || "0x2::sui::SUI",
        delta_liquidity: liquidity,
        min_amount_a: "0",
        min_amount_b: "0",
        collect_fee: true,
        rewarder_coin_types: [],
      });

      const txResponse = await this.client.signAndExecuteTransaction({
        signer: this.keypair,
        transaction: txb,
        options: {
          showBalanceChanges: true,
          showEffects: true,
        }
      });
      console.log(`[Cetus] LP Closed. Tx: ${txResponse.digest}`);

      let amountA = "0";
      let amountB = "0";

      if (txResponse.balanceChanges) {
        const addr = this.walletAddress;
        const changeA = txResponse.balanceChanges.find(
          (c: any) => c.owner.AddressOwner === addr && c.coinType === poolData.coinTypeA
        );
        const changeB = txResponse.balanceChanges.find(
          (c: any) => c.owner.AddressOwner === addr && c.coinType === poolData.coinTypeB
        );
        if (changeA) {
          amountA = Math.abs(parseInt(changeA.amount)).toString();
        }
        if (changeB) {
          amountB = Math.abs(parseInt(changeB.amount)).toString();
        }
      }

      console.log(`[Cetus] LP Closed Recovery amountA=${amountA}, amountB=${amountB}`);
      return { amountA, amountB };
    } catch (e) {
      console.error("[Cetus] closePosition failed:", e);
      throw e;
    }
  }

  async movePosition(
    pool: string,
    positionId: string,
    newRange: PositionRange,
    walletAddress: string
  ): Promise<{ positionId: string; amountA: string; amountB: string }> {
    if (!this.keypair) throw new Error("[Cetus] Keypair not loaded");

    console.log(`[Cetus] movePosition 1tx pool=${pool} pos=${positionId}`);

    let recoveredA = "0";
    let recoveredB = "0";

    try {
      // 1. クローズ予定ポジションのオブジェクトを取得して、現在の流動性(liquidity)やレンジ(tickLower/tickUpper)を算出
      const posObj = await this.client.getObject({
        id: positionId,
        options: { showContent: true },
      });
      if (!posObj.data || !posObj.data.content || posObj.data.content.dataType !== "moveObject") {
        throw new Error(`[Cetus] Failed to retrieve metadata for position to move: ${positionId}`);
      }
      const fields = (posObj.data.content as any).fields;
      if (!fields) {
        throw new Error(`[Cetus] Fields are missing for position to move: ${positionId}`);
      }

      const poolObjId = fields.pool ?? POOL_CONFIG[pool];
      const liquidity = fields.liquidity ?? "0";
      
      if (BigInt(liquidity) === 0n) {
        throw new Error(`[Cetus] Position ${positionId} has 0 liquidity. Cannot move.`);
      }

      const tickLower = parseInt(
        fields.tick_lower_index?.fields?.bits ??
        fields.tick_lower_index?.bits ??
        fields.tick_lower ??
        "0"
      );
      const tickUpper = parseInt(
        fields.tick_upper_index?.fields?.bits ??
        fields.tick_upper_index?.bits ??
        fields.tick_upper ??
        "0"
      );

      // 2. プール情報と価格情報から、回収可能なトークン量をTypeScript側で事前計算
      const poolData = await this.sdk.Pool.getPool(poolObjId);
      const sqrtPriceX64 = new BN(poolData.current_sqrt_price);
      const sqrtPriceLowerX64 = TickMath.tickIndexToSqrtPriceX64(tickLower);
      const sqrtPriceUpperX64 = TickMath.tickIndexToSqrtPriceX64(tickUpper);

      const amounts = ClmmPoolUtil.getCoinAmountFromLiquidity(
        new BN(liquidity),
        sqrtPriceX64,
        sqrtPriceLowerX64,
        sqrtPriceUpperX64,
        true
      );
      recoveredA = amounts.coinA.toString();
      recoveredB = amounts.coinB.toString();

      console.log(`[Cetus] Calculated recovered assets: amountA=${recoveredA}, amountB=${recoveredB}`);

      // 3. 空の Transaction を作成
      let tx = new Transaction();

      // 4. removeLiquidity のコマンドを追加 (クローズ処理)
      tx = await this.sdk.Position.removeLiquidityTransactionPayload({
        pool_id: poolObjId,
        pos_id: positionId,
        coinTypeA: poolData.coinTypeA || "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
        coinTypeB: poolData.coinTypeB || "0x2::sui::SUI",
        delta_liquidity: liquidity,
        min_amount_a: "0",
        min_amount_b: "0",
        collect_fee: true,
        rewarder_coin_types: [],
      }, tx);

      // 5. 新ポジションオープン用の引数を構成
      const targetRange: PositionRange = {
        ...newRange,
        amountA: newRange.side === "sell" ? recoveredA : "0",
        amountB: newRange.side === "buy" ? recoveredB : "0",
      };

      const currentTick = await this.getCurrentTick(pool);
      let finalAmountA = targetRange.amountA;
      let finalAmountB = targetRange.amountB;

      // 物理的な位置関係に基づく判定
      let fixAmountA = targetRange.side === "sell";
      const { symbolB } = this.getPoolSymbols(pool);

      if (currentTick <= targetRange.tickLower) {
        // レンジが現在価格より完全に上（物理） ＝ CoinA (USDC/DEEP) のみが必要
        finalAmountB = "0";
        fixAmountA = true; // CoinA固定
        console.log(`[Cetus] movePosition: One-sided range (Above current price). Forcing amount_b="0" and fix_amount_a=true.`);
      } else if (currentTick >= targetRange.tickUpper) {
        // レンジが現在価格より完全に下（物理） ＝ CoinB (SUI) のみが必要
        finalAmountA = "0";
        fixAmountA = false; // CoinB固定
        console.log(`[Cetus] movePosition: One-sided range (Below current price). Forcing amount_a="0" and fix_amount_a=false.`);
      } else {
        // レンジが現在価格を跨いでいる（overlapping） ＝ 両方のトークンが必要
        // SUIガス代保護バッファ調整
        if (targetRange.side === "buy" && symbolB === "SUI") {
          const balances = await this.getWalletBalances(walletAddress);
          const bal = BigInt(balances[symbolB] ?? "0");
          const buf = BigInt(process.env.GAS_BUFFER_MIST ?? "100000000");
          if (BigInt(finalAmountB) > bal - buf) {
            finalAmountB = (bal > buf ? bal - buf : 0n).toString();
          }
        }
      }

      const rawParams = {
        pool_id: poolObjId,
        coinTypeA: poolData.coinTypeA || "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
        coinTypeB: poolData.coinTypeB || "0x2::sui::SUI",
        tick_lower: String(targetRange.tickLower),
        tick_upper: String(targetRange.tickUpper),
        amount_a: finalAmountA,
        amount_b: finalAmountB,
        fix_amount_a: fixAmountA,
        is_increase: false,
        slippage: 0.05,
        is_open: true,
        collect_fee: false,
      };

      const params = TransactionUtil.fixAddLiquidityFixTokenParams(rawParams as any, 0.05, sqrtPriceX64);

      // 6. addLiquidity のコマンドを同一トランザクションに追加 (新規オープン処理)
      tx = await this.sdk.Position.createAddLiquidityFixTokenPayload(params, undefined, tx);

      // 7. 署名・送信 (1txで一括実行)
      const txResponse = await this.client.signAndExecuteTransaction({
        signer: this.keypair,
        transaction: tx,
        options: {
          showEffects: true,
        }
      });

      console.log(`[Cetus] 1tx LP Move Complete. Tx: ${txResponse.digest}`);

      // effectsから新しく作成されたLPオブジェクトIDを特定する
      let newPosId = "";
      const created = (txResponse as any).effects?.created;
      if (Array.isArray(created)) {
        for (const c of created) {
          if (c?.reference?.objectId) {
            newPosId = c.reference.objectId;
            break;
          }
        }
      }
      if (!newPosId) {
        newPosId = `cetus-pos-${txResponse.digest}`;
      }

      return {
        positionId: newPosId,
        amountA: targetRange.amountA,
        amountB: targetRange.amountB,
      };

    } catch (e) {
      console.error("[Cetus] movePosition 1tx failed:", e);
      // 1txのため、途中で落ちた場合（トランザクション全体のロールバック）はポジションがオンチェーンに残っているため CLOSE_FAILED とする
      throw new Error(`CLOSE_FAILED: movePosition 1tx failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async multiOpenPositions(
    pool: string,
    ranges: PositionRange[],
    walletAddress: string
  ): Promise<string[]> {
    console.log(`[Cetus] Opening ${ranges.length} positions with 7s delays...`);
    const ids: string[] = [];
    for (let i = 0; i < ranges.length; i++) {
      if (i > 0) {
        // オブジェクトロック競合を避けるための安全スリープ
        await new Promise((resolve) => setTimeout(resolve, 7000));
      }
      const id = await this.openPosition(pool, ranges[i], walletAddress);
      ids.push(id);
    }
    return ids;
  }

  getPoolSymbols(pool: string): { symbolA: string; symbolB: string } {
    if (pool === "SUI/USDC") {
      return { symbolA: "USDC", symbolB: "SUI" }; // コントラクト上の CoinA=USDC, CoinB=SUI
    }
    return { symbolA: "DEEP", symbolB: "SUI" }; // コントラクト上の CoinA=DEEP, CoinB=SUI
  }

  async estimateGas(_operation: string): Promise<number> {
    return 5_000_000;
  }

  /**
   * SUI→トークン スワップ（自動補充用）
   * Cetusプールで SUI を 指定トークンにスワップする
   */
  async swapSuiForToken(pool: string, tokenSymbol: string, suiAmountMist: bigint): Promise<{ digest: string; tokenReceived: string }> {
    if (!this.keypair) throw new Error("[Cetus] Keypair not loaded");

    const SUI_COIN = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
    const TOKEN_COINS: Record<string, string> = {
      DEEP: "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
      USDC: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    };
    const poolId = POOL_CONFIG[pool];
    const tokenCoin = TOKEN_COINS[tokenSymbol];
    if (!poolId || !tokenCoin) throw new Error(`[Cetus] Unknown pool=${pool} or token=${tokenSymbol}`);

    console.log(`[Cetus] swapSuiForToken: ${Number(suiAmountMist) / 1e9} SUI → ${tokenSymbol} (pool=${pool})`);

    // minAmountOutは「0」でOK（dry runエラー回避。スリッページはチェーン側で処理）
    const minAmountOut = "0";

    // 全アセットを取得し、問題のあるトークンを除外
    const allCoinAssetRaw = await this.sdk.getOwnerCoinAssets(this.walletAddress);
    const allCoinAsset = allCoinAssetRaw.filter((asset: any) => {
      const type = asset.coinType || "";
      return !type.includes("0x19dd42e05fa6c9988a60d30686ee3feb776672b5547e328d6dab16563da65293");
    });

    // SUI→トークン: a2b=false (pool上では CoinA=トークン, CoinB=SUI、SUI→トークンはB→A)
    const txb = TransactionUtil.buildSwapTransaction(this.sdk, {
      pool_id: poolId,
      a2b: false,
      by_amount_in: true,
      amount: String(suiAmountMist),
      amount_limit: minAmountOut,
      coinTypeA: tokenCoin,
      coinTypeB: SUI_COIN,
    }, allCoinAsset);

    // ガス予算を明示的に設定（dry run エラー回避）
    txb.setGasBudget(50_000_000);

    const txBytes = await txb.build({
      client: this.client as any,
      onlyData: true,
    } as any);

    const txResponse = await this.client.signAndExecuteTransaction({
      signer: this.keypair,
      transaction: txBytes,
      options: { showBalanceChanges: true },
    });

    let tokenReceived = "0";
    if (txResponse.balanceChanges) {
      const tokenChange = txResponse.balanceChanges.find(
        (c: any) => c.owner.AddressOwner === this.walletAddress && c.coinType === tokenCoin
      );
      if (tokenChange) {
        tokenReceived = Math.abs(parseInt(tokenChange.amount)).toString();
      }
    }

    console.log(`[Cetus] swapSuiForToken success: Tx=${txResponse.digest}, ${tokenSymbol} received=${tokenReceived}`);
    return { digest: txResponse.digest, tokenReceived };
  }

  /**
   * トークン→SUI スワップ（ガス代補充用）
   * Cetusプールで 指定トークン を SUI にスワップする
   */
  async swapTokenForSui(pool: string, tokenSymbol: string, tokenAmount: bigint): Promise<{ digest: string; suiReceived: string }> {
    if (!this.keypair) throw new Error("[Cetus] Keypair not loaded");

    const SUI_COIN = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
    const TOKEN_COINS: Record<string, string> = {
      DEEP: "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
      USDC: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    };
    const poolId = POOL_CONFIG[pool];
    const tokenCoin = TOKEN_COINS[tokenSymbol];
    if (!poolId || !tokenCoin) throw new Error(`[Cetus] Unknown pool=${pool} or token=${tokenSymbol}`);

    const decimals = tokenSymbol === "USDC" ? 6 : 6;
    console.log(`[Cetus] swapTokenForSui: ${Number(tokenAmount) / (10 ** decimals)} ${tokenSymbol} → SUI (pool=${pool})`);

    const allCoinAssetRaw = await this.sdk.getOwnerCoinAssets(this.walletAddress);
    const allCoinAsset = allCoinAssetRaw.filter((asset: any) => {
      const type = asset.coinType || "";
      return !type.includes("0x19dd42e05fa6c9988a60d30686ee3feb776672b5547e328d6dab16563da65293");
    });

    // トークン→SUI: a2b=true (pool上では CoinA=トークン, CoinB=SUI、トークン→SUIはA→B)
    const txb = TransactionUtil.buildSwapTransaction(this.sdk, {
      pool_id: poolId,
      a2b: true,
      by_amount_in: true,
      amount: String(tokenAmount),
      amount_limit: "0",
      coinTypeA: tokenCoin,
      coinTypeB: SUI_COIN,
    }, allCoinAsset);

    txb.setGasBudget(50_000_000);

    const txBytes = await txb.build({
      client: this.client as any,
      onlyData: true,
    } as any);

    const txResponse = await this.client.signAndExecuteTransaction({
      signer: this.keypair,
      transaction: txBytes,
      options: { showBalanceChanges: true },
    });

    let suiReceived = "0";
    if (txResponse.balanceChanges) {
      const suiChange = txResponse.balanceChanges.find(
        (c: any) => c.owner.AddressOwner === this.walletAddress && c.coinType === SUI_COIN
      );
      if (suiChange) {
        suiReceived = Math.abs(parseInt(suiChange.amount)).toString();
      }
    }

    console.log(`[Cetus] swapTokenForSui success: Tx=${txResponse.digest}, SUI received=${suiReceived}`);
    return { digest: txResponse.digest, suiReceived };
  }
}
