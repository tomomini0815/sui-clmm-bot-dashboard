import { PriceMonitor } from './bot_v2/src/priceMonitor.js';
import { BOT2_CONFIG } from './bot_v2/src/config.js';
import { config as globalConfig } from './bot_v2/src/config.js';

async function run() {
  const bot2FullConfig = { ...globalConfig, poolObjectId: BOT2_CONFIG.poolObjectId };
  const bot2PriceMonitor = new PriceMonitor(bot2FullConfig);
  console.log("Monitor Pool ID:", bot2PriceMonitor.getPoolId());
}
run();
