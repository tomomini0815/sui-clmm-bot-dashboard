import "dotenv/config";
import { CetusGridAdapter } from "./src/cetus-grid.js";

async function main() {
  const key = process.env.GRID_WALLET_PRIVATE_KEY ?? "";
  const adapter = new CetusGridAdapter(key);
  
  console.log("Fetching Cetus positions...");
  const positions = await adapter.getAllPositions(adapter.walletAddress);
  const targetPositions = positions.filter(p => p.pool === "SUI/USDC" || p.pool === "DEEP/SUI");
  
  console.log(`Found ${targetPositions.length} positions to close.`);
  
  for (const pos of targetPositions) {
    try {
      console.log(`Closing position ${pos.positionId} for pool ${pos.pool}...`);
      const res = await adapter.closePosition(pos.positionId, adapter.walletAddress);
      console.log(`Successfully closed ${pos.positionId}. Recovered:`, res);
    } catch (e) {
      console.error(`Failed to close ${pos.positionId}:`, e);
    }
  }
  
  console.log("All done.");
}

main().catch(console.error);
