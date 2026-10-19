'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LeaderboardResponse, LeaderboardToken } from '@/lib/signals';

const EXPLORER_BASE = 'https://explorer.testnet.chain.robinhood.com';

type SortKey = 'vibeScore' | 'liquidity' | 'progress';

function shorten(address?: string | null): string {
  if (!address) return '—';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function vibeTone(score: number): string {
  if (score >= 75) return 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10';
  if (score >= 45) return 'text-lime-400 border-lime-500/40 bg-lime-500/10';
  if (score >= 20) return 'text-amber-400 border-amber-500/40 bg-amber-500/10';
  return 'text-zinc-400 border-zinc-600/40 bg-zinc-700/20';
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.min(Math.max(value, 0), 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-full min-w-[56px] overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-emerald-400 to-fuchsia-500 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-11 shrink-0 text-right font-mono text-[10px] text-zinc-400">
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const styles =
    rank === 1
      ? 'border-amber-400/60 bg-amber-400/10 text-amber-300'
      : rank === 2
        ? 'border-zinc-400/50 bg-zinc-400/10 text-zinc-300'
        : rank === 3
          ? 'border-orange-500/50 bg-orange-500/10 text-orange-300'
          : 'border-zinc-700 bg-zinc-800/50 text-zinc-500';
  return (
    <span
      className={`inline-flex h-6 w-6 items-center justify-center rounded-md border font-mono text-[10px] font-bold ${styles}`}
    >
      {rank}
    </span>
  );
}

export default function VibeLeaderboard() {
  const [tokens, setTokens] = useState<LeaderboardToken[]>([]);
  const [isMock, setIsMock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('vibeScore');

  const fetchTokens = useCallback(async () => {
    try {
      const res = await fetch('/api/leaderboard', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as LeaderboardResponse;
      setTokens(Array.isArray(body.data) ? body.data : []);
      setIsMock(Boolean(body.mock));
      setError(body.error ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leaderboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer the first fetch so state updates happen outside the effect body
    // (avoids cascading renders flagged by the React compiler).
    const initial = setTimeout(() => void fetchTokens(), 0);
    const timer = setInterval(fetchTokens, 15_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [fetchTokens]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? tokens.filter(
          (t) =>
            t.symbol.toLowerCase().includes(q) ||
            t.name.toLowerCase().includes(q) ||
            t.tokenAddress.includes(q)
        )
      : tokens;

    return [...filtered].sort((a, b) => {
      if (sortKey === 'liquidity') return b.liquidity - a.liquidity;
      if (sortKey === 'progress') return b.progress - a.progress;
      return b.vibeScore - a.vibeScore;
    });
  }, [tokens, query, sortKey]);

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60 shadow-[0_0_40px_-20px_rgba(217,70,239,0.5)] backdrop-blur">
      <header className="flex flex-col gap-3 border-b border-zinc-800 bg-zinc-950/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <h2 className="font-mono text-xs font-bold tracking-[0.2em] text-fuchsia-400">
            VIBE SCORE LEADERBOARD
          </h2>
          {isMock && (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider text-amber-400">
              MOCK
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500">
              ⌕
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search symbol / address"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950/80 py-1.5 pl-7 pr-2 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 sm:w-56"
            />
          </div>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="rounded-lg border border-zinc-700 bg-zinc-950/80 px-2 py-1.5 font-mono text-[11px] text-zinc-300 focus:border-emerald-500/60 focus:outline-none"
            aria-label="Sort tokens"
          >
            <option value="vibeScore">Vibe</option>
            <option value="liquidity">Liquidity</option>
            <option value="progress">Progress</option>
          </select>
        </div>
      </header>

      <div className="flex-1 overflow-auto [scrollbar-color:#3f3f46_transparent] [scrollbar-width:thin]">
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-zinc-800/50" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <p className="px-4 py-10 text-center font-mono text-xs text-zinc-600">
            no tokens match “{query}”
          </p>
        ) : (
          <>
            {/* Desktop table */}
            <table className="hidden w-full border-collapse text-left md:table">
              <thead className="sticky top-0 z-10 bg-zinc-950/90 backdrop-blur">
                <tr className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="px-4 py-2.5 font-medium">#</th>
                  <th className="px-2 py-2.5 font-medium">Token</th>
                  <th className="px-2 py-2.5 font-medium">Liquidity</th>
                  <th className="px-2 py-2.5 font-medium">Sync Progress</th>
                  <th className="px-2 py-2.5 font-medium">Vibe</th>
                  <th className="px-4 py-2.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((token, i) => (
                  <tr
                    key={token.tokenAddress || token.launchId}
                    className="group border-t border-zinc-800/60 transition-colors hover:bg-zinc-800/40"
                  >
                    <td className="px-4 py-2.5">
                      <RankBadge rank={i + 1} />
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="flex flex-col">
                        <span className="font-mono text-sm font-semibold text-zinc-100 group-hover:text-emerald-300">
                          ${token.symbol}
                        </span>
                        <span className="max-w-[180px] truncate text-[10px] text-zinc-500">
                          {token.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-2 py-2.5 font-mono text-xs text-zinc-300">
                      {token.liquidity.toFixed(4)}
                      <span className="ml-1 text-[10px] text-zinc-500">{token.pairSymbol}</span>
                    </td>
                    <td className="w-[180px] px-2 py-2.5">
                      <ProgressBar value={token.progress} />
                    </td>
                    <td className="px-2 py-2.5">
                      <span
                        className={`inline-flex min-w-[42px] justify-center rounded-md border px-2 py-0.5 font-mono text-xs font-bold ${vibeTone(token.vibeScore)}`}
                      >
                        {token.vibeScore}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <a
                          href={`${EXPLORER_BASE}/address/${token.tokenAddress}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-md border border-zinc-700 bg-zinc-800/60 px-2 py-1 font-mono text-[10px] text-zinc-400 transition-colors hover:border-emerald-500/50 hover:text-emerald-400"
                        >
                          EXPLORER
                        </a>
                        <button
                          type="button"
                          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 font-mono text-[10px] font-bold text-emerald-400 transition-colors hover:bg-emerald-500/20"
                        >
                          TRADE
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile cards */}
            <ul className="divide-y divide-zinc-800/60 md:hidden">
              {visible.map((token, i) => (
                <li key={token.tokenAddress || token.launchId} className="p-3 active:bg-zinc-800/40">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <RankBadge rank={i + 1} />
                      <div className="flex flex-col">
                        <span className="font-mono text-sm font-semibold text-zinc-100">
                          ${token.symbol}
                        </span>
                        <span className="max-w-[160px] truncate text-[10px] text-zinc-500">
                          {token.name}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`inline-flex min-w-[42px] justify-center rounded-md border px-2 py-0.5 font-mono text-xs font-bold ${vibeTone(token.vibeScore)}`}
                    >
                      {token.vibeScore}
                    </span>
                  </div>

                  <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-zinc-400">
                    <span>
                      liq {token.liquidity.toFixed(4)} {token.pairSymbol}
                    </span>
                    <span className="text-zinc-600">{shorten(token.tokenAddress)}</span>
                  </div>

                  <div className="mt-2">
                    <ProgressBar value={token.progress} />
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <a
                      href={`${EXPLORER_BASE}/address/${token.tokenAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 rounded-md border border-zinc-700 bg-zinc-800/60 py-1.5 text-center font-mono text-[10px] text-zinc-400"
                    >
                      EXPLORER
                    </a>
                    <button
                      type="button"
                      className="flex-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 py-1.5 font-mono text-[10px] font-bold text-emerald-400"
                    >
                      TRADE
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-zinc-800 bg-zinc-950/70 px-4 py-2 font-mono text-[10px]">
        <span className="text-zinc-500">{visible.length} tokens indexed</span>
        {error ? (
          <span className="truncate text-red-400" title={error}>
            ⚠ {error}
          </span>
        ) : (
          <span className="text-zinc-500">refreshes every 15s</span>
        )}
      </footer>
    </section>
  );
}
