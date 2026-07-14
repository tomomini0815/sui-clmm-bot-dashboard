#!/usr/bin/env node
// scripts/fix-state-metadata.mjs
// 既存 state_BOT*.json の gridIndex=0/bandId=0 を修正するデータ修復スクリプト

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");

const stateFiles = ["state_BOT1.json", "state_BOT2.json", "state_BOT3.json", "state_BOT4.json"];

for (const filename of stateFiles) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.log(`スキップ: ${filename} (存在しない)`);
    continue;
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const state = JSON.parse(raw);

  if (!state.positions || Object.keys(state.positions).length === 0) {
    console.log(`スキップ: ${filename} (positionsが空)`);
    continue;
  }

  const positions = Object.values(state.positions);
  const botId = filename.replace("state_", "").replace(".json", "");

  // BOTに応じたmodeを推定
  const modeMap = {
    "BOT1": "grid",
    "BOT2": "grid",
    "BOT3": "gap",
    "BOT4": "gap",
  };
  const defaultMode = modeMap[botId] || "grid";

  // プールごとにグルーピングしてgridIndex/bandIdを振り直す
  const poolGroups = {};
  for (const pos of positions) {
    if (!poolGroups[pos.pool]) poolGroups[pos.pool] = [];
    poolGroups[pos.pool].push(pos);
  }

  let fixed = 0;
  for (const [pool, poolPositions] of Object.entries(poolGroups)) {
    // bandId=-1 (center/fee-earning) のものを除外
    const gridPositions = poolPositions.filter(p => p.bandId !== -1);
    
    // tickLower昇順でソートしてgridIndexを割り当て
    gridPositions.sort((a, b) => a.tickLower - b.tickLower);
    
    gridPositions.forEach((pos, idx) => {
      const needsFix = pos.gridIndex === 0 || pos.bandId === 0;
      if (needsFix) {
        state.positions[pos.positionId].gridIndex = idx + 1;
        state.positions[pos.positionId].bandId = 1;
        // mode修正
        if (defaultMode !== "grid") {
          state.positions[pos.positionId].mode = defaultMode;
        }
        fixed++;
        console.log(`  修正: ${pos.positionId.slice(0, 20)}... [${pool}] gridIndex→${idx+1}, bandId→1, mode→${state.positions[pos.positionId].mode}`);
      }
    });
  }

  if (fixed > 0) {
    // バックアップを作成してから書き込み
    fs.writeFileSync(`${filePath}.bak2`, raw, "utf-8");
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
    console.log(`✅ ${filename}: ${fixed}件のポジションを修正しました`);
  } else {
    console.log(`✅ ${filename}: 修正不要`);
  }
}

console.log("\n修復完了！");
