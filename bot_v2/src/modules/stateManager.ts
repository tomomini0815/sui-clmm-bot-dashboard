import fs from 'fs';
import path from 'path';
import { Logger } from './logger.js';

export interface BotState {
  phase: 'A' | 'B' | 'C' | 'D';
  lpPositionId: string | null;          // 互換性のため残す
  lpPositionIdBelow: string | null;     // 互換性のため残す
  lpPositionIdAbove: string | null;     // 互換性のため残す
  
  // 新規4ポジションID (Bot1/Bot2各4ポジション、合計8ポジション)
  lpPositionIdBelow1: string | null;
  lpPositionIdBelow2: string | null;
  lpPositionIdAbove1: string | null;
  lpPositionIdAbove2: string | null;

  bluefinOrderId: string | null;
  bluefinSide: 'short' | 'long' | 'none';
  basePrice: number;
  rangeLower: number;                   // 互換性のため残す
  rangeUpper: number;                   // 互換性のため残す
  rangeLowerBelow: number;              // 互換性のため残す
  rangeUpperBelow: number;              // 互換性のため残す
  rangeLowerAbove: number;              // 互換性のため残す
  rangeUpperAbove: number;              // 互換性のため残す

  // 新規価格境界
  rangeLowerBelow1: number;
  rangeUpperBelow1: number;
  rangeLowerBelow2: number;
  rangeUpperBelow2: number;
  rangeLowerAbove1: number;
  rangeUpperAbove1: number;
  rangeLowerAbove2: number;
  rangeUpperAbove2: number;

  rangeWidth: number;
  totalCapital: number;
  rebalanceCount24h: number;
  lastRebalanceAt: number;
  rebalanceHistory: number[]; 
  breachStartAt?: number;
  missingPositionsStartAt?: number;
}

export class StateManager {
  private filePath: string;

  constructor(sessionId: string, botName: string) {
    const dir = path.join(process.cwd(), 'state');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.filePath = path.join(dir, `bot_state_${botName}_${sessionId}.json`);
  }

  loadState(): BotState | null {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf8');
        const state = JSON.parse(data);
        Logger.info(`[STATE_MANAGER] 状態を読み込みました: ${this.filePath}`);
        return state;
      }
    } catch (e) {
      Logger.error(`[STATE_MANAGER] 状態の読み込みに失敗しました`, e);
    }
    return null;
  }

  saveState(state: BotState) {
    try {
      const now = Date.now();
      // 72時間（3日分）の履歴を維持する
      state.rebalanceHistory = (state.rebalanceHistory || []).filter(
        t => now - t < 3 * 24 * 60 * 60 * 1000
      );
      // 24時間以内の回数をカウント
      state.rebalanceCount24h = state.rebalanceHistory.filter(
        t => now - t < 24 * 60 * 60 * 1000
      ).length;

      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf8');
      Logger.info(`[STATE_MANAGER] 状態を保存しました: フェーズ=${state.phase}`);
    } catch (e) {
      Logger.error(`[STATE_MANAGER] 状態の保存に失敗しました`, e);
    }
  }

  deleteState() {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
    } catch (e) {}
  }
}
