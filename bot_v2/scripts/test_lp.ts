import { initCetusSDK, TickMath, ClmmPoolUtil } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient } from '@mysten/sui/client';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import dotenv from 'dotenv';

dotenv.config();

const POOL_ID = '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105';
const RPC = 'https://fullnode.mainnet.sui.io';

async function test() {
  const { secretKey } = decodeSuiPrivateKey(process.env.PRIVATE_KEY!);
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  const walletAddress = keypair.getPublicKey().toSuiAddress();
  
  console.log('Wallet:', walletAddress);
  
  const suiClient = new SuiClient({ url: RPC });
  const sdk = initCetusSDK({ network: 'mainnet', fullNodeUrl: RPC });
  sdk.senderAddress = walletAddress;

  const pool = await sdk.Pool.getPool(POOL_ID);
  console.log('Pool tick:', pool.current_tick_index);
  console.log('Pool tickSpacing:', pool.tickSpacing);
  console.log('CoinA:', pool.coinTypeA);
  console.log('CoinB:', pool.coinTypeB);
  
  const tickSpacing = parseInt(pool.tickSpacing.toString());
  
  // 現在価格から ±5% レンジを計算
  const currentTickRaw = pool.current_tick_index;
  const currentTick = typeof currentTickRaw === 'number' ? currentTickRaw : parseInt(currentTickRaw.toString());
  
  const lower = currentTick - 500;
  const lowerTick = Math.floor(lower / tickSpacing) * tickSpacing;
  const upper = currentTick + 500;
  const upperTick = Math.ceil(upper / tickSpacing) * tickSpacing;
  
  console.log(`Tick range: [${lowerTick}, ${upperTick}]`);
  
  // 現在の価格と対応するSQRT価格
  const curSqrtPrice = new BN(pool.current_sqrt_price.toString());
  const lowerSqrtPrice = TickMath.tickIndexToSqrtPriceX64(lowerTick);
  const upperSqrtPrice = TickMath.tickIndexToSqrtPriceX64(upperTick);
  
  // 0.2 SUI から最大の流動性を計算
  const SUI_AMOUNT = 200_000_000n; // 0.2 SUI in MIST
  const liq = ClmmPoolUtil.estimateLiquidityForCoinB(
    curSqrtPrice,
    lowerSqrtPrice,
    { coinAmount: SUI_AMOUNT, isAdjustCoinA: false}
  );
  console.log('Estimated liquidity:', liq.toString());
  
  // 必要なコインA(USDC)量を計算
  const coinsNeeded = ClmmPoolUtil.getCoinAmountFromLiquidity(liq, curSqrtPrice, lowerSqrtPrice, upperSqrtPrice, true);  
  console.log('USDC needed:', Number(coinsNeeded.coinA) / 1e6, 'USDC');
  console.log('SUI needed:', Number(coinsNeeded.coinB) / 1e9, 'SUI');
  
  // ウォレット残高チェック
  const coins = await suiClient.getAllCoins({ owner: walletAddress });
  for (const c of coins.data) {
    console.log(`Balance: ${c.coinType.split('::').pop()} = ${c.balance}`);
  }
}

test().catch(console.error);
