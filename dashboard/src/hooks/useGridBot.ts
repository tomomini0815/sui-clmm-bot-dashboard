// ============================================================
// dashboard/src/hooks/useGridBot.ts  — WebSocket + API フック
// ============================================================

import { useState, useEffect, useRef, useCallback } from "react";
import type {
  GridState,
  PerformanceSummary,
  WalletInfo,
  BotProcess,
  LogEntry,
  ImportantEvent,
  AutoConfig,
} from "../types";

const API_BASE = "/api";
// 開発環境(Vite dev server, port 5173)では直接バックエンドポートに接続
// 本番環境ではExpressが同じポートでWSを提供するので window.location.host を使用
const isDev = window.location.port === "5173";
const WS_URL = isDev
  ? "ws://localhost:3001"
  : `ws://${window.location.host}`;

// ── モックデータ ──
function createMockState(): GridState {
  return {
    positions: {},
    pendingOpens: [],
    realized: {},
    feesEarned: {},
    swapFeesPaid: {},
    lastCycleAt: 0,
    gasUsedSinceStart: 0,
    gasUsedCumulative: 0,
    restartCount: 0,
    dailyOpenCount: 0,
    autoConfig: {
      autoInterval: true, autoRangeWidth: true, autoGridBand: true,
      autoReinit: true, autoReinitMinPositions: 1,
      autoRebalanceInventory: true, rebalanceThresholdPct: 70,
      rebalanceCooldownSec: 300, autoFundTransfer: false,
      fundTransferDailyLimit: 10000000000, fundTransferDailyMax: 5,
      autoPromoteDemoteGap: true, minPollSec: 3, maxPollSec: 60,
      maxOpensPerCycle: 5, maxOpensPerDay: 50,
      currentPollSec: 10, currentRangeWidthPct: 0.5, currentGridBands: 0,
    },
    initParams: {
      gridWidthPct: 2, gridLevelsUp: 3, gridLevelsDown: 3,
      gridCapitalA: "0", gridCapitalB: "0",
      allocMode: "equal",
    },
    currentPrices: { "DEEP/SUI": 0 },
    importantEvents: [],
  };
}

function createMockPerformance(): PerformanceSummary {
  return {
    totalNetProfitUsd: 0,
    byToken: {},
    today: {},
    cumulativeState: {},
    roundTripsCompleted: 0,
    gasUsedSinceStart: 0,
    gasUsedCumulative: 0,
    restartCountSinceStart: 0,
    restartCountCumulative: 0,
  };
}


// ── フック本体 ────────────────────────────────────────────

