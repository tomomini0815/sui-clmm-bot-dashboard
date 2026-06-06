import { TickMath } from '@mysten/sui/utils'; // Wait, cetus sdk uses different TickMath
import { initCetusSDK } from './bot_v2/src/cetus.js';
import Decimal from 'decimal.js';

async function run() {
  const sdk = initCetusSDK({ network: 'mainnet', fullNodeUrl: 'https://fullnode.mainnet.sui.io:443' });
  const lowerTick = sdk.math.TickMath.priceToInitializableTickIndex(new Decimal("0.0291"), 6, 9, 20);
  const upperTick = sdk.math.TickMath.priceToInitializableTickIndex(new Decimal("0.0374"), 6, 9, 20);
  console.log({lowerTick, upperTick});
}
run();
