import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

async function checkObject() {
  const client = new SuiClient({ url: 'https://fullnode.mainnet.sui.io' });
  const objectId = '0xeb03740cb918bff0001322f586f7ffd62445db113d99abfce7d09cde84366ddf';
  
  try {
    const response = await client.getObject({
      id: objectId,
      options: { showType: true, showOwner: true, showContent: true }
    });
    console.log(JSON.stringify(response, null, 2));
  } catch (e) {
    console.error(e);
  }
}

checkObject();
