import React from "react";
import { formatTimeLive, formatCompactUsd } from "@/lib/tokenMetrics";
import type { MindshareTelemetry } from "@/lib/analytics/mindshareEngine";

export interface TelemetryMomentum {
  buyPct?: number;
  sellPct?: number;
  volumeEth?: string | number;
  volumeUsd?: string | number;
}

interface LiveTelemetryPanelProps {
  isSyncingLive: boolean;
  /**
   * Whether the ETH/quote oracle price has been loaded at least once. Until it
   * has, any USD-denominated value is computed against a hard-coded seed rate
   * and MUST NOT be rendered — the panel shows "Syncing..." instead.
   */
  oracleReady?: boolean;
  timeSinceLaunchMins: number;
  bondingCurveProgress: number;
  ethDeposited: number | string;
  pairSymbol: string;
  marketCapUsd?: string;
  /**
   * Set by the parent once a live market-cap fetch has actually completed for
   * this token. This is what separates "we have not fetched yet" from "we
   * fetched and the answer is genuinely $0.00" — without it a real zero is
   * indistinguishable from a pending request and the panel spins forever.
   */
  marketCapResolved?: boolean;
  momentum?: TelemetryMomentum;
  volumeUsd?: string | number;
  volumeEth?: string | number;
  /**
   * Optional social mindshare telemetry from `/api/analytics/mindshare`.
   * Purely additive: when absent the panel renders exactly as before.
   */
  mindshare?: MindshareTelemetry | null;
}

/**
 * Muted, pulsing "Syncing..." placeholder used everywhere a USD metric is not
 * yet trustworthy (oracle not loaded, fetch in flight, or synthetic fallback).
 */
function SyncingText() {
  return <span className="text-gray-400 animate-pulse">Syncing...</span>;
}

export default function LiveTelemetryPanel({
  isSyncingLive,
  oracleReady = false,
  timeSinceLaunchMins,
  bondingCurveProgress,
  ethDeposited,
  pairSymbol,
  marketCapUsd,
  marketCapResolved = false,
  momentum,
  volumeUsd,
  volumeEth,
}: LiveTelemetryPanelProps) {
  // The synthetic graduation-target estimates produced by `calculateTokenMetrics`
  // at 100% curve progress. These are NOT real market caps and must never be
  // shown as if they were — they are the source of the initial "$50.5K" flash.
  const SYNTHETIC_GRAD_TARGETS = ['$50,500.00', '$220,000.00'];

  // A market cap is "resolved" only when it is present AND is not one of the
  // synthetic graduation targets. This lets the panel show a placeholder during
  // the first live fetch instead of flashing the graduation target.
  const hasResolvedMarketCap =
    !!marketCapUsd && !SYNTHETIC_GRAD_TARGETS.includes(marketCapUsd);

  // A genuine zero is a RESOLVED value, not a pending one. `$0.00` is a real
  // answer from the API and must render as `$0.00`; only a missing value or a
  // synthetic graduation target should trigger the spinner.
  const isZeroMarketCap =
    marketCapResolved &&
    !!marketCapUsd &&
    !SYNTHETIC_GRAD_TARGETS.includes(marketCapUsd) &&
    Number(String(marketCapUsd).replace(/[^0-9.-]/g, '')) === 0;

  // STRICT SYNCING GATE for Market Cap:
  //   - oracle not loaded yet (USD rate unknown), OR
  //   - the first live fetch is still in flight, OR
  //   - the value is a synthetic fallback (not real API data)
  // A resolved zero short-circuits all of the above.
  const showMarketCapSyncing =
    !isZeroMarketCap &&
    (!oracleReady || (isSyncingLive && !hasResolvedMarketCap) || !hasResolvedMarketCap);

  // STRICT SYNCING GATE for 24H Volume: same rules — no USD volume may render
  // until the oracle is ready and a real (non-zero) volume figure exists.
  const hasResolvedVolume = !!(
    (momentum?.volumeUsd || volumeUsd) ||
    (momentum?.volumeEth || volumeEth)
  );
  const showVolumeSyncing = !oracleReady || (isSyncingLive && !hasResolvedVolume);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-lg font-bold text-white flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping"></span>
          Live Telemetry
        </h3>
        <div className="flex gap-2 items-center">
          {isSyncingLive && <span className="text-[10px] text-emerald-400 font-bold uppercase animate-pulse border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 rounded">Syncing...</span>}
          <span className="text-xs text-zinc-400 font-bold border border-zinc-700 px-2 py-1 rounded bg-zinc-950">LIVE: {formatTimeLive(timeSinceLaunchMins)}</span>
        </div>
      </div>

      <div className="mb-8">
        <div className="flex justify-between text-xs mb-2">
          <span className="text-zinc-400">{bondingCurveProgress >= 100 ? 'Status' : `Bonding Curve Progress (${ethDeposited} ${pairSymbol})`}</span>
          <div className="flex gap-3">
            {/* While the first live fetch is in flight we must NOT render the
                synthetic graduation-target estimate ($50.5K / $220K), which is
                what `calculateTokenMetrics` returns at 100% curve progress and
                is what caused the initial "$50.5K" flash. Show a placeholder
                until real, API-derived data resolves. */}
            <span className="text-zinc-400 font-mono">
              MC: {showMarketCapSyncing ? <SyncingText /> : formatCompactUsd(marketCapUsd)}
            </span>
            <span className={bondingCurveProgress >= 100 ? "text-amber-400 font-bold" : "text-emerald-400 font-bold"}>
              {bondingCurveProgress >= 100 ? 'Graduated 🚀' : `${bondingCurveProgress.toFixed(1)}%`}
            </span>
          </div>
        </div>
        <div className="w-full bg-zinc-950 rounded-full h-3 overflow-hidden border border-zinc-800">
          <div
            className={`h-full transition-all ${bondingCurveProgress >= 100
              ? 'bg-gradient-to-r from-amber-400 via-amber-500 to-amber-600 shadow-[0_0_15px_rgba(251,191,36,0.5)]'
              : 'bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.5)]'
              }`}
            style={{ width: `${Math.min(100, Math.max(1, bondingCurveProgress))}%` }}
          />
        </div>
      </div>

      <div>
        <div className="flex justify-between text-xs mb-2">
          <span className="text-zinc-400 uppercase tracking-wider font-bold">24H MOMENTUM</span>
          <span className="text-zinc-500">
            24H Volume: {showVolumeSyncing
              ? <SyncingText />
              : (momentum?.volumeUsd || volumeUsd
                ? formatCompactUsd(momentum?.volumeUsd ?? volumeUsd)
                : `${momentum?.volumeEth || volumeEth || '0.0000'} ${pairSymbol}`)}
          </span>
        </div>
        <div className="flex justify-between text-xs mb-2">
          <span className="text-emerald-400 font-bold">{momentum?.buyPct ?? 50}% Buys</span>
          <span className="text-red-400 font-bold">{momentum?.sellPct ?? 50}% Sells</span>
        </div>
        <div className="w-full bg-zinc-950 rounded-full h-2 overflow-hidden flex border border-zinc-800">
          <div className="bg-emerald-500 h-full transition-all" style={{ width: `${momentum?.buyPct ?? 50}%` }} />
          <div className="bg-red-500 h-full transition-all" style={{ width: `${momentum?.sellPct ?? 50}%` }} />
        </div>
      </div>
    </div>
  );
}
