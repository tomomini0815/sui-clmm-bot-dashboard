// ============================================================
// server/index.ts  — Express + WebSocket ダッシュボードAPI
// ============================================================

import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { GridState, LogEntry, ImportantEvent, Dex, Mode } from "../src/types.js";
import { loadState, saveState, calcPerformanceSummary, loadMergedState, updateConfigAll, updateInitParamsAll, resetPerformanceAll, clearEventsAll } from "../src/state.js";
import { generateId } from "../src/utils.js";
import { spawn, ChildProcess } from "child_process";

// ── プロセス管理用のマップ ───────────────────────────────
const activeProcesses = new Map<string, ChildProcess>();
const botStatus = new Map<string, { pid?: number; status: "running" | "stopped" | "error" }>();
// デフォルト状態の設定
botStatus.set("BOT1", { status: "stopped" });
botStatus.set("BOT2", { status: "stopped" });
botStatus.set("BOT3", { status: "stopped" });
botStatus.set("BOT4", { status: "stopped" });


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_API_PORT ?? 3001);

// ── Express & WebSocket セットアップ ─────────────────────

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

// ── WebSocket接続管理 ─────────────────────────────────────

const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (total: ${clients.size})`);

  // 接続直後に現在のstateを送信
  const state = loadMergedState();
  ws.send(JSON.stringify({ type: "state:full", payload: state }));
  ws.send(
    JSON.stringify({
      type: "performance:update",
      payload: calcPerformanceSummary(state),
    })
  );

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (total: ${clients.size})`);
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err);
    clients.delete(ws);
  });
});

