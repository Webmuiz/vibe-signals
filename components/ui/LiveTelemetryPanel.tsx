import React from "react";
import { formatTimeLive } from "@/lib/tokenMetrics";

export interface TelemetryMomentum {
  buyPct?: number;
  sellPct?: number;
  volumeEth?: string | number;
  volumeUsd?: string | number;
}

interface LiveTelemetryPanelProps {
  isSyncingLive: boolean;
  timeSinceLaunchMins: number;
  bondingCurveProgress: number;
  ethDeposited: number | string;
  pairSymbol: string;
  marketCapUsd?: string;
  momentum?: TelemetryMomentum;
  volumeUsd?: string | number;
  volumeEth?: string | number;
}

export default function LiveTelemetryPanel({
  isSyncingLive,
  timeSinceLaunchMins,
  bondingCurveProgress,
  ethDeposited,
  pairSymbol,
  marketCapUsd,
  momentum,
  volumeUsd,
  volumeEth,
}: LiveTelemetryPanelProps) {
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
            <span className="text-zinc-400 font-mono">MC: {isSyncingLive ? <span className="animate-pulse">...</span> : (marketCapUsd || "$0.00")}</span>
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
          <span className="text-zinc-500">24H Volume: {isSyncingLive ? <span className="animate-pulse">...</span> : (momentum?.volumeUsd || volumeUsd || `${momentum?.volumeEth || volumeEth || '0.0000'} ${pairSymbol}`)}</span>
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
