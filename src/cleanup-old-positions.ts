import dotenv from "dotenv";
dotenv.config();

import { CetusGridAdapter } from "./cetus-grid.js";

// すべてのポジションをクローズ対象にする
const KEEP_POSITIONS = new Set<string>([]);

const WALLET_ADDRESS = "0xc17e3ef45cfb8ff6f0d5e55669b148fc27e615e2bde27109ccf3e952d1215559";

async function main() {
  const privateKey = process.env.GRID_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    console.error("GRID_WALLET_PRIVATE_KEY is not defined in env");
    return;
  }

  const adapter = new CetusGridAdapter(privateKey);
  console.log("=== Cetus LP Cleanup Script ===");
  console.log("Wallet Address:", WALLET_ADDRESS);

  // 全ポジションをオンチェーンから取得
  const allPos = await adapter.getAllPositions(WALLET_ADDRESS);
  console.log(`Total found positions: ${allPos.length}`);

  const toClose = allPos.filter(p => !KEEP_POSITIONS.has(p.positionId));
  console.log(`Positions to close: ${toClose.length}`);

  for (const pos of toClose) {
    console.log(`\nClosing old duplicate position: ${pos.positionId} [${pos.tickLower} - ${pos.tickUpper}] side=${pos.side}`);
    try {
      const res = await adapter.closePosition(pos.positionId, WALLET_ADDRESS);
      console.log(`Closed successfully! Reclaimed: A=${res.amountA}, B=${res.amountB}`);
      // レート制限回避のために少しウェイトを入れる
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`Failed to close position ${pos.positionId}:`, e);
    }
  }

  console.log("\n=== Cleanup finished! ===");
}

main().catch(console.error);
