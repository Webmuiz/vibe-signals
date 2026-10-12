"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { shortenAddress, formatCompactUsd } from "@/lib/tokenMetrics";

/**
 * A single normalized portfolio position as returned by `/api/proxyPortfolio`.
 * All numeric fields are already converted from wei into whole units by the
 * proxy, so the component never performs BigInt math.
 */
export interface PortfolioPosition {
  tokenAddress: string;
  name: string;
  symbol: string;
  imageUri: string | null;
  balance: number;
  valueEth: number;
  valueUsd: number;
  costEth: number;
  unrealizedPnlEth: number;
  unrealizedPnlUsd: number;
  realizedPnlEth: number;
  currentPriceEth: number;
  coverage: string;
  quoteAssetAddress: string | null;
}

export interface PortfolioSummary {
  coverage: string;
  totalValueEth: number;
  totalValueUsd: number;
  totalPnlEth: number;
  totalPnlUsd: number;
  realizedPnlEth: number;
  realizedPnlUsd: number;
  unrealizedPnlEth: number;
  unrealizedPnlUsd: number;
  buyCount: number;
  sellCount: number;
  tokensTraded: number;
  openPositions: number;
}

interface UserPortfolioProps {
  /** Connected wallet address. When absent the drawer shows a connect prompt. */
  address?: string;
  /** Whether the drawer is open. */
  isOpen: boolean;
  /** Close handler (backdrop click, X button, or Escape). */
  onClose: () => void;
  /**
   * Optional callback fired when a position row is clicked, so the parent can
   * open the token's detail view.
   */
  onSelectToken?: (tokenAddress: string) => void;
}

