import React from "react";
import type {
  CabalAnalysisResult,
  CabalRiskLevel,
  ClusterEdge,
  ClusterNode,
} from "@/lib/analytics/cabalDetector";

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
  /**
   * Optional persisted cluster analysis from `/api/analytics/cabal`.
   * Purely additive: when absent the panel renders exactly as before.
   */
  cabalResult?: CabalAnalysisResult | null;
}

const RISK_TEXT_COLOR: Record<CabalRiskLevel, string> = {
  CRITICAL: 'text-red-500',
  HIGH: 'text-red-500',
  MEDIUM: 'text-yellow-500',
  LOW: 'text-green-500',
};

const RISK_BADGE_COLOR: Record<CabalRiskLevel, string> = {
  CRITICAL: 'bg-red-500/10 text-red-500 border-red-500/20',
  HIGH: 'bg-red-500/10 text-red-500 border-red-500/20',
  MEDIUM: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
  LOW: 'bg-green-500/10 text-green-500 border-green-500/20',
};

function normalizeRiskLevel(value: unknown): CabalRiskLevel | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  if (upper === 'CRITICAL' || upper === 'HIGH' || upper === 'MEDIUM' || upper === 'LOW') {
    return upper;
  }
  return null;
}

interface ParsedGraph {
  nodes: ClusterNode[];
  edges: ClusterEdge[];
}

/**
 * Parse `clusterGraphJson` defensively. Returns null unless the payload is a
 * usable `{ nodes, edges }` document with at least one valid node — anything
 * malformed falls back to the hardcoded graph.
 */
function parseClusterGraph(raw: unknown): ParsedGraph | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const candidate = parsed as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) return null;

  const nodes: ClusterNode[] = candidate.nodes
    .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
    .filter((n) => typeof n.id === 'string' && n.id.length > 0)
    .map((n) => ({
      id: String(n.id),
      label: typeof n.label === 'string' && n.label.length > 0 ? n.label : String(n.id),
      balancePct: Number.isFinite(Number(n.balancePct)) ? Number(n.balancePct) : 0,
      isClusterMember: n.isClusterMember === true,
    }));

  if (nodes.length === 0) return null;

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: ClusterEdge[] = candidate.edges
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .filter(
      (e) =>
        typeof e.source === 'string' &&
        typeof e.target === 'string' &&
        nodeIds.has(e.source) &&
        nodeIds.has(e.target)
    )
    .map((e) => ({
      source: String(e.source),
      target: String(e.target),
      type: e.type === 'DIRECT_TRANSFER' ? 'DIRECT_TRANSFER' : 'FUNDED_BY',
    }));

  return { nodes, edges };
}

/**
 * Deterministic radial layout: the largest holder sits at the centre (the
 * "hub" the AMM node used to occupy) and the rest are distributed evenly
 * around it. Positions are percentages so they map straight onto the
 * absolutely-positioned container.
 */
function layoutNodes(nodes: ClusterNode[]): Array<ClusterNode & { x: number; y: number }> {
  const sorted = [...nodes].sort((a, b) => b.balancePct - a.balancePct);
  const hub = sorted[0];
  const ring = sorted.slice(1);

  const positioned: Array<ClusterNode & { x: number; y: number }> = [
    { ...hub, x: 50, y: 50 },
  ];

  ring.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, ring.length) - Math.PI / 2;
    const radiusX = 34;
    const radiusY = 30;
    positioned.push({
      ...node,
      x: 50 + Math.cos(angle) * radiusX,
      y: 50 + Math.sin(angle) * radiusY,
    });
  });

  return positioned;
}