export function useGridBot() {
  const [state, setState] = useState<GridState>(createMockState());
  const [performance, setPerformance] = useState<PerformanceSummary>(createMockPerformance());
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [bots, setBots] = useState<BotProcess[]>([
    { botId: "BOT1", label: "Grid・Cetus", dex: "cetus", mode: "grid", status: "stopped", pid: undefined },
    { botId: "BOT2", label: "Grid・Cetus", dex: "cetus", mode: "grid", status: "stopped", pid: undefined },
    { botId: "BOT3", label: "空白・Cetus", dex: "cetus", mode: "gap", status: "stopped", pid: undefined },
    { botId: "BOT4", label: "空白・Turbos", dex: "turbos", mode: "gap", status: "stopped", pid: undefined },
  ]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // ウォレット残高の取得フック
  const fetchWallets = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/wallets`);
      if (res.ok) {
        const walletsData = await res.json();
        setWallets(walletsData);
      }
    } catch {}
  }, []);

  // WebSocket接続
  useEffect(() => {
    const tryConnect = () => {
      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => setConnected(true);
        ws.onclose = () => {
          setConnected(false);
          setTimeout(tryConnect, 3000);
        };
        ws.onerror = () => ws.close();

        ws.onmessage = (event) => {
          try {
            const { type, payload } = JSON.parse(event.data);
            if (type === "state:full" || type === "state:update") {
              setState((prev) => ({ ...prev, ...payload }));
              fetchWallets(); // ボットの状態更新（約定等）に合わせて残高を即座に再取得
            } else if (type === "performance:update") {
              setPerformance(payload);
            } else if (type === "log:entry") {
              setLogs((prev) => [payload, ...prev.slice(0, 499)]);
            } else if (type === "config:update") {
              setState((prev) => ({ ...prev, autoConfig: payload }));
            }
          } catch {}
        };
      } catch {
        setTimeout(tryConnect, 3000);
      }
    };

    tryConnect();
    return () => wsRef.current?.close();
  }, [fetchWallets]);

  // マウント時に初期データをREST APIからロード
  useEffect(() => {
    const loadInitialData = async () => {
      try {
        const [stateRes, perfRes, walletsRes, logsRes] = await Promise.all([
          fetch(`${API_BASE}/state`),
          fetch(`${API_BASE}/performance`),
          fetch(`${API_BASE}/wallets`),
          fetch(`${API_BASE}/logs?limit=100`)
        ]);

        if (stateRes.ok) {
          const stateData = await stateRes.json();
          setState((prev) => ({ ...prev, ...stateData }));
        }
        if (perfRes.ok) {
          const perfData = await perfRes.json();
          setPerformance(perfData);
        }
        if (walletsRes.ok) {
          const walletsData = await walletsRes.json();
          setWallets(walletsData);
        }
        if (logsRes.ok) {
          const logsData = await logsRes.json();
          setLogs(logsData);
        }
      } catch (e) {
        console.error("Failed to load initial data:", e);
      }
    };

    loadInitialData();

    // 60秒おきにウォレット残高をバックグラウンドポーリング（WS連動でカバーされているため低頻度化）
    const interval = setInterval(fetchWallets, 60000);

    return () => clearInterval(interval);
  }, [fetchWallets]);

  const fetchBots = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/bots`);
      if (res.ok) {
        const data = await res.json();
        setBots(data);
      }
    } catch {}
  }, []);

  // ボットステータスの定期ポーリング (60秒ごとに低頻度化。起動・停止ボタン押下時は即時再取得される)
  useEffect(() => {
    fetchBots();
    const interval = setInterval(fetchBots, 60000);
    return () => clearInterval(interval);
  }, [fetchBots]);

  const updateConfig = useCallback(async (config: Partial<AutoConfig>) => {
    setState((prev) => ({
      ...prev,
      autoConfig: { ...prev.autoConfig, ...config },
    }));
    try {
      await fetch(`${API_BASE}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
    } catch {}
  }, []);

  const startBot = useCallback(async (botId: string) => {
    setActionStatus(`${botId} の起動要求を送信しました...`);
    setBots((prev) =>
      prev.map((b) => (b.botId === botId ? { ...b, status: "running" as const } : b))
    );
    try {
      const res = await fetch(`${API_BASE}/bots/${botId}/start`, { method: "POST" });
      if (res.ok) {
        setActionStatus(`${botId} が起動しました (テストネット接続)`);
        await fetchBots();
      } else {
        setActionStatus(`${botId} の起動に失敗しました`);
      }
    } catch {
      setActionStatus(`${botId} の起動時に通信エラーが発生しました`);
    }
    setTimeout(() => setActionStatus(null), 4000);
  }, [fetchBots]);

  const stopBot = useCallback(async (botId: string) => {
    setActionStatus(`${botId} の停止要求を送信しました...`);
    setBots((prev) =>
      prev.map((b) => (b.botId === botId ? { ...b, status: "stopped" as const } : b))
    );
    try {
      const res = await fetch(`${API_BASE}/bots/${botId}/stop`, { method: "POST" });
      if (res.ok) {
        setActionStatus(`${botId} を停止しました`);
        await fetchBots();
      } else {
        setActionStatus(`${botId} の停止に失敗しました`);
      }
    } catch {
      setActionStatus(`${botId} の停止時に通信エラーが発生しました`);
    }
    setTimeout(() => setActionStatus(null), 4000);
  }, [fetchBots]);

  const resetPerformance = useCallback(async () => {
    setPerformance({
      totalNetProfitUsd: 0, byToken: {}, today: {}, cumulativeState: {},
      roundTripsCompleted: 0, gasUsedSinceStart: 0, gasUsedCumulative: performance.gasUsedCumulative,
      restartCountSinceStart: 0, restartCountCumulative: performance.restartCountCumulative,
    });
    try {
      await fetch(`${API_BASE}/performance/reset`, { method: "POST" });
    } catch {}
  }, [performance]);

  const clearEvents = useCallback(async () => {
    setState((prev) => ({ ...prev, importantEvents: [] }));
    try {
      await fetch(`${API_BASE}/events/clear`, { method: "POST" });
    } catch {}
  }, []);

  return {
    state, performance, wallets, bots, logs, connected, actionStatus,
    updateConfig, startBot, stopBot, resetPerformance, clearEvents,
  };
}
