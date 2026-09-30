"use client";

import { useState, useMemo } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract, useReadContracts } from "wagmi";

// Token-gating contract
const SIGNAL_TOKEN = "0x000000000000000000000000000000000000dEaD";

// The real testnet contracts we are tracking
const TRACKED_ADDRESSES = [
  "0xA48964DA07300E6Ae6754Ce265873F8F59F4a9F6",
  "0x336D221D697Fee3B8AB08Bf101dFC0dBe332d701",
  "0x1234567890123456789012345678901234567892",
] as const;

// Minimal ABI to fetch the required on-chain data
const ERC20_ABI = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }
] as const;

interface VibeToken {
  id: string;
  name: string;
  ticker: string;
  contractAddress: string;
  bondingCurveProgress: number;
  timeSinceLaunchMins: number;
  blockZeroBuyers: number;
  diamondHandsHoldersPct: number;
  totalSupply: number;
  score: number;
}

function calculateVibeScore(
  blockZeroBuyers: number, 
  timeSinceLaunchMins: number, 
  bondingCurveProgress: number, 
  diamondHandsHoldersPct: number
) {
  let score = 50;
  if (blockZeroBuyers > 15) score -= 25;
  if (timeSinceLaunchMins > 90 && bondingCurveProgress > 40) score += 20;
  if (timeSinceLaunchMins < 15 && bondingCurveProgress > 70) score -= 20;
  if (diamondHandsHoldersPct >= 40) score += 15;
  return Math.max(1, Math.min(99, score));
}

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function Home() {
  const { address, isConnected } = useAccount();
  const [demoBypass, setDemoBypass] = useState(false);
  const [activeFilter, setActiveFilter] = useState<"all" | "alpha" | "graduating" | "risk">("all");

  // Read gating token balance
  const { data: balanceData } = useReadContract({
    address: SIGNAL_TOKEN,
    abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: address ? [address] : undefined,
  });

  const hasAccess = demoBypass || (balanceData && BigInt(balanceData as any) >= BigInt("10000") * (BigInt("10") ** BigInt("18")));
  // Setup multiple contract reads for the live tracked addresses
  const contractCalls = TRACKED_ADDRESSES.flatMap((addr) => [
    { address: addr, abi: ERC20_ABI, functionName: "name" },
    { address: addr, abi: ERC20_ABI, functionName: "symbol" },
    { address: addr, abi: ERC20_ABI, functionName: "totalSupply" }
  ]);

  const { data: onChainData, isLoading } = useReadContracts({
    contracts: contractCalls as any,
  });

  // Combine live on-chain data with simulated machine-learning metrics
  const processedTokens: VibeToken[] = useMemo(() => {
    if (!onChainData) return [];
    
    const tokens: VibeToken[] = [];
    // Hardcoded simulation metrics representing the future machine-learning indexer output
    const simMetrics = [
      { curve: 92, time: 140, block0: 2, diamond: 45 },
      { curve: 40, time: 10, block0: 35, diamond: 10 },
      { curve: 60, time: 300, block0: 5, diamond: 55 }
    ];

    for (let i = 0; i < TRACKED_ADDRESSES.length; i++) {
      const name = onChainData[i * 3]?.result as string || `Unknown Token ${i + 1}`;
      const ticker = onChainData[i * 3 + 1]?.result as string || "$UNKN";
      const rawSupply = onChainData[i * 3 + 2]?.result as bigint;
      const totalSupply = rawSupply ? Number(rawSupply / (BigInt("10") ** BigInt("18"))) : 1000000000;      
      const metrics = simMetrics[i];
      const score = calculateVibeScore(metrics.block0, metrics.time, metrics.curve, metrics.diamond);

      tokens.push({
        id: i.toString(),
        name,
        ticker,
        contractAddress: TRACKED_ADDRESSES[i],
        bondingCurveProgress: metrics.curve,
        timeSinceLaunchMins: metrics.time,
        blockZeroBuyers: metrics.block0,
        diamondHandsHoldersPct: metrics.diamond,
        totalSupply,
        score
      });
    }
    return tokens;
  }, [onChainData]);

  // Apply the selected filter
  const filteredTokens = useMemo(() => {
    switch (activeFilter) {
      case "alpha": return processedTokens.filter(t => t.score >= 70);
      case "graduating": return processedTokens.filter(t => t.bondingCurveProgress >= 85);
      case "risk": return processedTokens.filter(t => t.score < 45 || t.blockZeroBuyers > 15);
      default: return processedTokens;
    }
  }, [processedTokens, activeFilter]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-mono">
      <nav className="flex justify-between items-center p-4 border-b border-zinc-800 bg-zinc-900/50 sticky top-0 z-50">
        <div>
          <h1 className="text-xl font-bold text-emerald-400">Vibe Signals</h1>
          <span className="text-xs text-zinc-500">Robinhood Chain Testnet</span>
        </div>
        <ConnectButton />
      </nav>

      <main className="p-8 max-w-5xl mx-auto">
        <header className="mb-8">
          <h2 className="text-3xl font-bold tracking-tight mb-2">Live On-Chain Radar</h2>
          <p className="text-zinc-400">Querying real-time bonding curves and accumulating signals.</p>
        </header>

        {/* Filtering Navigation */}
        <div className="flex gap-2 mb-8 border-b border-zinc-800 pb-4 overflow-x-auto">
          <button onClick={() => setActiveFilter("all")} className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeFilter === "all" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-white hover:bg-zinc-800/50"}`}>
            All Launches
          </button>
          <button onClick={() => setActiveFilter("alpha")} className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeFilter === "alpha" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "text-zinc-500 hover:text-emerald-400 hover:bg-emerald-500/10"}`}>
            High Alpha (Score ≥ 70)
          </button>
          <button onClick={() => setActiveFilter("graduating")} className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeFilter === "graduating" ? "bg-blue-500/20 text-blue-400 border border-blue-500/30" : "text-zinc-500 hover:text-blue-400 hover:bg-blue-500/10"}`}>
            Graduating Soon (&gt;85%)
          </button>
          <button onClick={() => setActiveFilter("risk")} className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeFilter === "risk" ? "bg-red-500/20 text-red-400 border border-red-500/30" : "text-zinc-500 hover:text-red-400 hover:bg-red-500/10"}`}>
            High Risk / Sniped
          </button>
        </div>

        {isLoading ? (
          <div className="text-center py-12 text-zinc-500 animate-pulse">Querying testnet nodes...</div>
        ) : filteredTokens.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 border border-dashed border-zinc-800 rounded-xl">No tokens match this filter.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredTokens.map((token) => {
              const scoreColor = token.score >= 70 ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/10" : token.score >= 45 ? "text-yellow-400 border-yellow-400/30 bg-yellow-400/10" : "text-red-400 border-red-400/30 bg-red-400/10";
              
              return (
                <div key={token.id} className="relative border border-zinc-800 bg-zinc-900 rounded-xl p-6 overflow-hidden flex flex-col justify-between">
                  <div>
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h3 className="font-bold text-lg">{token.name}</h3>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-zinc-400">{token.ticker}</span>
                          <span className="text-xs px-2 py-1 bg-zinc-800 rounded-md text-zinc-500">{shortenAddress(token.contractAddress)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="mb-6">
                      <div className="flex justify-between text-xs mb-2">
                        <span className="text-zinc-500">Bonding Curve</span>
                        <span className={token.bondingCurveProgress > 85 ? "text-emerald-400" : "text-zinc-300"}>{token.bondingCurveProgress}%</span>
                      </div>
                      <div className="w-full bg-zinc-800 rounded-full h-2">
                        <div className={`h-2 rounded-full ${token.bondingCurveProgress > 85 ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]" : "bg-zinc-500"}`} style={{ width: `${token.bondingCurveProgress}%` }} />
                      </div>
                    </div>
                  </div>

                  {/* Gated Content Area */}
                  <div className="relative">
                    {(!isConnected || !hasAccess) && (
                      <div className="absolute inset-0 z-10 backdrop-blur-md bg-zinc-950/60 flex flex-col items-center justify-center rounded-lg border border-zinc-800">
                        {!isConnected ? (
                          <span className="text-sm font-bold text-zinc-300">Connect Wallet to Unlock</span>
                        ) : (
                          <div className="text-center p-2">
                            <span className="text-xs font-bold text-emerald-400 block mb-1">Requires 10,000 $SIGNAL</span>
                            <a href="https://testnet.vibevibe.fun" target="_blank" rel="noreferrer" className="text-[10px] underline text-zinc-400 hover:text-white">Acquire Token</a>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="border border-zinc-800 bg-zinc-950/50 rounded-lg p-4 mb-4">
                      <div className="flex justify-between items-center mb-3">
                        <span className="text-sm text-zinc-400">Vibe Score</span>
                        <span className={`text-xl font-bold px-3 py-1 rounded-md border ${scoreColor}`}>{token.score}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-zinc-400">SPARK Adjusted Supply</span>
                        <span className="text-sm font-medium">{(token.totalSupply * 0.75).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>

                  <a 
                    href={`https://testnet.vibevibe.fun/token/${token.contractAddress}`} 
                    target="_blank" 
                    rel="noreferrer" 
                    className="w-full py-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-lg text-center text-sm transition-colors mt-auto block"
                  >
                    View on vibe/vibe
                  </a>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Developer Toggle */}
      <button 
        onClick={() => setDemoBypass(!demoBypass)}
        className="fixed bottom-4 right-4 bg-zinc-800 text-zinc-400 text-xs px-3 py-1 rounded-full border border-zinc-700 hover:text-white"
      >
        Preview: {demoBypass ? "Gating Disabled" : "Gating Active"}
      </button>
    </div>
  );
}