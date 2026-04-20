const fs = require('fs');
let s = fs.readFileSync('src/strategy.ts', 'utf8');

// Replace above condition and swap amount
s = s.replace(
  /if \(side === 'above' && usableSui < 0\.1 && usdcBalance > 1\.0\) \{/g, 
  "if (side === 'above' && usdcBalance > 0.5) {"
);
s = s.replace(
  /const swapRes = await this\.lpManager\.swapUsdcToSui\(usdcBalance \* 0\.98\);/g, 
  "const swapRes = await this.lpManager.swapUsdcToSui(usdcBalance - 0.1);"
);

// Replace below condition and swap amount
s = s.replace(
  /else if \(side === 'below' && usdcBalance < 0\.1 && usableSui > 0\.1\) \{/g, 
  "else if (side === 'below' && usableSui > 0.5) {"
);
s = s.replace(
  /const swapRes = await this\.lpManager\.swapSuiToUsdc\(usableSui \* 0\.98\);/g, 
  "const swapRes = await this.lpManager.swapSuiToUsdc(usableSui - 0.1);"
);

fs.writeFileSync('src/strategy.ts', s, 'utf8');
console.log('Fixed swap conditions!');
