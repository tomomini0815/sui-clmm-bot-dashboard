import { initCetusSDK } from './bot_v2/src/cetus.js';

async function run() {
  const sdk = initCetusSDK({ network: 'mainnet', fullNodeUrl: 'https://fullnode.mainnet.sui.io:443' });
  const positions = await sdk.Position.getPositionList('0xc17e3ef45cfb8ff6f0d5e55669b148fc27e615e2bde27109ccf3e952d1215559', []);
  console.log(JSON.stringify(positions, null, 2));
}
run();
