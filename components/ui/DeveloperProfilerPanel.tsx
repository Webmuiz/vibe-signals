import React from "react";
import { shortenAddress } from "@/lib/tokenMetrics";

export interface DevProfile {
  launches: number;
  gradRate: number;
}

export interface DevStats {
  launches: number;
  gradRate: number;
}

interface DeveloperProfilerPanelProps {
  devAddress: string;
  badgeText: string;
  badgeColor: string;
  devStats: DevStats | null;
  devProfile: DevProfile;
}

export default function DeveloperProfilerPanel({
  devAddress,
  badgeText,
  badgeColor,
  devStats,
  devProfile,
}: DeveloperProfilerPanelProps) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
      <div className="flex justify-between items-start mb-4">
        <h3 className="text-lg font-bold text-white">Developer Profiler</h3>
        <div className={`px-2 py-1 text-[10px] font-bold tracking-wider uppercase border rounded ${badgeColor}`}>
          {badgeText}
        </div>
      </div>
      <div className="flex items-center gap-2 mb-6">
        <a
          href={`https://testnet.vibevibe.fun/profile/${devAddress}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs px-3 py-1.5 bg-zinc-950 border border-zinc-800 rounded hover:border-emerald-500/50 hover:text-white text-zinc-400 font-mono transition-colors"
        >
          Creator: {shortenAddress(devAddress)} ↗
        </a>
      </div>
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800">
          <span className="text-zinc-500 block mb-1">Total Launches</span>
          <span className="text-white font-bold">
            {devStats ? `${devStats.launches} Tokens` : `${devProfile.launches} Tokens`}
          </span>
        </div>
        <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800">
          <span className="text-zinc-500 block mb-1">Graduation Rate</span>
          <span className={(devStats ? devStats.gradRate : devProfile.gradRate) > 50 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>{devStats ? `${devStats.gradRate}%` : `${devProfile.gradRate}%`}</span>
        </div>
      </div>
    </div>
  );
}
