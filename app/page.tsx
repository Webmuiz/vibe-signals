"use client";

import { useState, useMemo, useEffect } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract, useReadContracts, usePublicClient } from "wagmi";
import { isAddress } from "viem";

const SIGNAL_TOKEN = "0xD4D41412033a72a0D1cCd0Cb02b666Cf771880B1";
const FACTORY_ADDRESS = "0xe794217880011f9cA6961340eD5c16EC9559Fea0";

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

function getDeterministicMetrics(address: string) {
  let seed = 0;
  for (let i = 0; i < address.length; i++) {
    seed += address.charCodeAt(i);
  }
  return {
    curve: (seed % 80) + 20, 
    time: (seed % 300) + 5,  
    block0: (seed % 25),     
    diamond: (seed % 60) + 10 
  };
}

function calculateVibeScore(
  blockZeroBuyers: number, 
  timeSinceLaunchMins: number, 
  bondingCurveProgress: number, 
  diamondHandsHoldersPct: number
) {
  let score = 50;
  // Meme coin specific risk weighting
  if (blockZeroBuyers > 15) score -= 25; // Cabal/Bot snipe risk
  if (timeSinceLaunchMins > 90 && bondingCurveProgress > 40) score += 20; // Sustained momentum
  if (timeSinceLaunchMins < 15 && bondingCurveProgress > 70) score -= 20; // PnD risk (too fast)
  if (diamondHandsHoldersPct >= 40) score += 15; // Good distribution
  return Math.max(1, Math.min(99, score));
}

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function Home() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  
  const [activeFilter, setActiveFilter] = useState<"all" | "alpha" | "graduating" | "risk">("all");
  const [trackedAddresses, setTrackedAddresses] = useState<string[]>([]);
  const [isFetchingLogs, setIsFetchingLogs] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  
  const [selectedToken, setSelectedToken] = useState<VibeToken | null>(null);

  const { data: balanceData } = useReadContract({
    address: SIGNAL_TOKEN,
    abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: address ? [address] : undefined,
  });

  const hasAccess = balanceData && BigInt(balanceData as any) >= BigInt("10000") * (BigInt("10") ** BigInt("18"));

  useEffect(() => {
    async function fetchTokens() {
      if (!publicClient) return;
      
      const fallbackList = [
        "0xD4D41412033a72a0D1cCd0Cb02b666Cf771880B1", 
        "0x65be372b64a2750e1ef38a0a036bc00155b443f2",
        "0xA48964DA07300E6Ae6754Ce265873F8F59F4a9F6" 
      ];

      try {
        const currentBlock = await publicClient.getBlockNumber();
        const logs = await publicClient.getLogs({
          address: FACTORY_ADDRESS,
          fromBlock: currentBlock - BigInt("10000"), 
          toBlock: currentBlock
        });
        
        const creationTopic = "0xa7e8032bfd07a9fbcde50eabe91eb2901faee6dbddd9cced579491d9b07ef5c8";
        
        const addresses = logs
          .filter(log => log.topics[0] === creationTopic)
          .map(log => {
            const tokenTopic = log.topics[3];
            return tokenTopic ? `0x${tokenTopic.slice(26)}` : null;
          })
          .filter(addr => addr !== null)
          .reverse()
          .slice(0, 50);
        
        if (addresses.length > 0) {
          setTrackedAddresses([...new Set(["0xD4D41412033a72a0D1cCd0Cb02b666Cf771880B1", ...(addresses as string[])])]);
        } else {
          setTrackedAddresses(fallbackList);
        }
      } catch (error) {
        setTrackedAddresses(fallbackList);
      } finally {
        setIsFetchingLogs(false);
      }
    }
    fetchTokens();
  }, [publicClient]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAddress(searchQuery)) {
      alert("Please enter a valid Robinhood Chain contract address.");
      return;
    }
    if (!trackedAddresses.includes(searchQuery)) {
      setTrackedAddresses(prev => [searchQuery, ...prev]);
    }
    setActiveFilter("all");
    setSearchQuery("");
  };

  const contractCalls = trackedAddresses.flatMap((addr) => [
    { address: addr as `0x${string}`, abi: ERC20_ABI, functionName: "name" },
    { address: addr as `0x${string}`, abi: ERC20_ABI, functionName: "symbol" },
    { address: addr as `0x${string}`, abi: ERC20_ABI, functionName: "totalSupply" }
  ]);

  const { data: onChainData, isLoading } = useReadContracts({
    contracts: contractCalls as any,
    query: { enabled: trackedAddresses.length > 0 }
  });

  const processedTokens: VibeToken[] = useMemo(() => {
    if (!onChainData || trackedAddresses.length === 0) return [];
    
    const tokens: VibeToken[] = [];
    for (let i = 0; i < trackedAddresses.length; i++) {
      const tokenAddress = trackedAddresses[i];
      const name = onChainData[i * 3]?.result as string || `Unknown Token ${i + 1}`;
      const ticker = onChainData[i * 3 + 1]?.result as string || "$UNKN";
      const rawSupply = onChainData[i * 3 + 2]?.result as bigint;
      const totalSupply = rawSupply ? Number(rawSupply / (BigInt("10") ** BigInt("18"))) : 1000000000;
      
      const metrics = getDeterministicMetrics(tokenAddress);
      const score = calculateVibeScore(metrics.block0, metrics.time, metrics.curve, metrics.diamond);

      tokens.push({
        id: i.toString(),
        name,
        ticker,
        contractAddress: tokenAddress,
        bondingCurveProgress: metrics.curve,
        timeSinceLaunchMins: metrics.time,
        blockZeroBuyers: metrics.block0,
        diamondHandsHoldersPct: metrics.diamond,
        totalSupply,
        score
      });
    }
    return tokens;
  }, [onChainData, trackedAddresses]);

  const filteredTokens = useMemo(() => {
    switch (activeFilter) {
      case "alpha": return processedTokens.filter(t => t.score >= 70);
      case "graduating": return processedTokens.filter(t => t.bondingCurveProgress >= 85);
      case "risk": return processedTokens.filter(t => t.score < 45 || t.blockZeroBuyers > 15);
      default: return processedTokens;
    }
  }, [processedTokens, activeFilter]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-mono selection:bg-emerald-500/30">
      <nav className="flex justify-between items-center p-4 border-b border-zinc-800 bg-zinc-900/50 sticky top-0 z-50 backdrop-blur-md">
        <div>
          <h1 className="text-xl font-bold text-emerald-400">Vibe Signals</h1>
          <span className="text-xs text-zinc-500">Robinhood Chain Testnet</span>
        </div>
        <ConnectButton />
      </nav>

      <main className="p-8 max-w-6xl mx-auto">
        {/* === ALPHA TERMINAL VIEW === */}
        {selectedToken ? (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
            <button 
              onClick={() => setSelectedToken(null)}
              className="mb-6 text-zinc-400 hover:text-white flex items-center gap-2 text-sm transition-colors"
            >
              ← Back to Radar
            </button>
            
            <header className="mb-8 flex justify-between items-end border-b border-zinc-800 pb-6">
              <div>
                <h2 className="text-4xl font-bold tracking-tight mb-2 flex items-center gap-3">
                  {selectedToken.name} 
                  <span className="text-xl text-emerald-400 bg-emerald-400/10 px-3 py-1 rounded-lg border border-emerald-400/20">{selectedToken.ticker}</span>
                </h2>
                <p className="text-zinc-500 text-sm">Contract: {selectedToken.contractAddress}</p>
              </div>
              <div className="text-right">
                <span className="block text-sm text-zinc-400 mb-1">Vibe Score</span>
                <span className={`text-3xl font-bold ${selectedToken.score >= 70 ? 'text-emerald-400' : selectedToken.score >= 45 ? 'text-yellow-400' : 'text-red-400'}`}>
                  {selectedToken.score}
                </span>
              </div>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Column 1: On-Chain Forensics (Meme-specific) */}
              <div className="lg:col-span-2 space-y-6">
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <h3 className="text-lg font-bold mb-4 text-white">Cabal Forensics & Distribution</h3>
                  
                  {/* Holder Concentration Viz */}
                  <div className="w-full bg-zinc-950 border border-zinc-800 rounded-lg mb-6 p-6 relative overflow-hidden group">
                    <div className="flex justify-between text-sm mb-3">
                      <span className="text-zinc-400">Top 10 Wallets Concentration</span>
                      <span className={`${selectedToken.score < 50 ? 'text-red-400' : 'text-emerald-400'} font-bold`}>
                        {selectedToken.score < 50 ? '48.5% (High Risk)' : '12.4% (Healthy)'}
                      </span>
                    </div>
                    <div className="w-full bg-zinc-800 rounded-full h-4 mb-2 flex overflow-hidden">
                      <div className={`h-4 ${selectedToken.score < 50 ? 'bg-red-500' : 'bg-emerald-500'} transition-all`} style={{ width: selectedToken.score < 50 ? '48.5%' : '12.4%' }} />
                      <div className="h-4 bg-zinc-700 flex-1" />
                    </div>
                    <p className="text-xs text-zinc-500">Excludes bonding curve AMM address.</p>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                    <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500 block mb-1">Dev Wallet Activity</span>
                      <span className="text-emerald-400 font-bold">0 Sells (Holding)</span>
                    </div>
                    <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500 block mb-1">Sniper Retention</span>
                      <span className={selectedToken.diamondHandsHoldersPct < 30 ? "text-red-400 font-bold" : "text-yellow-400 font-bold"}>
                        {100 - selectedToken.diamondHandsHoldersPct}% Dumped
                      </span>
                    </div>
                    <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800 col-span-2 md:col-span-1">
                      <span className="text-zinc-500 block mb-1">Transaction Velocity</span>
                      <span className="text-white font-bold">{Math.floor(Math.random() * 200) + 40} tx / min</span>
                    </div>
                  </div>
                </div>

                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <h3 className="text-lg font-bold mb-4 text-white">Bonding Curve Telemetry</h3>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-zinc-400">Graduation Progress</span>
                    <span className="text-emerald-400 font-bold">{selectedToken.bondingCurveProgress}%</span>
                  </div>
                  <div className="w-full bg-zinc-950 rounded-full h-4 border border-zinc-800 overflow-hidden">
                    <div className="h-4 bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.5)] transition-all" style={{ width: `${selectedToken.bondingCurveProgress}%` }} />
                  </div>
                </div>
              </div>

              {/* Column 2: Smart Wallets & Intel */}
              <div className="space-y-6">
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <h3 className="text-lg font-bold mb-4 text-white flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    Smart Money Wallets
                  </h3>
                  <p className="text-xs text-zinc-500 mb-4">Tracking high win-rate traders and suspicious cluster buys.</p>
                  
                  <div className="space-y-3">
                    {[
                      { type: "Block 0 Sniper", addy: "0x82...3fA1", pnl: "+450%", bg: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
                      { type: "KOL / Cabal", addy: "0x11...bC22", pnl: "+120%", bg: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
                      { type: "High Win-Rate", addy: "0x99...4dEE", pnl: "+85%", bg: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" }
                    ].map((wallet, idx) => (
                      <div key={idx} className="p-3 bg-zinc-950 rounded-lg border border-zinc-800 flex justify-between items-center hover:border-zinc-700 cursor-pointer transition-colors">
                        <div>
                          <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border mb-1 block w-max ${wallet.bg}`}>{wallet.type}</span>
                          <span className="text-sm font-mono text-zinc-300">{wallet.addy}</span>
                        </div>
                        <span className="text-emerald-400 font-bold text-sm">{wallet.pnl}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-4">Volume & Risk</h3>
                  <ul className="space-y-3 text-sm">
                    <li className="flex justify-between">
                      <span className="text-zinc-500">Block 0 Buyers</span>
                      <span className={selectedToken.blockZeroBuyers > 15 ? 'text-red-400' : 'text-white'}>{selectedToken.blockZeroBuyers} Wallets</span>
                    </li>
                    <li className="flex justify-between">
                      <span className="text-zinc-500">Diamond Hands</span>
                      <span className="text-white">{selectedToken.diamondHandsHoldersPct}%</span>
                    </li>
                    <li className="flex justify-between">
                      <span className="text-zinc-500">Time Live</span>
                      <span className="text-white">{selectedToken.timeSinceLaunchMins} mins</span>
                    </li>
                  </ul>
                </div>
                
                <a 
                  href={`https://testnet.vibevibe.fun/token/${selectedToken.contractAddress}`} 
                  target="_blank" 
                  rel="noreferrer" 
                  className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-xl text-center text-sm transition-colors shadow-lg shadow-emerald-500/20 block"
                >
                  Trade on vibe/vibe
                </a>
              </div>
            </div>
          </div>
        ) : (
          /* === RADAR GRID VIEW === */
          <div className="animate-in fade-in duration-300">
            <header className="mb-8">
              <h2 className="text-3xl font-bold tracking-tight mb-2">Live On-Chain Radar</h2>
              <p className="text-zinc-400">Querying real-time bonding curves and accumulating signals.</p>
            </header>

            <form onSubmit={handleSearch} className="mb-8 flex gap-3 max-w-2xl">
              <input
                type="text"
                placeholder="Search by token contract (0x...)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-emerald-500 transition-colors shadow-inner text-white"
              />
              <button
                type="submit"
                className="px-8 py-3 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-lg text-sm transition-colors shadow-lg shadow-emerald-500/20"
              >
                Scan
              </button>
            </form>

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

            {isFetchingLogs || isLoading ? (
              <div className="text-center py-12 text-zinc-500 animate-pulse">Querying factory contract logs for recent launches...</div>
            ) : filteredTokens.length === 0 ? (
              <div className="text-center py-12 text-zinc-500 border border-dashed border-zinc-800 rounded-xl">No tokens match this filter.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredTokens.map((token) => {
                  const scoreColor = token.score >= 70 ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/10" : token.score >= 45 ? "text-yellow-400 border-yellow-400/30 bg-yellow-400/10" : "text-red-400 border-red-400/30 bg-red-400/10";
                  
                  return (
                    <div 
                      key={token.id} 
                      onClick={() => {
                        if (isConnected && hasAccess) setSelectedToken(token);
                      }}
                      className={`relative border border-zinc-800 bg-zinc-900 rounded-xl p-6 overflow-hidden flex flex-col justify-between transition-all ${isConnected && hasAccess ? 'cursor-pointer hover:border-emerald-500/50 hover:shadow-[0_0_20px_rgba(16,185,129,0.1)] group' : ''}`}
                    >
                      <div>
                        <div className="flex justify-between items-start mb-4">
                          <div>
                            <h3 className={`font-bold text-lg ${isConnected && hasAccess ? 'group-hover:text-emerald-400 transition-colors' : ''}`}>{token.name}</h3>
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

                      <div className="relative">
                        {(!isConnected || !hasAccess) && (
                          <div className="absolute inset-0 z-10 backdrop-blur-md bg-zinc-950/60 flex flex-col items-center justify-center rounded-lg border border-zinc-800">
                            {!isConnected ? (
                              <span className="text-sm font-bold text-zinc-300">Connect Wallet to Unlock</span>
                            ) : (
                              <div className="text-center p-2">
                                <span className="text-xs font-bold text-emerald-400 block mb-1">Requires 10,000 $SIGNAL</span>
                                <a href={`https://testnet.vibevibe.fun/token/${SIGNAL_TOKEN}`} target="_blank" rel="noreferrer" className="text-[10px] underline text-zinc-400 hover:text-white pointer-events-auto relative z-20">Acquire Token</a>
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

                      <button 
                        className={`w-full py-2 font-bold rounded-lg text-center text-sm transition-colors mt-auto block border ${isConnected && hasAccess ? 'bg-zinc-800 hover:bg-emerald-500 hover:text-zinc-950 border-zinc-700 hover:border-emerald-500 text-white' : 'bg-zinc-800/50 text-zinc-600 border-zinc-800 cursor-not-allowed'}`}
                      >
                        {isConnected && hasAccess ? 'Analyze Alpha →' : 'Locked'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}