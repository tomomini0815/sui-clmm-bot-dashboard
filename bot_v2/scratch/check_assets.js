import { SuiClient } from '@mysten/sui/client';

async function checkPool() {
    // Check both testnet and mainnet pools to see what we are dealing with
    const networks = [
        { name: 'mainnet', url: 'https://fullnode.mainnet.sui.io', id: '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105' },
        { name: 'testnet', url: 'https://fullnode.testnet.sui.io', id: '0xf4f9663f288049ede73a9f19e3a655c74be8a9a84dd3e2c7f04c190c5c9f1fba' }
    ];

    for (const net of networks) {
        console.log(`\n--- Checking ${net.name} ---`);
        const client = new SuiClient({ url: net.url });
        try {
            const pool = await client.getObject({ id: net.id, options: { showContent: true } });
            if (pool.data && pool.data.content) {
                const content = pool.data.content;
                console.log(`Pool ID: ${net.id}`);
                console.log(`Coin A: ${content.fields.coin_a || content.fields.coinTypeA}`);
                console.log(`Coin B: ${content.fields.coin_b || content.fields.coinTypeB}`);
            }
        } catch (e) {
            console.log(`${net.name} check failed or pool not found: ${e.message}`);
        }
    }
}

checkPool();