function broadcast(type: string, payload: unknown): void {
  const msg = JSON.stringify({ type, payload });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// ── state監視（ポーリングでBOTプロセスのstate.jsonを読む）─

const lastStateMtimes: Record<string, number> = {};
// 直前読み込みのキャッシュ（ファイル一時消失時のポジション消失防止）
const lastGoodCache: Record<string, { positions: Record<string, any>; currentPrices: Record<string, number> }> = {};

function watchStateFile(): void {
  const stateFiles = ["state_BOT1.json", "state_BOT2.json", "state_BOT3.json", "state_BOT4.json", "state.json"];
  setInterval(() => {
    try {
      let changed = false;
      for (const filename of stateFiles) {
        const filePath = path.resolve(__dirname, `../data/${filename}`);
        if (!fs.existsSync(filePath)) continue;
        const stat = fs.statSync(filePath);
        const mtime = stat.mtimeMs;
        if (mtime > (lastStateMtimes[filename] ?? 0)) {
          lastStateMtimes[filename] = mtime;
          changed = true;
        }
      }
      if (changed) {
        const state = loadMergedState();
        // キャッシュ: 各stateファイルから読み取れたポジション/価格を保存
        for (const filename of stateFiles) {
          const filePath = path.resolve(__dirname, `../data/${filename}`);
          try {
            if (!fs.existsSync(filePath)) continue;
            const raw = fs.readFileSync(filePath, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed.positions) {
              lastGoodCache[filename] = { positions: parsed.positions, currentPrices: parsed.currentPrices ?? {} };
            }
          } catch {}
        }
        // キャッシュから欠落ポジションを補完（ファイル一時消失/読み取りエラー対策）
        for (const filename of stateFiles) {
          if (!lastGoodCache[filename]) continue;
          for (const [id, pos] of Object.entries(lastGoodCache[filename].positions)) {
            if (!state.positions[id]) {
              state.positions[id] = pos as any;
            }
          }
          if (lastGoodCache[filename].currentPrices) {
            Object.assign(state.currentPrices, lastGoodCache[filename].currentPrices);
          }
        }

        broadcast("state:update", {
          positions: state.positions,
          pendingOpens: state.pendingOpens,
          currentPrices: state.currentPrices,
          autoConfig: state.autoConfig,
          importantEvents: state.importantEvents.slice(0, 50),
          lastCycleAt: state.lastCycleAt,
          realized: state.realized,
          feesEarned: state.feesEarned,
          swapFeesPaid: state.swapFeesPaid,
          gasUsedSinceStart: state.gasUsedSinceStart,
          gasUsedCumulative: state.gasUsedCumulative,
          restartCount: state.restartCount,
          dailyOpenCount: state.dailyOpenCount,
          initParams: state.initParams,
        });
        broadcast("performance:update", calcPerformanceSummary(state));
      }
    } catch (e) {
      // ignore
    }
  }, 1000);
}

// ── REST API ─────────────────────────────────────────────

/** GET /api/state — 全state JSON */
app.get("/api/state", (_req, res) => {
  const state = loadMergedState();
  res.json(state);
});

/** GET /api/positions — ポジション一覧 */
app.get("/api/positions", (_req, res) => {
  const state = loadMergedState();
  res.json(Object.values(state.positions));
});

/** GET /api/performance — パフォーマンスサマリー */
app.get("/api/performance", (_req, res) => {
  const state = loadMergedState();
  res.json(calcPerformanceSummary(state));
});

import { SuiClient } from "@mysten/sui/client";

/** GET /api/wallets — ウォレットのオンチェーン残高取得 */
app.get("/api/wallets", async (_req, res) => {
  try {
    const state = loadMergedState();
    // ポジションがあればそこからアドレスを特定、無ければデフォルトアドレス
    const walletAddress = Object.values(state.positions)[0]?.walletAddress 
      || "0xc17e3ef45cfb8ff6f0d5e55669b148fc27e615e2bde27109ccf3e952d1215559";

    const client = new SuiClient({ url: process.env.SUI_RPC_URL || "https://fullnode.mainnet.sui.io:443" });
    const coins = await client.getAllCoins({ owner: walletAddress });
    
    const balances: Record<string, string> = {
      DEEP: "0",
      SUI: "0",
      USDC: "0",
    };

    for (const coin of coins.data) {
      const sym = coin.coinType.split("::").pop();
      if (sym) {
        balances[sym] = (BigInt(balances[sym] || "0") + BigInt(coin.balance)).toString();
      }
    }

    res.json([
      {
        address: walletAddress,
        label: "グリッド用",
        balances: balances,
      }
    ]);
  } catch (e) {
    console.error("Failed to fetch wallets:", e);
    res.json([
      {
        address: "0xc17e3ef45cfb8ff6f0d5e55669b148fc27e615e2bde27109ccf3e952d1215559",
        label: "グリッド用",
        balances: { SUI: "0", DEEP: "0", USDC: "0" }
      }
    ]);
  }
});

/** GET /api/events — 重要イベント履歴 */
app.get("/api/events", (req, res) => {
  const state = loadMergedState();
  const limit = Number(req.query.limit ?? 100);
  res.json(state.importantEvents.slice(0, limit));
});

/** POST /api/config — AutoConfig更新 */
app.post("/api/config", (req, res) => {
  updateConfigAll(req.body);
  const state = loadMergedState();
  broadcast("config:update", state.autoConfig);
  res.json({ ok: true, config: state.autoConfig });
});

/** POST /api/init-params — GridInitParams更新 */
app.post("/api/init-params", (req, res) => {
  updateInitParamsAll(req.body);
  const state = loadMergedState();
  res.json({ ok: true, params: state.initParams });
});

/** POST /api/events/clear — 重要イベント履歴クリア */
app.post("/api/events/clear", (_req, res) => {
  clearEventsAll();
  broadcast("events:cleared", null);
  res.json({ ok: true });
});

/** POST /api/performance/reset — パフォーマンスリセット */
app.post("/api/performance/reset", (_req, res) => {
  resetPerformanceAll();
  broadcast("performance:reset", null);
  res.json({ ok: true });
});

/** GET /api/bots — BOTプロセス一覧 */
app.get("/api/bots", (_req, res) => {
  const bots = [
    { botId: "BOT1", label: "Grid・Cetus (DEEP/SUI)", dex: "cetus" as Dex, mode: "grid" as Mode, status: botStatus.get("BOT1")?.status || "stopped", pid: botStatus.get("BOT1")?.pid },
    { botId: "BOT2", label: "Grid・Cetus (SUI/USDC)", dex: "cetus" as Dex, mode: "grid" as Mode, status: botStatus.get("BOT2")?.status || "stopped", pid: botStatus.get("BOT2")?.pid },
    { botId: "BOT3", label: "空白・Cetus (SUI/USDC)", dex: "cetus" as Dex, mode: "gap" as Mode, status: botStatus.get("BOT3")?.status || "stopped", pid: botStatus.get("BOT3")?.pid },
    { botId: "BOT4", label: "空白・Turbos (SUI/USDC)", dex: "turbos" as Dex, mode: "gap" as Mode, status: botStatus.get("BOT4")?.status || "stopped", pid: botStatus.get("BOT4")?.pid },
  ];
  res.json(bots);
});

// 各BOT固有の起動パラメータ
const botEnvs: Record<string, { GRID_POOLS: string; CETUS_ENABLED: string; TURBOS_ENABLED: string }> = {
  BOT1: {
    GRID_POOLS: "DEEP/SUI",
    CETUS_ENABLED: "true",
    TURBOS_ENABLED: "false",
  },
  BOT2: {
    GRID_POOLS: "SUI/USDC",
    CETUS_ENABLED: "true",
    TURBOS_ENABLED: "false",
  },
  BOT3: {
    GRID_POOLS: "SUI/USDC",
    CETUS_ENABLED: "true",
    TURBOS_ENABLED: "false",
  },
  BOT4: {
    GRID_POOLS: "SUI/USDC",
    CETUS_ENABLED: "false",
    TURBOS_ENABLED: "true",
  }
};

// ── BOT起動共通関数 ──────────────────────────────────────
function startBot(id: string): boolean {
  if (activeProcesses.has(id)) {
    console.log(`[BOT] ${id} は既に起動しています`);
    return false;
  }

  const envRpc = process.env.SUI_RPC_URL;
  if (!envRpc) {
    console.error("[BOT] 起動失敗: SUI_RPC_URL が設定されていません。");
    return false;
  }

  try {
    const configEnv = botEnvs[id] || {};
    const botProc = spawn("npx", ["tsx", "src/main.ts"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        BOT_ID: id,
        SUI_RPC_URL: envRpc,
        ...configEnv
      }
    });

    botProc.stdout?.on("data", (data) => {
      const msg = data.toString().trim();
      if (!msg) return;
      const entry: LogEntry = {
        id: generateId(),
        timestamp: Date.now(),
        level: "info",
        tag: id,
        message: msg,
      };
      logBuffer.unshift(entry);
      if (logBuffer.length > 500) logBuffer.pop();
      broadcast("log:entry", entry);
    });

    botProc.stderr?.on("data", (data) => {
      const msg = data.toString().trim();
      if (!msg) return;
      const entry: LogEntry = {
        id: generateId(),
        timestamp: Date.now(),
        level: "error",
        tag: id,
        message: msg,
      };
      logBuffer.unshift(entry);
      if (logBuffer.length > 500) logBuffer.pop();
      broadcast("log:entry", entry);
    });

    botProc.on("close", (code) => {
      console.log(`[BOT] Process ${id} exited with code ${code}`);
      activeProcesses.delete(id);

      const prev = botStatus.get(id);
      botStatus.set(id, { status: "stopped" });

      if (prev?.status === "running" && code !== 0 && code !== null) {
        console.log(`[BOT] ${id} が異常終了しました。5秒後に自動再起動します...`);
        setTimeout(() => startBot(id), 5000);
      }
    });

    activeProcesses.set(id, botProc);
    botStatus.set(id, { status: "running", pid: botProc.pid });
    console.log(`[BOT] ${id} を起動しました (PID: ${botProc.pid})`);
    return true;
  } catch (e) {
    console.error(`[BOT] Failed to start ${id}:`, e);
    return false;
  }
}

