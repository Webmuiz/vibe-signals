import React from "react";

export type RadarFilter = "all" | "alpha" | "graduating" | "risk";

interface RadarHeaderProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  activeFilter: RadarFilter;
  onFilterChange: (filter: RadarFilter) => void;
}

export default function RadarHeader({
  searchQuery,
  onSearchChange,
  activeFilter,
  onFilterChange,
}: RadarHeaderProps) {
  return (
    <>
      <header className="mb-8">
        <h2 className="text-3xl font-bold tracking-tight mb-2">Live On-Chain Radar</h2>
        <p className="text-zinc-400">Querying real-time bonding curves and accumulating signals.</p>
      </header>

      <div className="flex gap-4 mb-8">
        <input
          type="text"
          placeholder="Search by contract (0x...)"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-emerald-500 transition-colors shadow-inner text-white max-w-md"
        />
      </div>

      <div className="flex gap-2 mb-8 border-b border-zinc-800 pb-4 overflow-x-auto">
        <button onClick={() => onFilterChange("all")} className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeFilter === "all" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-white hover:bg-zinc-800/50"}`}>
          All Launches
        </button>
        <button onClick={() => onFilterChange("alpha")} className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeFilter === "alpha" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "text-zinc-500 hover:text-emerald-400 hover:bg-emerald-500/10"}`}>
          High Alpha (Score ≥ 70)
        </button>
        <button onClick={() => onFilterChange("graduating")} className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeFilter === "graduating" ? "bg-blue-500/20 text-blue-400 border border-blue-500/30" : "text-zinc-500 hover:text-blue-400 hover:bg-blue-500/10"}`}>
          Graduating Soon ({'>'}85%)
        </button>
        <button onClick={() => onFilterChange("risk")} className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeFilter === "risk" ? "bg-red-500/20 text-red-400 border border-red-500/30" : "text-zinc-500 hover:text-red-400 hover:bg-red-500/10"}`}>
          High Risk / Sniped
        </button>
      </div>
    </>
  );
}
