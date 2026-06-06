import { BOT2_CONFIG } from './bot_v2/src/config.js';
import { config } from './bot_v2/src/config.js';

console.log('BOT2_CONFIG.poolObjectId:', BOT2_CONFIG.poolObjectId);
const bot2FullConfig = { ...config, poolObjectId: BOT2_CONFIG.poolObjectId };
console.log('bot2FullConfig.poolObjectId:', bot2FullConfig.poolObjectId);
