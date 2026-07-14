import React from "react";
import type { WalletInfo } from "../types";

const TOKEN_ICONS: Record<string, string> = {
  SUI: "🔵", USDC: "💵", CETUS: "🐟", DEEP: "🌊", NS: "⚡", MAGMA: "🔥",
};

const TOKEN_DECIMALS: Record<string, number> = {
  SUI: 9, USDC: 6, CETUS: 9, DEEP: 6, NS: 9, MAGMA: 9,
};

function formatBalance(amount: string, token: string): string {
  const decimals = TOKEN_DECIMALS[token] ?? 9;
  const n = Number(amount) / Math.pow(10, decimals);
  if (n === 0) return "0";
  if (n < 0.001) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function shortenAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function WalletCard({ wallet }: { wallet: WalletInfo }) {
  return (
    <div className="wallet-card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: "1.2rem" }}>
          {wallet.label.includes("グリッド") ? "🔷" : "🟡"}
        </span>
        <div>
          <div style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--text-primary)" }}>
            {wallet.label}
          </div>
          <div className="wallet-address">{shortenAddress(wallet.address)}</div>
        </div>
        <button
          className="btn btn-xs"
          style={{ marginLeft: "auto" }}
          title="残高を更新"
        >
          🔄
        </button>
      </div>

      <div>
        {Object.entries(wallet.balances)
          .filter(([, amount]) => Number(amount) > 0)
          .map(([token, amount]) => (
            <div key={token} className="wallet-balance-row">
              <span className="wallet-token">
                {TOKEN_ICONS[token] ?? "💠"} {token}
              </span>
              <span className="wallet-amount">
                {formatBalance(amount, token)}
              </span>
            </div>
          ))}
        {Object.entries(wallet.balances)
          .filter(([, amount]) => Number(amount) === 0)
          .map(([token]) => (
            <div key={token} className="wallet-balance-row">
              <span className="wallet-token" style={{ color: "var(--text-dim)" }}>
                {TOKEN_ICONS[token] ?? "💠"} {token}
              </span>
              <span className="zero-amount">—</span>
            </div>
          ))}
      </div>
    </div>
  );
}

interface Props {
  wallets: WalletInfo[];
}

export function WalletPanel({ wallets }: Props) {
  return (
    <div className="glass-card">
      <div className="panel-header">
        <span className="panel-title">👛 ウォレット残高</span>
      </div>
      <div className="panel-body">
        <div className="wallet-cards">
          {wallets.map((w) => (
            <WalletCard key={w.address} wallet={w} />
          ))}
        </div>
      </div>
    </div>
  );
}
