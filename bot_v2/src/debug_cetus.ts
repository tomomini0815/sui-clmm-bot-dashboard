import { LpManager } from './modules/lpManager.js';
import { PriceMonitor } from './modules/priceMonitor.js';
import { GasTracker } from './gasTracker.js';
import { config as globalConfig } from './config.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const rpcUrl = process.env.RPC_URL || globalConfig.rpcUrl;
  const privateKey = process.env.PRIVATE_KEY || globalConfig.privateKey;
  
  const { secretKey } = privateKey.startsWith('suiprivkey')
    ? decodeSuiPrivateKey(privateKey)
    : { secretKey: Buffer.from(privateKey.replace('0x', ''), 'hex') };
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  const address = keypair.getPublicKey().toSuiAddress();
  
  const priceMonitor = new PriceMonitor(globalConfig);
  const gasTracker = new GasTracker();
  const lpManager = new LpManager(priceMonitor, gasTracker, globalConfig);
  lpManager.setKeypair(keypair);
  
  await (lpManager as any).initializePoolData();
  
  const sdk = (lpManager as any).getSdkWithSender();
  const poolId = priceMonitor.getPoolId();
  
  // セッション状態からアクティブポジションIDを読み込む
  const stateFile = './session_state_master-0xc17e3e.json';
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const activeIds = [
    state.strategy.bot1State.lpPositionIdBelow1,
    state.strategy.bot1State.lpPositionIdBelow2,
    state.strategy.bot1State.lpPositionIdAbove1,
    state.strategy.bot1State.lpPositionIdAbove2,
    state.strategy.bot2State.lpPositionIdBelow1,
    state.strategy.bot2State.lpPositionIdBelow2,
    state.strategy.bot2State.lpPositionIdAbove1,
    state.strategy.bot2State.lpPositionIdAbove2,
  ].filter(Boolean);

  console.log("Target active position IDs:", activeIds);

  console.log(`Fetching Cetus positions for pool: ${poolId}`);
  const positions = await sdk.Position.getPositionList(address, [poolId]);
  
  const matches = positions.filter(p => activeIds.includes(p.pos_object_id));
  console.log("=== Matches found in Cetus position list ===");
  console.log(JSON.stringify(matches, null, 2));

  // 各ポジションの詳細を取得してみる
  console.log("=== Testing getPositionDetails ===");
  for (const id of activeIds) {
    const details = await lpManager.getPositionDetails(id);
    console.log(`Details for ${id}:`, details);
  }
}

main().catch(console.error);