export default function CabalDetectorPanel({
  isCabalRisk,
  topHolders,
  top5Pct,
  creatorHoldingPct,
  diamondHandsHoldersPct,
  cabalResult,
}: CabalDetectorPanelProps) {
  // Live analysis is only usable when present, not flagged unavailable, and
  // carries a recognised risk level. Everything else degrades to the original
  // hardcoded visualisation.
  const live =
    cabalResult && typeof cabalResult === 'object' && !cabalResult.isUnavailable
      ? cabalResult
      : null;
  const liveRisk = live ? normalizeRiskLevel(live.riskLevel) : null;
  const hasLiveVerdict = !!live && liveRisk !== null;

  const graph = live ? parseClusterGraph(live.clusterGraphJson) : null;
  const useLiveGraph = !!graph && graph.nodes.length > 0;

  const positioned = useLiveGraph ? layoutNodes(graph!.nodes) : [];
  const positionById = new Map(positioned.map((n) => [n.id, n]));

  // Effective risk flag drives the fallback graph's colouring.
  const effectiveRisk = hasLiveVerdict
    ? liveRisk === 'HIGH' || liveRisk === 'CRITICAL'
    : isCabalRisk;

  const displayTop5 = hasLiveVerdict ? live!.cabalSupplyPct : top5Pct;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-bold text-white">Holder Clustering (Cabal Detector)</h3>
        {hasLiveVerdict && (
          <span
            className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${RISK_BADGE_COLOR[liveRisk as CabalRiskLevel]}`}
          >
            {liveRisk} RISK
          </span>
        )}
      </div>

      <div className="w-full bg-zinc-950 border border-zinc-800 rounded-lg mb-6 relative overflow-hidden h-56 group">
        <svg className="absolute inset-0 w-full h-full z-0 pointer-events-none">
          {useLiveGraph ? (
            graph!.edges.map((edge, i) => {
              const source = positionById.get(edge.source);
              const target = positionById.get(edge.target);
              if (!source || !target) return null;
              const isTransfer = edge.type === 'DIRECT_TRANSFER';
              return (
                <line
                  key={`${edge.source}-${edge.target}-${i}`}
                  x1={`${source.x}%`}
                  y1={`${source.y}%`}
                  x2={`${target.x}%`}
                  y2={`${target.y}%`}
                  stroke={effectiveRisk ? '#ef4444' : '#3f3f46'}
                  strokeWidth={isTransfer ? 1 : 2}
                  strokeDasharray={isTransfer ? '4' : undefined}
                  className={effectiveRisk ? 'animate-pulse opacity-60' : 'opacity-50'}
                />
              );
            })
          ) : effectiveRisk ? (
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
          {useLiveGraph ? (
            positioned.map((node, i) => {
              const isHub = i === 0;
              const size = isHub ? 'w-12 h-12' : node.isClusterMember ? 'w-9 h-9' : 'w-7 h-7';
              const border = node.isClusterMember
                ? effectiveRisk
                  ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]'
                  : 'border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.2)]'
                : 'border-zinc-600';
              return (
                <div
                  key={node.id}
                  title={`${node.label} — ${node.balancePct.toFixed(2)}%`}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 ${size} rounded-full border-2 flex items-center justify-center bg-zinc-900 ${border}`}
                  style={{ top: `${node.y}%`, left: `${node.x}%` }}
                >
                  <span className="text-[8px] text-zinc-400">{node.balancePct.toFixed(1)}%</span>
                </div>
              );
            })
          ) : (
            <>
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 bg-zinc-900 border-2 border-emerald-500/50 rounded-full flex items-center justify-center shadow-[0_0_15px_rgba(16,185,129,0.2)]">
                <span className="text-[10px] font-bold text-emerald-400">AMM</span>
              </div>

              <div className={`absolute top-[30%] left-[25%] -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full border-2 flex items-center justify-center bg-zinc-900 ${effectiveRisk ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-zinc-600'}`}>
                <span className="text-[8px] text-zinc-400">{topHolders[0] ? `${topHolders[0].pct.toFixed(1)}%` : '#1'}</span>
              </div>
              <div className={`absolute top-[70%] left-[25%] -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full border-2 flex items-center justify-center bg-zinc-900 ${effectiveRisk ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-zinc-600'}`}>
                <span className="text-[8px] text-zinc-400">{topHolders[1] ? `${topHolders[1].pct.toFixed(1)}%` : '#2'}</span>
              </div>
              <div className={`absolute top-[85%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full border-2 flex items-center justify-center bg-zinc-900 ${effectiveRisk ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-zinc-600'}`}>
                <span className="text-[8px] text-zinc-400">{topHolders[2] ? `${topHolders[2].pct.toFixed(1)}%` : '#3'}</span>
              </div>
              <div className={`absolute top-[70%] left-[75%] -translate-x-1/2 -translate-y-1/2 w-9 h-9 rounded-full border-2 flex items-center justify-center bg-zinc-900 ${effectiveRisk ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-zinc-600'}`}>
                <span className="text-[8px] text-zinc-400">{topHolders[3] ? `${topHolders[3].pct.toFixed(1)}%` : '#4'}</span>
              </div>
              <div className="absolute top-[30%] left-[75%] -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full border-2 border-zinc-600 flex items-center justify-center bg-zinc-900">
                <span className="text-[8px] text-zinc-400">{topHolders[4] ? `${topHolders[4].pct.toFixed(1)}%` : '#5'}</span>
              </div>
            </>
          )}
        </div>

        <div className="absolute top-3 left-4 bg-zinc-950/80 backdrop-blur rounded text-[10px] pointer-events-auto">
          {hasLiveVerdict ? (
            <div className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border ${RISK_BADGE_COLOR[liveRisk as CabalRiskLevel]}`}>
              {effectiveRisk ? '⚠️' : '✅'} Cabal Supply {live!.cabalSupplyPct.toFixed(1)}% · {liveRisk}
            </div>
          ) : displayTop5 > 25 ? (
            <div className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-red-500/10 text-red-500 border border-red-500/20">
              ⚠️ High Concentration ({displayTop5.toFixed(1)}% Supply)
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
          <span className="text-zinc-500 block mb-1">{hasLiveVerdict ? 'Cabal Supply' : 'Top 5 Supply'}</span>
          <span className={`${effectiveRisk ? 'text-red-400' : 'text-emerald-400'} font-bold`}>
            {displayTop5 > 0 ? `${displayTop5.toFixed(1)}%` : '0.0%'}
          </span>
        </div>
        {hasLiveVerdict ? (
          <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800">
            <span className="text-zinc-500 block mb-1">Clustered Wallets</span>
            <span className={`${effectiveRisk ? 'text-red-400' : 'text-emerald-400'} font-bold`}>
              {live!.clusteredWallets} / {live!.totalAnalyzedWallets}
            </span>
          </div>
        ) : (
          <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800">
            <span className="text-zinc-500 block mb-1">Sniper Retention</span>
            <span className={diamondHandsHoldersPct < 30 ? "text-red-400 font-bold" : "text-yellow-400 font-bold"}>
              {100 - diamondHandsHoldersPct}% Dumped
            </span>
          </div>
        )}
      </div>

      {hasLiveVerdict && (
        <div className="mt-4 flex justify-between items-center text-xs">
          <span className="text-zinc-500">Risk Level</span>
          <span className={`font-bold ${RISK_TEXT_COLOR[liveRisk as CabalRiskLevel]}`}>{liveRisk}</span>
        </div>
      )}
    </div>
  );
}
