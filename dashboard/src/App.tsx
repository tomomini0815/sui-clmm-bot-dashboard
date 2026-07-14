import React from "react";
import { useGridBot } from "./hooks/useGridBot";
import { Header } from "./components/Header";
import { MonitorBar } from "./components/MonitorBar";
import { PerformancePanel } from "./components/PerformancePanel";
import { StrategyCards } from "./components/StrategyCards";
import { WalletPanel } from "./components/WalletPanel";
import { DexPanel } from "./components/DexPanel";
import { LogPanel } from "./components/LogPanel";
import { EventHistoryPanel } from "./components/EventHistoryPanel";
import { PositionList } from "./components/PositionList";

export default function App() {
  const {
    state,
    performance,
    wallets,
    bots,
    logs,
    connected,
    actionStatus,
    updateConfig,
    startBot,
    stopBot,
    resetPerformance,
    clearEvents,
  } = useGridBot();

  const handleStartAll = async () => {
    for (const bot of bots) {
      if (bot.status !== "running") {
        await startBot(bot.botId);
      }
    }
  };

  const handleStopAll = async () => {
    for (const bot of bots) {
      if (bot.status === "running") {
        await stopBot(bot.botId);
      }
    }
  };

  return (
    <div className="dashboard-layout">
      {/* ヘッダー */}
      <Header
        bots={bots}
        connected={connected}
        onStartAll={handleStartAll}
        onStopAll={handleStopAll}
      />

      {/* 操作フィードバック通知バー (パンくず) */}
      {actionStatus && (
        <div style={{
          background: "rgba(59, 130, 246, 0.12)",
          borderBottom: "1px solid rgba(59, 130, 246, 0.25)",
          color: "var(--accent-cyan)",
          fontSize: "0.78rem",
          padding: "6px 20px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontWeight: 500,
          animation: "fadeInUp 0.15s ease"
        }}>
          <span>⚡</span>
          <span>操作ログ:</span>
          <span style={{ color: "var(--text-primary)" }}>{actionStatus}</span>
        </div>
      )}

      {/* 監視設定バー */}
      <MonitorBar
        config={state.autoConfig}
        state={state}
        onConfigChange={updateConfig}
      />

      {/* メイン2カラム */}
      <div className="main-columns">
        {/* 左カラム */}
        <div className="left-column">
          <PerformancePanel
            performance={performance}
            onReset={resetPerformance}
          />
          <StrategyCards
            bots={bots}
            positions={Object.values(state.positions)}
            realized={state.realized}
            feesEarned={state.feesEarned}
            swapFeesPaid={state.swapFeesPaid}
            prices={state.currentPrices}
            roundTripsCompleted={performance.roundTripsCompleted}
          />
          <WalletPanel wallets={wallets} />
          <DexPanel bots={bots} onStart={startBot} onStop={stopBot} />
          <LogPanel logs={logs} />
          <EventHistoryPanel
            events={state.importantEvents}
            onClear={clearEvents}
          />
        </div>

        {/* 右カラム */}
        <div className="right-column">
          <PositionList
            positions={state.positions}
            prices={state.currentPrices}
          />
        </div>
      </div>
    </div>
  );
}