/** POST /api/bots/:id/start — BOT起動 */
app.post("/api/bots/:id/start", (req, res) => {
  const { id } = req.params;
  console.log(`[API] BOT起動要求: ${id}`);

  if (activeProcesses.has(id)) {
    return res.json({ ok: false, message: "既に起動しています" });
  }

  const ok = startBot(id);
  if (ok) {
    res.json({ ok: true, botId: id });
  } else {
    res.status(500).json({ ok: false, message: "BOT起動に失敗しました" });
  }
});

/** POST /api/bots/:id/stop — BOT停止 */
app.post("/api/bots/:id/stop", (req, res) => {
  const { id } = req.params;
  console.log(`[API] BOT停止要求: ${id}`);

  const proc = activeProcesses.get(id);
  if (proc) {
    proc.kill("SIGTERM");
    activeProcesses.delete(id);
    botStatus.set(id, { status: "stopped" });
    res.json({ ok: true, botId: id, message: "プロセスを停止しました" });
  } else {
    res.json({ ok: false, message: "該当する起動中のプロセスはありません" });
  }
});

/** POST /api/logs — ログ追記（BOTプロセスからの受信） */
const logBuffer: LogEntry[] = [];
app.post("/api/logs", (req, res) => {
  const entry: LogEntry = {
    id: generateId(),
    timestamp: Date.now(),
    level: req.body.level ?? "info",
    tag: req.body.tag ?? "BOT",
    message: req.body.message ?? "",
    detail: req.body.detail,
  };
  logBuffer.unshift(entry);
  if (logBuffer.length > 500) logBuffer.pop();
  broadcast("log:entry", entry);
  res.json({ ok: true });
});

/** GET /api/logs — ログ一覧 */
app.get("/api/logs", (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  res.json(logBuffer.slice(0, limit));
});

// ── 静的ファイル配信（ビルド後のダッシュボード）────────────

const dashboardDist = path.resolve(__dirname, "../dashboard/dist");
if (fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
}

// ── 起動 ──────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[Server] Listening on http://localhost:${PORT}`);
  console.log(`[Server] WebSocket on ws://localhost:${PORT}`);
  watchStateFile();

  // BOT1を自動起動
  if (process.env.AUTO_START_BOT1 !== "false") {
    setTimeout(() => {
      console.log("[Server] BOT1 を自動起動します...");
      startBot("BOT1");
    }, 3000);
  }

  // BOT2を自動起動（SUI/USDCプール）
  if (process.env.AUTO_START_BOT2 === "true") {
    setTimeout(() => {
      console.log("[Server] BOT2 を自動起動します...");
      startBot("BOT2");
    }, 6000);
  }
});