/** Formats a whole-unit ETH value with a fixed, readable precision. */
function formatEth(value: number): string {
  if (!Number.isFinite(value)) return "0.0000";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

/** Formats a token balance compactly (e.g. 1.2M, 45.3K). */
function formatBalance(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  if (abs >= 1) return value.toFixed(2);
  return value.toPrecision(4);
}

/** Renders a signed USD PnL value with a colour class. */
function PnlValue({ valueUsd, valueEth }: { valueUsd: number; valueEth: number }) {
  const positive = valueUsd >= 0;
  const color = positive ? "text-emerald-400" : "text-red-400";
  const sign = positive ? "+" : "-";
  return (
    <span className={`font-bold ${color}`}>
      {sign}
      {formatCompactUsd(Math.abs(valueUsd))}
      <span className="text-zinc-500 font-normal ml-1">
        ({sign}
        {formatEth(Math.abs(valueEth))} ETH)
      </span>
    </span>
  );
}

export default function UserPortfolio({
  address,
  isOpen,
  onClose,
  onSelectToken,
}: UserPortfolioProps) {
  const [positions, setPositions] = useState<PortfolioPosition[]>([]);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPortfolio = useCallback(async () => {
    if (!address) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/proxyPortfolio?address=${address}&t=${Date.now()}`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        // A 404 means the wallet simply has no indexed portfolio yet — that is
        // an empty state, not an error.
        if (res.status === 404) {
          setPositions([]);
          setSummary(null);
          return;
        }
        throw new Error(body?.error || `Portfolio request failed (${res.status})`);
      }
      const json = await res.json();
      setPositions(Array.isArray(json?.data?.positions) ? json.data.positions : []);
      setSummary(json?.data?.summary || null);
    } catch (err: any) {
      setError(err?.message || "Failed to load portfolio");
    } finally {
      setIsLoading(false);
    }
  }, [address]);

  // Fetch whenever the drawer opens (or the wallet changes while open).
  useEffect(() => {
    if (!isOpen || !address) return;
    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 20000);
    return () => clearInterval(interval);
  }, [isOpen, address, fetchPortfolio]);

  // Close on Escape for keyboard accessibility.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const totalPnlUsd = summary?.totalPnlUsd ?? 0;
  const totalPnlEth = summary?.totalPnlEth ?? 0;
  const pnlPositive = totalPnlUsd >= 0;

  const headerSubtitle = useMemo(() => {
    if (!address) return "Connect a wallet to view holdings";
    return shortenAddress(address);
  }, [address]);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden={!isOpen}
        className={`fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* Slide-out drawer */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="User Portfolio"
        className={`fixed top-0 right-0 z-[70] h-full w-full max-w-md bg-zinc-950 border-l border-zinc-800 shadow-2xl flex flex-col transition-transform duration-300 ease-out ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-zinc-800 bg-zinc-900/50">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span className="text-emerald-400">💼</span> Portfolio
            </h2>
            <span className="text-xs text-zinc-500 font-mono">{headerSubtitle}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchPortfolio}
              disabled={!address || isLoading}
              className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors disabled:opacity-40"
              title="Refresh"
            >
              ↻
            </button>
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-white text-xl leading-none px-1 transition-colors"
              aria-label="Close portfolio"
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {!address ? (
            <div className="text-center py-16 text-zinc-500 text-sm">
              Connect your wallet to view your token holdings.
            </div>
          ) : (
            <>
              {/* Summary card */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
                <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider block mb-1">
                  Total Portfolio Value
                </span>
                <div className="text-3xl font-bold text-white mb-1">
                  {isLoading && !summary ? (
                    <span className="text-gray-400 animate-pulse text-xl">Syncing...</span>
                  ) : (
                    formatCompactUsd(summary?.totalValueUsd ?? 0)
                  )}
                </div>
                <div className="text-xs text-zinc-500 font-mono mb-4">
                  {formatEth(summary?.totalValueEth ?? 0)} ETH
                </div>

                <div className="grid grid-cols-2 gap-3 pt-4 border-t border-zinc-800">
                  <div>
                    <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider block mb-1">
                      Total PnL
                    </span>
                    <PnlValue valueUsd={totalPnlUsd} valueEth={totalPnlEth} />
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider block mb-1">
                      Open Positions
                    </span>
                    <span className="text-sm font-bold text-zinc-300">
                      {summary?.openPositions ?? positions.length}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider block mb-1">
                      Realized PnL
                    </span>
                    <PnlValue
                      valueUsd={summary?.realizedPnlUsd ?? 0}
                      valueEth={summary?.realizedPnlEth ?? 0}
                    />
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider block mb-1">
                      Unrealized PnL
                    </span>
                    <PnlValue
                      valueUsd={summary?.unrealizedPnlUsd ?? 0}
                      valueEth={summary?.unrealizedPnlEth ?? 0}
                    />
                  </div>
                </div>

                {summary?.coverage && summary.coverage !== "COMPLETE" && (
                  <div className="mt-4 text-[10px] text-amber-400/80 border border-amber-500/20 bg-amber-500/5 rounded px-2 py-1">
                    Coverage: {summary.coverage} — some positions may be unpriced.
                  </div>
                )}
              </div>

              {/* Positions list */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs text-zinc-400 uppercase font-bold tracking-wider">
                    Holdings
                  </h3>
                  <span className="text-[10px] text-zinc-600">
                    {positions.length} token{positions.length === 1 ? "" : "s"}
                  </span>
                </div>

                {error ? (
                  <div className="text-center py-10 text-red-400 text-sm border border-dashed border-red-500/40 bg-red-500/5 rounded-xl">
                    {error}
                  </div>
                ) : isLoading && positions.length === 0 ? (
                  <div className="text-center py-10 text-emerald-400 text-sm animate-pulse border border-dashed border-emerald-500/40 bg-emerald-500/5 rounded-xl">
                    Loading positions...
                  </div>
                ) : positions.length === 0 ? (
                  <div className="text-center py-10 text-zinc-500 text-sm border border-dashed border-zinc-800 rounded-xl">
                    No token holdings found for this wallet.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {positions.map((p) => {
                      const pnlPositive = p.unrealizedPnlUsd >= 0;
                      return (
                        <li key={p.tokenAddress}>
                          <button
                            onClick={() => onSelectToken?.(p.tokenAddress)}
                            className="w-full text-left bg-zinc-900 hover:bg-zinc-800/80 border border-zinc-800 hover:border-emerald-500/40 rounded-lg p-3 transition-colors group"
                          >
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2 min-w-0">
                                {p.imageUri ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={p.imageUri}
                                    alt={p.symbol}
                                    className="w-7 h-7 rounded-full object-cover border border-zinc-700 shrink-0"
                                  />
                                ) : (
                                  <div className="w-7 h-7 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[10px] font-bold text-zinc-400 shrink-0">
                                    {p.symbol.slice(0, 2).toUpperCase()}
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <div className="text-sm font-bold text-zinc-200 truncate group-hover:text-emerald-400 transition-colors">
                                    {p.symbol}
                                  </div>
                                  <div className="text-[10px] text-zinc-500 truncate">
                                    {p.name}
                                  </div>
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <div className="text-sm font-bold text-zinc-200">
                                  {formatCompactUsd(p.valueUsd)}
                                </div>
                                <div className="text-[10px] text-zinc-500 font-mono">
                                  {formatEth(p.valueEth)} ETH
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center justify-between text-[10px] text-zinc-500">
                              <span className="font-mono">
                                Bal: {formatBalance(p.balance)} {p.symbol}
                              </span>
                              <span className={pnlPositive ? "text-emerald-400" : "text-red-400"}>
                                {pnlPositive ? "+" : "-"}
                                {formatCompactUsd(Math.abs(p.unrealizedPnlUsd))} uPnL
                              </span>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-zinc-800 bg-zinc-900/50 text-[10px] text-zinc-600 text-center">
          Data via VibeVibe V6 · Robinhood Chain Testnet
        </div>
      </aside>
    </>
  );
}
