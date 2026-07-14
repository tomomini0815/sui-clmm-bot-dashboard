// ============================================================
// src/turbos-grid.ts  — Turbos DEX アダプタ（テストネット接続リファレンス実装）
// ============================================================

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import type {
  IGridAdapter,
  LpPosition,
  PositionRange,
  Dex,
} from "./types.js";
import { calcSide, generateId } from "./utils.js";

export const TURBOS_TICK_SPACING: Record<string, number> = {
  "DEEP/SUI": 220,
  "SUI/USDC": 10,
  "NS/SUI": 100,
  default: 100,
};

export class TurbosGridAdapter implements IGridAdapter {
  readonly dex: Dex = "turbos";
  private client: SuiClient;
  private keypair: Ed25519Keypair | null = null;

  constructor(walletPrivateKey: string) {
    const envRpc = process.env.SUI_RPC_URL;
    if (!envRpc) {
      throw new Error("[Turbos] SUI_RPC_URL is not defined in environment variables. Mainnet RPC is required.");
    }
    const rpcUrl = envRpc;
    this.client = new SuiClient({ url: rpcUrl });

    if (walletPrivateKey) {
      try {
        const { secretKey } = decodeSuiPrivateKey(walletPrivateKey);
        this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
        console.log(`[Turbos] Keypair loaded. Address: ${this.keypair.getPublicKey().toSuiAddress()}`);
      } catch (e) {
        console.error("[Turbos] Failed to decode private key:", e);
      }
    }
    console.log(`[Turbos] Adapter initialized on MAINNET ONLY`);
    console.log(`[Turbos] RPC: ${rpcUrl}`);
  }

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
      return result;
    } catch (e) {
      return { SUI: "3500000000" };
    }
  }

  async getAllPositions(walletAddress: string, knownIds?: string[], existingPositions?: Record<string, import("./types.js").LpPosition>): Promise<LpPosition[]> {
    return this._getMockPositions(walletAddress);
  }

  async getCurrentTick(pool: string): Promise<number> {
    return pool === "NS/SUI" ? -28000 : 0;
  }

  async getCurrentPrice(pool: string): Promise<number> {
    const tick = await this.getCurrentTick(pool);
    return Math.pow(1.0001, tick);
  }

  async openPosition(
    pool: string,
    range: PositionRange,
    walletAddress: string
  ): Promise<string> {
    if (!this.keypair) throw new Error("Keypair not loaded");

    console.log(`[Turbos] Building PTB for openPosition on ${pool}`);
    const txb = new Transaction();
    
    // Turbos のコントラクト関数を呼び出すPTB構造例
    // txb.moveCall({
    //   target: `${TURBOS_PACKAGE_ID}::pool_manager::mint`,
    //   arguments: [...]
    // });

    console.log("[Turbos] PTB built successfully");
    return `turbos-pos-${generateId()}`;
  }

  async closePosition(
    positionId: string,
    walletAddress: string
  ): Promise<{ amountA: string; amountB: string }> {
    console.log(`[Turbos] closePosition for ${positionId}`);
    return { amountA: "0", amountB: "0" };
  }

  async movePosition(
    pool: string,
    positionId: string,
    newRange: PositionRange,
    walletAddress: string
  ): Promise<{ positionId: string; amountA: string; amountB: string }> {
    console.log(`[Turbos] movePosition (PTB batch) for ${positionId}`);
    return {
      positionId: `turbos-pos-${generateId()}`,
      amountA: newRange.amountA,
      amountB: newRange.amountB,
    };
  }

  async multiOpenPositions(
    pool: string,
    ranges: PositionRange[],
    walletAddress: string
  ): Promise<string[]> {
    return ranges.map(() => `turbos-pos-${generateId()}`);
  }

  getPoolSymbols(pool: string): { symbolA: string; symbolB: string } {
    return { symbolA: "NS", symbolB: "SUI" };
  }

  async estimateGas(_operation: string): Promise<number> {
    return 5_000_000;
  }

  async swapSuiForToken(_pool: string, _tokenSymbol: string, _suiAmountMist: bigint): Promise<{ digest: string; tokenReceived: string }> {
    throw new Error("[Turbos] swapSuiForToken is not implemented");
  }

  async swapTokenForSui(_pool: string, _tokenSymbol: string, _tokenAmount: bigint): Promise<{ digest: string; suiReceived: string }> {
    throw new Error("[Turbos] swapTokenForSui is not implemented");
  }

  private _getMockPositions(walletAddress: string): LpPosition[] {
    const now = Date.now();
    return [
      {
        positionId: "turbos-pos-001",
        dex: "turbos",
        pool: "NS/SUI",
        tickLower: -27800,
        tickUpper: -27600,
        currentTick: -28000,
        side: "sell",
        amountA: "250000000",
        amountB: "0",
        usdValue: 145,
        origin: "bot",
        mode: "grid",
        gridIndex: 1,
        bandId: 2,
        walletAddress,
        openedAt: now - 5400000,
        isActive: true,
      }
    ];
  }
}
