import { SuiClient } from '@mysten/sui/client';
import { initCetusSDK, TickMath } from '@cetusprotocol/cetus-sui-clmm-sdk';
import BN from 'bn.js';

async function inspectPool() {
    const rpcUrl = 'https://fullnode.mainnet.sui.io'; // Assume mainnet for now
    const client = new SuiClient({ url: rpcUrl });
    const poolId = '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105';
    
    console.log('Inspecting Pool:', poolId);
    
    try {
        const pool = await client.getObject({
            id: poolId,
            options: { showContent: true }
        });
        
        console.log('Pool Object Content:', JSON.stringify(pool, null, 2));
        
        if (pool.data?.content && 'fields' in pool.data.content) {
            const fields = pool.data.content.fields as any;
            const sqrtPrice = fields.current_sqrt_price;
            console.log('Current Sqrt Price:', sqrtPrice);
            
            // USDC-SUI Mainnet
            const decimalsA = 6; 
            const decimalsB = 9;
            
            const sqrtPriceBN = new BN(sqrtPrice);
            const price = TickMath.sqrtPriceX64ToPrice(sqrtPriceBN, decimalsA, decimalsB);
            console.log('Calculated Price (B in A):', price.toString());
            
            const priceInv = TickMath.sqrtPriceX64ToPrice(sqrtPriceBN, decimalsB, decimalsA);
            console.log('Calculated Price (A in B):', priceInv.toString());
        }
    } catch (e) {
        console.error('Error:', e);
    }
}

inspectPool();
