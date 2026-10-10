import React from "react";

export interface TopHolder {
  address: string;
  pct: number;
}

interface CabalDetectorPanelProps {
  isCabalRisk: boolean;
  topHolders: TopHolder[];
  top5Pct: number;
  creatorHoldingPct: number;
  diamondHandsHoldersPct: number;
}

export default function CabalDetectorPanel({
  isCabalRisk,
  topHolders,
  top5Pct,
  creatorHoldingPct,
  diamondHandsHoldersPct,
}: CabalDetectorPanelProps) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
      <h3 className="text-lg font-bold mb-4 text-white">Holder Clustering (Cabal Detector)</h3>

      <div className="w-full bg-zinc-950 border border-zinc-800 rounded-lg mb-6 relative overflow-hidden h-56 group">
        <svg className="absolute inset-0 w-full h-full z-0 pointer-events-none">
          {isCabalRisk ? (
            <>
              <line x1="25%" y1="30%" x2="25%" y2="70%" stroke="#ef4444" strokeWidth="2" strokeDasharray="4" className="animate-pulse opacity-60" />
              <line x1="25%" y1="70%" x2="50%" y2="85%" stroke="#ef4444" strokeWidth="2" strokeDasharray="4" className="animate-pulse opacity-60" />
              <line x1="50%" y1="85%" x2="75%" y2="70%" stroke="#ef4444" strokeWidth="2" strokeDasharray="4" className="animate-pulse opacity-60" />
              <line x1="50%" y1="85%" x2="50%" y2="50%" stroke="#ef4444" strokeWidth="1" className="opacity-30" />
            </>
          ) : (
            <>
              <line x1="50%" y1="50%" x2="25%" y2="30%" stroke="#3f3f46" strokeWidth="1" opacity="0.5" />
              <line x1="50%" y1="50%" x2="25%" y2="70%" stroke="#3f3f46" strokeWidth="1" opacity="0.5" />
              <line x1="50%" y1="50%" x2="75%" y2="30%" stroke="#3f3f46" strokeWidth="1" opacity="0.5" />
              <line x1="50%" y1="50%" x2="75%" y2="70%" stroke="#3f3f46" strokeWidth="1" opacity="0.5" />
              <line x1="50%" y1="50%" x2="50%" y2="85%" stroke="#3f3f46" strokeWidth="1" opacity="0.5" />
            </>
          )}
        </svg>

        <div className="absolute inset-0 z-10 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 bg-zinc-900 border-2 border-emerald-500/50 rounded-full flex items-center justify-center shadow-[0_0_15px_rgba(16,185,129,0.2)]">
            <span className="text-[10px] font-bold text-emerald-400">AMM</span>
          </div>

          <div className={`absolute top-[30%] left-[25%] -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full border-2 flex items-center justify-center bg-zinc-900 ${isCabalRisk ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-zinc-600'}`}>
            <span className="text-[8px] text-zinc-400">{topHolders[0] ? `${topHolders[0].pct.toFixed(1)}%` : '#1'}</span>
          </div>
          <div className={`absolute top-[70%] left-[25%] -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full border-2 flex items-center justify-center bg-zinc-900 ${isCabalRisk ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-zinc-600'}`}>
            <span className="text-[8px] text-zinc-400">{topHolders[1] ? `${topHolders[1].pct.toFixed(1)}%` : '#2'}</span>
          </div>
          <div className={`absolute top-[85%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full border-2 flex items-center justify-center bg-zinc-900 ${isCabalRisk ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-zinc-600'}`}>
            <span className="text-[8px] text-zinc-400">{topHolders[2] ? `${topHolders[2].pct.toFixed(1)}%` : '#3'}</span>
          </div>
          <div className={`absolute top-[70%] left-[75%] -translate-x-1/2 -translate-y-1/2 w-9 h-9 rounded-full border-2 flex items-center justify-center bg-zinc-900 ${isCabalRisk ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-zinc-600'}`}>
            <span className="text-[8px] text-zinc-400">{topHolders[3] ? `${topHolders[3].pct.toFixed(1)}%` : '#4'}</span>
          </div>
          <div className="absolute top-[30%] left-[75%] -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full border-2 border-zinc-600 flex items-center justify-center bg-zinc-900">
            <span className="text-[8px] text-zinc-400">{topHolders[4] ? `${topHolders[4].pct.toFixed(1)}%` : '#5'}</span>
          </div>
        </div>

        <div className="absolute top-3 left-4 bg-zinc-950/80 backdrop-blur rounded text-[10px] pointer-events-auto">
          {top5Pct > 25 ? (
            <div className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-red-500/10 text-red-500 border border-red-500/20">
              ⚠️ High Concentration ({top5Pct.toFixed(1)}% Supply)
            </div>
          ) : creatorHoldingPct === 0 ? (
            <div className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-yellow-500/10 text-yellow-500 border border-yellow-500/20">
              🚨 Supply Dumped (Insiders Exited)
            </div>
          ) : (
            <div className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-green-500/10 text-green-500 border border-green-500/20">
              ✅ Distribution Cleared
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800">
          <span className="text-zinc-500 block mb-1">Top 5 Supply</span>
          <span className={`${isCabalRisk ? 'text-red-400' : 'text-emerald-400'} font-bold`}>
            {top5Pct > 0 ? `${top5Pct.toFixed(1)}%` : '0.0%'}
          </span>
        </div>
        <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800">
          <span className="text-zinc-500 block mb-1">Sniper Retention</span>
          <span className={diamondHandsHoldersPct < 30 ? "text-red-400 font-bold" : "text-yellow-400 font-bold"}>
            {100 - diamondHandsHoldersPct}% Dumped
          </span>
        </div>
      </div>
    </div>
  );
}
