import { SuiClient } from '@mysten/sui/client';

async function checkTotalBalance() {
  const client = new SuiClient({ url: 'https://fullnode.mainnet.sui.io' });
  const address = '0xc17e3ef45cfb8ff6f0d5e55669b148fc27e615e2bde27109ccf3e952d1215559';
  const usdcType = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
  
  try {
    let totalBalance = BigInt(0);
    let hasNextPage = true;
    let cursor = null;
    
    while (hasNextPage) {
      const response = await client.getCoins({
        owner: address,
        coinType: usdcType,
        cursor: cursor
      });
      
      for (const coin of response.data) {
        totalBalance += BigInt(coin.balance);
      }
      
      hasNextPage = response.hasNextPage;
      cursor = response.nextCursor;
    }
    
    console.log(`Total USDC Balance: ${totalBalance.toString()} (Raw)`);
    console.log(`Total USDC Balance: ${(Number(totalBalance) / 1000000).toFixed(6)} USDC`);
    
    const suiBalance = await client.getBalance({ owner: address });
    console.log(`Total SUI Balance: ${(Number(suiBalance.totalBalance) / 1000000000).toFixed(9)} SUI`);
    
  } catch (e) {
    console.error(e);
  }
}

checkTotalBalance();
