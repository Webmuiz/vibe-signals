'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Signal, SignalsResponse } from '@/lib/signals';

// Poll cadence for /api/signals. This was 3s, which meant every open tab hit
// the Turso-backed route 20 times a minute (1,200 reads/hour/tab). Signals are
// derived from launch rows that change on the order of tens of seconds, so 15s
// is indistinguishable to a human while cutting DB traffic by 80%.
const POLL_INTERVAL_MS = 15_000;
const MAX_RENDERED = 60;

/**
 * Shared polling hook so the full terminal and the compact ticker can each
 * mount independently without duplicating fetch logic.
 */
export function useSignals() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [isMock, setIsMock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const seenIdsRef = useRef<Set<string>>(new Set());

  const fetchSignals = useCallback(async () => {
    try {
      const res = await fetch('/api/signals', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const body = (await res.json()) as SignalsResponse;
      const incoming = Array.isArray(body.data) ? body.data : [];

      const fresh = new Set<string>();
      for (const s of incoming) {
        if (!seenIdsRef.current.has(s.id)) fresh.add(s.id);
      }
      seenIdsRef.current = new Set(incoming.map((s) => s.id));

      setSignals(incoming.slice(0, MAX_RENDERED));
      setNewIds(fresh);
      setIsMock(Boolean(body.mock));
      setError(body.error ?? null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reach signal stream');
    }
  }, []);

  return { signals, isMock, error, lastUpdated, newIds, fetchSignals };
}

/**
 * Compact one-line ticker for the top of the dashboard. Shows the newest
 * signal and rotates through the stream without taking over the layout.
 */
export function SignalTicker({ onOpen }: { onOpen?: () => void }) {
  const { signals, isMock, error } = useSignals();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (signals.length === 0) return;
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % signals.length);
    }, 3_500);
    return () => clearInterval(timer);
  }, [signals.length]);

  const current = signals[index % Math.max(signals.length, 1)];

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-left backdrop-blur transition-colors hover:border-emerald-500/40"
      title="Open live signal feed"
    >
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] font-bold tracking-widest text-emerald-400">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        LIVE
      </span>

      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400">
        {error ? (
          <span className="text-red-400">⚠ {error}</span>
        ) : current ? (
          current.kind === 'SYNC' ? (
            <>
              <span className="text-emerald-400">SYNC</span>
              <span className="text-zinc-500">: </span>
              <span className="text-zinc-200">${current.symbol}</span>
              <span className="text-zinc-500"> liq: </span>
              <span className="text-zinc-100">{current.liquidity.toFixed(4)}</span>
              <span className="text-zinc-500"> (</span>
              <span className="text-emerald-400">{current.progress.toFixed(1)}%</span>
              <span className="text-zinc-500">)</span>
            </>
          ) : (
            <>
              <span className="text-fuchsia-400">BUY</span>
              <span className="text-zinc-500">: </span>
              <span className="text-zinc-100">{current.amount.toFixed(4)}</span>
              <span className="text-zinc-500"> {current.pairSymbol} on </span>
              <span className="text-fuchsia-300">{shorten(current.tokenAddress)}</span>
              <span className="text-zinc-500"> by </span>
              <span className="text-zinc-400">{shorten(current.buyer)}</span>
            </>
          )
        ) : (
          <span className="text-zinc-600">awaiting signal stream…</span>
        )}
      </span>

      {isMock && (
        <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold text-amber-400">
          MOCK
        </span>
      )}
      <span className="shrink-0 font-mono text-[10px] text-zinc-600 group-hover:text-emerald-400">
        OPEN ▸
      </span>
    </button>
  );
}

