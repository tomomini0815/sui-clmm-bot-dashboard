const fs = require('fs');

let lines = fs.readFileSync('src/strategy.ts', 'utf8').split(/\r?\n/);
let startIdx = lines.findIndex(l => l.includes('await this.lpManager.swapSuiToUsdc(suiToSell)'));
let endIdx = lines.findIndex(l => l.includes('private async executeRangeOrderStrategy(currentPrice: number) {'));

console.log('startIdx', startIdx, 'endIdx', endIdx);

if(startIdx > -1 && endIdx > -1) {
  let insertions = [
    "        await this.tracker.recordEvent('資産調整', `${suiToSell.toFixed(2)} SUIを売却: ${sellRes}`);",
    "      }",
    "    } else if (currentSuiValue < targetSuiValue - 0.1) {",
    "      const usdcToSell = targetSuiValue - currentSuiValue;",
    "      if (usdcToSell > 0.1) {",
    "        const buyRes = await this.lpManager.swapUsdcToSui(usdcToSell);",
    "        await this.tracker.recordEvent('資産調整', `${usdcToSell.toFixed(2)} USDCでSUIを購入: ${buyRes}`);",
    "      }",
    "    }",
    "    ",
    "    // STEP 4: LP提供",
    "    const lpRes = await this.lpManager.addLiquidity(targetSuiValue, lpUsdcAmount);",
    "    await this.tracker.recordEvent('LP提供', `LP追加完了: ${lpRes.digest}`);",
    "",
    "    // STEP 5: ヘッジポジション構築",
    "    const hedgeRes = await this.hedgeManager.openHedge(marginAmount, targetSuiValue);",
    "    await this.tracker.recordEvent('ヘッジ', `ヘッジポジション構築: ${hedgeRes}`);",
    "",
    "    this.notify(`✅ バランス型戦略サイクル完了`);",
    "  }",
    "",
    "  /**",
    "   * [戦略B] 指値レンジ戦略 (Range Order)",
    "   */"
  ];
  
  lines.splice(startIdx + 1, endIdx - startIdx - 1, ...insertions);
  fs.writeFileSync('src/strategy.ts', lines.join('\n'), 'utf8');
  console.log('Fixed using array splice!');
} else {
  console.log('Indices not found!');
}
