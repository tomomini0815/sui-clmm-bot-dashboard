import { SuiClient } from '@mysten/sui/client';

async function checkPool() {
  const client = new SuiClient({ url: 'https://fullnode.mainnet.sui.io' });
  const poolId = '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105';
  
  try {
    const response = await client.getObject({
      id: poolId,
      options: { showContent: true }
    });
    console.log(JSON.stringify(response, null, 2));
  } catch (e) {
    console.error(e);
  }
}

checkPool();