function shorten(address?: string): string {
  if (!address) return '0x???';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

function SignalRow({ signal, isNew }: { signal: Signal; isNew: boolean }) {
  const isSync = signal.kind === 'SYNC';

  return (
    <div
      className={[
        'group flex items-start gap-2 rounded-md px-2 py-1.5 font-mono text-[11px] leading-relaxed transition-colors sm:text-xs',
        isNew ? 'animate-[signalIn_400ms_ease-out]' : '',
        isSync
          ? 'hover:bg-emerald-500/5'
          : 'hover:bg-fuchsia-500/5',
      ].join(' ')}
    >
      <span className="shrink-0 text-zinc-600">{formatTime(signal.timestamp)}</span>

      <span
        className={[
          'shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold tracking-widest',
          isSync
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400 shadow-[0_0_8px_-2px_rgba(16,185,129,0.7)]'
            : 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-400 shadow-[0_0_8px_-2px_rgba(217,70,239,0.7)]',
        ].join(' ')}
      >
        {signal.kind}
      </span>

      <span className="min-w-0 flex-1 break-words text-zinc-300">
        {isSync ? (
          <>
            <span className="font-semibold text-emerald-300">${signal.symbol}</span>
            <span className="text-zinc-500"> liq: </span>
            <span className="text-zinc-100">{signal.liquidity.toFixed(4)}</span>
            <span className="text-zinc-500"> (</span>
            <span className="text-emerald-400">{signal.progress.toFixed(1)}%</span>
            <span className="text-zinc-500">)</span>
          </>
        ) : (
          <>
            <span className="text-zinc-100">{signal.amount.toFixed(4)}</span>
            <span className="text-zinc-500"> {signal.pairSymbol} pair on </span>
            <span className="text-fuchsia-300">{shorten(signal.tokenAddress)}</span>
            <span className="text-zinc-500"> by </span>
            <span className="text-zinc-400">{shorten(signal.buyer)}</span>
          </>
        )}
      </span>
    </div>
  );
}

export default function LiveSignalFeed() {
  const { signals, isMock, error, lastUpdated, newIds, fetchSignals } = useSignals();
  const [isPaused, setIsPaused] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(false);

  useEffect(() => {
    pausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    // Kick off the first poll on a microtask so state updates happen outside
    // the effect body (avoids cascading renders flagged by the React compiler).
    const initial = setTimeout(() => void fetchSignals(), 0);
    const timer = setInterval(() => {
      if (!pausedRef.current) void fetchSignals();
    }, POLL_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [fetchSignals]);

  // Auto-scroll to the newest entry (top) unless the user paused the feed.
  useEffect(() => {
    if (isPaused) return;
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
  }, [signals, isPaused]);

  return (
    <section className="flex h-full min-h-[420px] flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60 shadow-[0_0_40px_-20px_rgba(16,185,129,0.5)] backdrop-blur">
      {/* Terminal chrome */}
      <header className="flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/70 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          <h2 className="font-mono text-xs font-bold tracking-[0.2em] text-emerald-400">
            LIVE SIGNAL FEED
          </h2>
          {isMock && (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider text-amber-400">
              MOCK
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden font-mono text-[10px] text-zinc-500 sm:inline">
            {lastUpdated ? lastUpdated.toLocaleTimeString('en-GB', { hour12: false }) : '--:--:--'}
          </span>
          <button
            type="button"
            onClick={() => setIsPaused((p) => !p)}
            className={[
              'rounded border px-2 py-1 font-mono text-[10px] font-bold tracking-wider transition-colors',
              isPaused
                ? 'border-amber-500/50 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                : 'border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:border-emerald-500/50 hover:text-emerald-400',
            ].join(' ')}
            aria-pressed={isPaused}
          >
            {isPaused ? 'RESUME' : 'PAUSE'}
          </button>
        </div>
      </header>

      {/* Log body */}
      <div
        ref={scrollRef}
        className="relative flex-1 overflow-y-auto px-2 py-2 [scrollbar-color:#3f3f46_transparent] [scrollbar-width:thin]"
      >
        {signals.length === 0 && !error && (
          <p className="px-2 py-6 font-mono text-xs text-zinc-600">
            <span className="animate-pulse">▍</span> awaiting signal stream...
          </p>
        )}

        {signals.map((signal) => (
          <SignalRow key={signal.id} signal={signal} isNew={newIds.has(signal.id)} />
        ))}
      </div>

      {/* Status bar */}
      <footer className="flex items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950/70 px-4 py-2 font-mono text-[10px]">
        <span className="text-zinc-500">
          {signals.length} events · poll {POLL_INTERVAL_MS / 1000}s
        </span>
        {error ? (
          <span className="truncate text-red-400" title={error}>
            ⚠ {error}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-emerald-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            STREAM HEALTHY
          </span>
        )}
      </footer>
    </section>
  );
}
