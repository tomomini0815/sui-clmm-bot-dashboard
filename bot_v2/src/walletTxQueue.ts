/**
 * WalletTxQueue — ウォレット単位のトランザクション直列化キュー
 *
 * 同一ウォレットから複数のBotが同時にトランザクションを発行すると
 * Suiのオブジェクトロック競合が発生する。このキューを全Bot間で共有することで
 * 「前のTXが完了してから次のTXを開始する」ことを保証する。
 */

import { Logger } from './logger.js';

export class WalletTxQueue {
  private queue: Promise<any> = Promise.resolve();
  private pendingCount = 0;

  /**
   * トランザクションをキューに追加し、順番に実行する。
   * @param fn  実行するトランザクション関数（async）
   * @param label  ログ表示用のラベル
   */
  async execute<T>(fn: () => Promise<T>, label = 'TX'): Promise<T> {
    this.pendingCount++;
    Logger.info(`[TxQueue] ${label} を待機中... (キュー: ${this.pendingCount}件)`);

    const result = this.queue.then(async () => {
      Logger.info(`[TxQueue] ${label} 開始`);
      const start = Date.now();
      try {
        const res = await fn();
        const elapsed = Date.now() - start;
        Logger.info(`[TxQueue] ${label} 完了 (${elapsed}ms)`);
        return res;
      } catch (err) {
        Logger.error(`[TxQueue] ${label} エラー`, err);
        throw err;
      } finally {
        this.pendingCount--;
      }
    });

    // キューは継続（エラーでも次のTXをブロックしない）
    this.queue = result.catch(() => {});
    return result;
  }

  getPendingCount(): number {
    return this.pendingCount;
  }
}

/**
 * アプリケーション全体で共有するシングルトンキュー。
 * Bot1・Bot2は必ずこのキューを介してTXを発行すること。
 */
export const globalTxQueue = new WalletTxQueue();
