import { SuiClient } from '@mysten/sui/client';

async function checkBalance() {
  const client = new SuiClient({ url: 'https://fullnode.mainnet.sui.io' });
  const address = '0xc17e3ef45cfb8ff6f0d5e55669b148fc27e615e2bde27109ccf3e952d1215559';
  
  try {
    const coins = await client.getAllCoins({ owner: address });
    console.log(JSON.stringify(coins, null, 2));
  } catch (e) {
    console.error(e);
  }
}

checkBalance();
