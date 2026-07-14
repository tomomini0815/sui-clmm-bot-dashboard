import dotenv from "dotenv";
dotenv.config();

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { initCetusSDK, clmmMainnet, TransactionUtil } from "@cetusprotocol/cetus-sui-clmm-sdk";

const SUI_COIN = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const DEEP_COIN = "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP";
const DEEP_SUI_POOL = "0xe01243f37f712ef87e556afb9b1d03d0fae13f96d324ec912daffc339dfdcbd2";

async function main() {
  const privateKey = process.env.GRID_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    console.error("GRID_WALLET_PRIVATE_KEY is not defined in env");
    return;
  }

  // キーペアのロード
  const { secretKey } = decodeSuiPrivateKey(privateKey);
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  const walletAddress = keypair.toSuiAddress();

  const rpcUrl = "https://fullnode.mainnet.sui.io:443";
  const client = new SuiClient({ url: rpcUrl });

  // Cetus SDK の初期化
  const sdk = initCetusSDK({
    ...clmmMainnet,
    network: "mainnet",
    fullNodeUrl: rpcUrl,
  });
  sdk.senderAddress = walletAddress;

  console.log("=== Cetus DEEP to SUI Swap (Rebalancing) ===");
  console.log("Wallet Address:", walletAddress);

  // 125 DEEP をスワップ (125,000,000 MIST)
  const swapAmount = 125000000;
  console.log(`Swapping ${swapAmount / 1e6} DEEP to SUI...`);

  try {
    // 手動で見積もる (125 DEEP ≒ 4.9 SUI。最低保証額を 3.0 SUI = 3,000,000,000 MIST に下げて安全に実行)
    const minAmountOut = "3000000000"; 
    console.log(`Using manual Amount Limit: ${Number(minAmountOut) / 1e9} SUI`);

    // 全アセットを取得し、古いDEEPオブジェクトを完全に排除
    const allCoinAssetRaw = await sdk.getOwnerCoinAssets(walletAddress);
    const allCoinAsset = allCoinAssetRaw.filter(asset => {
      const type = (asset as any).coinType || "";
      return !type.includes("0x19dd42e05fa6c9988a60d30686ee3feb776672b5547e328d6dab16563da65293");
    });

    // 下層 of TransactionUtil で直接スワップトランザクションを構築
    const txb = TransactionUtil.buildSwapTransaction(sdk, {
      pool_id: DEEP_SUI_POOL,
      a2b: true, // DEEP (CoinA) から SUI (CoinB) へのスワップなので a2b = true
      by_amount_in: true,
      amount: String(swapAmount),
      amount_limit: minAmountOut,
      coinTypeA: DEEP_COIN,
      coinTypeB: SUI_COIN,
    }, allCoinAsset);

    // オンチェーン解決（MVR）をバイパスして、ローカルで直接BCSビルドを実行
    const txBytes = await txb.build({
      client: client as any,
      onlyData: true,
    } as any);

    const txResponse = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: txBytes,
    });

    console.log(`Swap successful! Tx: ${txResponse.digest}`);
  } catch (e) {
    console.error("Swap failed:", e);
  }
}

main().catch(console.error);
