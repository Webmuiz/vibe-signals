"use client";

import React from "react";

interface TradingTerminalProps {
  symbol: string;
  tradeTab: "buy" | "sell";
  onTradeTabChange: (tab: "buy" | "sell") => void;
  apeAmount: string;
  onApeAmountChange: (value: string) => void;
  sellAmount: string;
  onSellAmountChange: (value: string) => void;
  ethAvailable: number;
  tokenBalance: number;
  isTxPending: boolean;
  hash: `0x${string}` | undefined;
  isTxWaiting: boolean;
  isTxSuccess: boolean;
  receiptStatus: "success" | "reverted" | undefined;
  onExecuteApe: () => void;
  onExecuteSell: () => void;
  /**
   * True when the token has graduated off the bonding curve
   * (`curve.complete() === true` or curve progress >= 100%). Graduated tokens
   * no longer trade on the curve, so the terminal swaps the curve buy/sell
   * actions for a single, always-clickable "Trade on vibe/vibe" action that
   * opens the official DEX page in a new tab.
   */
  isGraduated?: boolean;
  /** Official vibe/vibe token page URL, opened for graduated tokens. */
  tradeUrl?: string;
}

export default function TradingTerminal({
  symbol,
  tradeTab,
  onTradeTabChange,
  apeAmount,
  onApeAmountChange,
  sellAmount,
  onSellAmountChange,
  ethAvailable,
  tokenBalance,
  isTxPending,
  hash,
  isTxWaiting,
  isTxSuccess,
  receiptStatus,
  onExecuteApe,
  onExecuteSell,
  isGraduated = false,
  tradeUrl,
}: TradingTerminalProps) {
  // Graduated tokens no longer trade on the bonding curve. Rather than leaving
  // the buy/sell buttons dead (which reads as "frozen"), we surface a single,
  // always-clickable action that opens the official vibe/vibe DEX page.
  if (isGraduated) {
    const href = tradeUrl || "https://testnet.vibevibe.fun";
    return (
      <div className="bg-[#0a0a0a] border border-zinc-800 rounded-xl overflow-hidden p-4 flex flex-col shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs font-bold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-md">
            🎓 Graduated
          </span>
          <span className="text-zinc-400 text-xs font-mono bg-zinc-900/50 px-2 py-1 rounded">
            Bal: {Math.floor(tokenBalance).toLocaleString()} {symbol || "TKN"}
          </span>
        </div>

        <p className="text-zinc-400 text-xs leading-relaxed mb-4">
          This token has graduated off the bonding curve. Liquidity is locked in a
          Uniswap v4 pool, so trading now happens on the vibe/vibe DEX.
        </p>

        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-sm uppercase rounded-lg shadow-[0_0_15px_rgba(16,185,129,0.25)] transition-all text-center block"
        >
          Trade on vibe/vibe ↗
        </a>
      </div>
    );
  }

  return (
    <div className="bg-[#0a0a0a] border border-zinc-800 rounded-xl overflow-hidden p-4 flex flex-col shadow-xl">
      {/* Header & Tabs */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2">
          <button
            onClick={() => onTradeTabChange("buy")}
            className={`px-5 py-1.5 text-sm font-bold rounded-md transition-all ${tradeTab === "buy" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            Buy
          </button>
          <button
            onClick={() => onTradeTabChange("sell")}
            className={`px-5 py-1.5 text-sm font-bold rounded-md transition-all ${tradeTab === "sell" ? "bg-red-500/10 text-red-400 border border-red-500/30" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            Sell
          </button>
        </div>
        <span className="text-zinc-400 text-xs font-mono bg-zinc-900/50 px-2 py-1 rounded">
          Bal: {tradeTab === "buy" ? `${ethAvailable.toFixed(4)} ETH` : `${Math.floor(tokenBalance).toLocaleString()} ${symbol || "TKN"}`}
        </span>
      </div>

      {/* Percentage Pills */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        {[25, 50, 75, 100].map((pct) => (
          <button
            key={pct}
            onClick={() => {
              if (tradeTab === "buy") {
                // Leave 0.005 ETH for gas when maxing out
                const val = pct === 100 ? Math.max(0, ethAvailable - 0.005) : ethAvailable * (pct / 100);
                onApeAmountChange(val.toFixed(4).replace(/\.?0+$/, ""));
              } else {
                const val = tokenBalance * (pct / 100);
                // Round down to avoid decimal dust reversion on sells
                onSellAmountChange(Math.floor(val).toString());
              }
            }}
            className="bg-zinc-800/40 hover:bg-zinc-700/60 text-zinc-400 text-[11px] py-1.5 rounded transition-colors border border-zinc-800 hover:border-zinc-600 font-semibold"
          >
            {pct === 100 ? "MAX" : `${pct}%`}
          </button>
        ))}
      </div>

      {/* Input Field */}
      <div className="relative mb-4">
        <input
          type="number"
          value={tradeTab === "buy" ? apeAmount : sellAmount}
          onChange={(e) => (tradeTab === "buy" ? onApeAmountChange(e.target.value) : onSellAmountChange(e.target.value))}
          placeholder="0.00"
          className="w-full bg-zinc-950 border border-zinc-800 focus:border-emerald-500/50 rounded-lg py-3 px-4 text-white text-xl font-mono outline-none transition-all placeholder:text-zinc-700"
        />
        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-bold text-sm">
          {tradeTab === "buy" ? "ETH" : symbol || "TKN"}
        </span>
      </div>

      {/* Execute Action */}
      {tradeTab === "buy" ? (
        <button
          onClick={onExecuteApe}
          disabled={isTxPending}
          className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-sm uppercase rounded-lg shadow-[0_0_15px_rgba(16,185,129,0.2)] transition-all disabled:opacity-50"
        >
          {isTxPending ? "Executing..." : `Quick Buy ${symbol || ""}`}
        </button>
      ) : (
        <button
          onClick={onExecuteSell}
          disabled={isTxPending}
          className="w-full py-3 bg-red-500 hover:bg-red-400 text-white font-black text-sm uppercase rounded-lg shadow-[0_0_15px_rgba(239,68,68,0.2)] transition-all disabled:opacity-50"
        >
          {isTxPending ? "Executing..." : `Dump ${symbol || ""}`}
        </button>
      )}

      {/* Success Toast */}
      {hash && (
        <div className="mt-3 p-3 bg-zinc-950 border border-zinc-800 rounded-lg text-xs font-mono text-center flex flex-col items-center gap-1.5">
          {isTxWaiting && (
            <span className="text-yellow-400 font-bold flex items-center gap-2 animate-pulse">
              ⏳ Confirming on-chain...
            </span>
          )}
          {isTxSuccess && receiptStatus === "success" && (
            <span className="text-emerald-400 font-bold">
              ✅ Execution Confirmed!
            </span>
          )}
          {receiptStatus === "reverted" && (
            <span className="text-red-400 font-bold">
              ❌ Transaction Reverted (Incompatible Router or Slippage)
            </span>
          )}
          <a
            href={`https://explorer.testnet.chain.robinhood.com/tx/${hash}`}
            target="_blank"
            rel="noreferrer"
            className="underline text-zinc-400 hover:text-white transition-colors"
          >
            View on Explorer ↗
          </a>
        </div>
      )}
    </div>
  );
}
