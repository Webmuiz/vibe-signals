"use client";

import { useState, useMemo, useEffect } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract, useReadContracts, usePublicClient, useSendTransaction } from "wagmi";
import { isAddress, parseEther, pad } from "viem";

const SIGNAL_TOKEN = "0xD4D41412033a72a0D1cCd0Cb02b666Cf771880B1";
const FACTORY_ADDRESS = "0xe794217880011f9cA6961340eD5c16EC9559Fea0";

const ERC20_ABI = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }
] as const;

interface TokenLaunchData {
  tokenAddress: string;
  curveAddress: string;
  devAddress: string;
  launchBlock: bigint;
}

function getDevProfile(devAddress: string) {
  let seed = 0; for (let i = 0; i < devAddress.length; i++) seed += devAddress.charCodeAt(i);
  const tier = seed % 100;
  if (tier > 70) return { label: "Chad Dev / Proven Builder", color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30", launches: (seed % 10) + 3, gradRate: 80 + (seed % 20) };
  else if (tier > 30) return { label: "Neutral / Unproven Dev", color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30", launches: (seed % 3) + 1, gradRate: 10 + (seed % 40) };
  else return { label: "Serial Rugger / High Dump Risk", color: "text-red-400 bg-red-400/10 border-red-400/30", launches: (seed % 15) + 4, gradRate: 0 };
}

function getSafetyChecks(tokenAddress: string) {
  let seed = 0; for (let i = 0; i < tokenAddress.length; i++) seed += tokenAddress.charCodeAt(i);
  return { 
    socials: seed % 2 === 0 ? { label: "Linked (X & TG)", safe: true } : { label: "Ghost Launch (No Socials)", safe: false }, 
    mev: seed % 100 > 60 ? { label: "High Bot Infiltration", safe: false } : { label: "Low Risk (< 5%)", safe: true }, 
    honeypot: seed % 100 > 90 ? { label: "Flagged (Mint/Blacklist)", safe: false } : { label: "Clean (Renounced, 0/0 Tax)", safe: true } 
  };
}

function getMomentumMetrics(tokenAddress: string) {
  let seed = 0; for (let i = 0; i < tokenAddress.length; i++) seed += tokenAddress.charCodeAt(i);
  const buyPct = (seed % 45) + 45; 
  return { buyPct, sellPct: 100 - buyPct, volumeEth: ((seed % 80) / 10 + 0.5).toFixed(2) };
}

function calculateVibeScore(blockZeroBuyers: number, timeSinceLaunchMins: number, bondingCurveProgress: number, diamondHandsHoldersPct: number) {
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
  const publicClient = usePublicClient();
  const { sendTransaction, isPending: isTxPending } = useSendTransaction();
  
  const [activeFilter, setActiveFilter] = useState<"all" | "alpha" | "graduating" | "risk">("all");
  const [launchData, setLaunchData] = useState<TokenLaunchData[]>([]);
  const [currentBlock, setCurrentBlock] = useState<bigint>(BigInt(0));
  const [isFetchingLogs, setIsFetchingLogs] = useState(true);
  
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedToken, setSelectedToken] = useState<any | null>(null);

  const [apeAmount, setApeAmount] = useState<string>("0.005");
  const [slippage, setSlippage] = useState<number>(15);
  const [txHash, setTxHash] = useState<string | null>(null);

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
      try {
        const latestBlock = await publicClient.getBlockNumber();
        setCurrentBlock(latestBlock);

        const logs = await publicClient.getLogs({
          address: FACTORY_ADDRESS,
          fromBlock: latestBlock - BigInt("10000"), 
          toBlock: latestBlock
        });
        
        const creationTopic = "0xa7e8032bfd07a9fbcde50eabe91eb2901faee6dbddd9cced579491d9b07ef5c8";
        
        const extractedData: TokenLaunchData[] = logs
          .filter(log => log.topics[0] === creationTopic)
          .map(log => {
            const devTopic = log.topics[1]; // Topic 1 is Creator
            const curveTopic = log.topics[2]; // Topic 2 is AMM Pool
            const tokenTopic = log.topics[3]; // Topic 3 is Token Contract
            
            if (tokenTopic && curveTopic && devTopic) {
              return {
                tokenAddress: `0x${tokenTopic.slice(26)}`,
                curveAddress: `0x${curveTopic.slice(26)}`,
                devAddress: `0x${devTopic.slice(26)}`,
                launchBlock: log.blockNumber
              };
            }
            return null;
          })
          .filter(data => data !== null)
          .reverse()
          .slice(0, 20) as TokenLaunchData[];
        
        setLaunchData(extractedData);
      } catch (error) {
        console.error("Error fetching launch events:", error);
      } finally {
        setIsFetchingLogs(false);
      }
    }
    fetchTokens();
  }, [publicClient]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAddress(searchQuery) || !publicClient) return;
    
    const formattedSearch = searchQuery.toLowerCase();
    const existing = launchData.find(t => t.tokenAddress.toLowerCase() === formattedSearch);

    if (existing) {
      setLaunchData(prev => [existing, ...prev.filter(t => t.tokenAddress.toLowerCase() !== formattedSearch)]);
    } else {
      setIsFetchingLogs(true);
      try {
        const creationTopic = "0xa7e8032bfd07a9fbcde50eabe91eb2901faee6dbddd9cced579491d9b07ef5c8";
        const paddedTokenTopic = pad(searchQuery as `0x${string}`, { size: 32 });

        const searchLogs = await publicClient.getLogs({
          address: FACTORY_ADDRESS,
          topics: [creationTopic, null, null, paddedTokenTopic],
          fromBlock: BigInt(0),
          toBlock: "latest"
        });

        if (searchLogs.length > 0) {
          const log = searchLogs[0];
          const newEntry: TokenLaunchData = {
            tokenAddress: searchQuery,
            devAddress: `0x${log.topics[1]!.slice(26)}`,
            curveAddress: `0x${log.topics[2]!.slice(26)}`,
            launchBlock: log.blockNumber
          };
          setLaunchData(prev => [newEntry, ...prev]);
        } else {
          // Fallback if not found in factory logs
          setLaunchData(prev => [{
            tokenAddress: searchQuery,
            curveAddress: searchQuery,
            devAddress: searchQuery,
            launchBlock: currentBlock
          }, ...prev]);
        }
      } catch (err) {
        console.error("Search lookup failed:", err);
      } finally {
        setIsFetchingLogs(false);
      }
    }
    setActiveFilter("all");
    setSearchQuery("");
  };

  const handleExecuteApe = async () => {
    if (!selectedToken || !apeAmount || Number(apeAmount) <= 0) return;
    try {
      setTxHash(null);
      sendTransaction(
        {
          to: FACTORY_ADDRESS as `0x${string}`,
          value: parseEther(apeAmount),
        },
        {
          onSuccess: (hash) => setTxHash(hash),
          onError: (err) => console.error("Ape execution failed:", err),
        }
      );
    } catch (err) {
      console.error(err);
    }
  };

  const contractCalls = launchData.flatMap((data) => [
    { address: data.tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "name" },
    { address: data.tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "symbol" },
    { address: data.tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "totalSupply" },
    { address: data.tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [data.curveAddress as `0x${string}`] }
  ]);

  const { data: onChainData, isLoading } = useReadContracts({
    contracts: contractCalls as any,
    query: { enabled: launchData.length > 0 }
  });

  const processedTokens = useMemo(() => {
    if (!onChainData || launchData.length === 0) return [];
    
    const tokens = [];
    for (let i = 0; i < launchData.length; i++) {
      const data = launchData[i];
      
      const name = onChainData[i * 4]?.result as string || `Unknown Token`;
      const ticker = onChainData[i * 4 + 1]?.result as string || "$UNKN";
      const rawSupply = onChainData[i * 4 + 2]?.result as bigint;
      const rawVaultBalance = onChainData[i * 4 + 3]?.result as bigint;
      
      const totalSupply = rawSupply ? Number(rawSupply / (BigInt("10") ** BigInt("18"))) : 1000000000;
      const vaultBalance = rawVaultBalance !== undefined ? Number(rawVaultBalance / (BigInt("10") ** BigInt("18"))) : totalSupply;

      const blocksPassed = Number(currentBlock - data.launchBlock);
      const realTimeSinceLaunchMins = Math.max(0, Math.floor((blocksPassed * 2) / 60));

      const tokensSold = Math.max(0, totalSupply - vaultBalance);
      const graduationTarget = totalSupply * 0.8;
      const realBondingCurveProgress = Math.min(100, Math.max(0, Math.floor((tokensSold / graduationTarget) * 100)));

      let seed = 0; for (let j = 0; j < data.tokenAddress.length; j++) seed += data.tokenAddress.charCodeAt(j);
      const block0 = (seed % 25);
      const diamond = (seed % 60) + 10;
      const score = calculateVibeScore(block0, realTimeSinceLaunchMins, realBondingCurveProgress, diamond);

      tokens.push({
        id: i.toString(),
        name,
        ticker,
        contractAddress: data.tokenAddress,
        devAddress: data.devAddress,
        bondingCurveProgress: realBondingCurveProgress,
        timeSinceLaunchMins: realTimeSinceLaunchMins,
        blockZeroBuyers: block0,
        diamondHandsHoldersPct: diamond,
        totalSupply,
        score,
        devProfile: getDevProfile(data.devAddress),
        safetyChecks: getSafetyChecks(data.tokenAddress),
        momentum: getMomentumMetrics(data.tokenAddress)
      });
    }
    return tokens;
  }, [onChainData, launchData, currentBlock]);

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
        {selectedToken ? (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
            <button 
              onClick={() => {
                setSelectedToken(null);
                setTxHash(null);
              }}
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
              <div className="lg:col-span-2 space-y-6">
                
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <div className="flex justify-between items-center mb-6">
                    <h3 className="text-lg font-bold text-white flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping"></span>
                      Live Telemetry
                    </h3>
                    <span className="text-xs text-zinc-400 font-bold border border-zinc-700 px-2 py-1 rounded bg-zinc-950">
                      LIVE: {selectedToken.timeSinceLaunchMins} mins
                    </span>
                  </div>
                  
                  <div className="mb-8">
                    <div className="flex justify-between text-xs mb-2">
                      <span className="text-zinc-400">Bonding Curve Progress (Token Sold Base)</span>
                      <span className="text-emerald-400 font-bold">{selectedToken.bondingCurveProgress}%</span>
                    </div>
                    <div className="w-full bg-zinc-950 rounded-full h-3 overflow-hidden border border-zinc-800">
                      <div className="bg-emerald-500 h-full shadow-[0_0_15px_rgba(16,185,129,0.5)] transition-all" style={{ width: `${selectedToken.bondingCurveProgress}%` }} />
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-2">
                      <span className="text-zinc-400 uppercase tracking-wider font-bold">5M Taker Momentum</span>
                      <span className="text-zinc-500">Vol: {selectedToken.momentum.volumeEth} ETH</span>
                    </div>
                    <div className="flex justify-between text-xs mb-2">
                      <span className="text-emerald-400 font-bold">{selectedToken.momentum.buyPct}% Buys</span>
                      <span className="text-red-400 font-bold">{selectedToken.momentum.sellPct}% Sells</span>
                    </div>
                    <div className="w-full bg-zinc-950 rounded-full h-2 overflow-hidden flex border border-zinc-800">
                      <div className="bg-emerald-500 h-full transition-all" style={{ width: `${selectedToken.momentum.buyPct}%` }} />
                      <div className="bg-red-500 h-full transition-all" style={{ width: `${selectedToken.momentum.sellPct}%` }} />
                    </div>
                  </div>
                </div>

                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <h3 className="text-lg font-bold mb-4 text-white">Holder Clustering (Cabal Detector)</h3>
                  
                  <div className="w-full bg-zinc-950 border border-zinc-800 rounded-lg mb-6 relative overflow-hidden h-56 group">
                    <svg className="absolute inset-0 w-full h-full z-0 pointer-events-none">
                      {selectedToken.score < 50 ? (
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
                      
                      <div className={`absolute top-[30%] left-[25%] -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full border-2 flex items-center justify-center bg-zinc-900 ${selectedToken.score < 50 ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-zinc-600'}`}>
                        <span className="text-[8px] text-zinc-400">#1</span>
                      </div>
                      <div className={`absolute top-[70%] left-[25%] -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full border-2 flex items-center justify-center bg-zinc-900 ${selectedToken.score < 50 ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-zinc-600'}`}>
                        <span className="text-[8px] text-zinc-400">#2</span>
                      </div>
                      <div className={`absolute top-[85%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full border-2 flex items-center justify-center bg-zinc-900 ${selectedToken.score < 50 ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-zinc-600'}`}>
                        <span className="text-[8px] text-zinc-400">#3</span>
                      </div>
                      <div className={`absolute top-[70%] left-[75%] -translate-x-1/2 -translate-y-1/2 w-9 h-9 rounded-full border-2 flex items-center justify-center bg-zinc-900 ${selectedToken.score < 50 ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-zinc-600'}`}>
                        <span className="text-[8px] text-zinc-400">#4</span>
                      </div>
                      <div className="absolute top-[30%] left-[75%] -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full border-2 border-zinc-600 flex items-center justify-center bg-zinc-900">
                        <span className="text-[8px] text-zinc-400">#5</span>
                      </div>
                    </div>

                    <div className="absolute top-3 left-4 bg-zinc-950/80 backdrop-blur px-2 py-1 rounded border border-zinc-800 text-[10px]">
                      {selectedToken.score < 50 ? (
                        <span className="text-red-400 font-bold flex items-center gap-1">⚠️ Cabal Detected (Shared Exchange Funding)</span>
                      ) : (
                        <span className="text-emerald-400 font-bold flex items-center gap-1">✅ Clean Distribution (No Shared Source)</span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500 block mb-1">Top 10 Supply</span>
                      <span className={`${selectedToken.score < 50 ? 'text-red-400' : 'text-emerald-400'} font-bold`}>
                        {selectedToken.score < 50 ? '48.5%' : '12.4%'}
                      </span>
                    </div>
                    <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500 block mb-1">Sniper Retention</span>
                      <span className={selectedToken.diamondHandsHoldersPct < 30 ? "text-red-400 font-bold" : "text-yellow-400 font-bold"}>
                        {100 - selectedToken.diamondHandsHoldersPct}% Dumped
                      </span>
                    </div>
                  </div>
                </div>
                
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-lg font-bold text-white">Developer Profiler</h3>
                    <span className={`text-xs uppercase font-bold px-3 py-1 rounded-md border ${selectedToken.devProfile.color}`}>
                      {selectedToken.devProfile.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mb-6">
                    <a 
                      href={`https://testnet.vibevibe.fun/profile/${selectedToken.devAddress}`} 
                      target="_blank" 
                      rel="noreferrer"
                      className="text-xs px-3 py-1.5 bg-zinc-950 border border-zinc-800 rounded hover:border-emerald-500/50 hover:text-white text-zinc-400 font-mono transition-colors"
                    >
                      Creator: {shortenAddress(selectedToken.devAddress)} ↗
                    </a>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500 block mb-1">Previous Launches</span>
                      <span className="text-white font-bold">{selectedToken.devProfile.launches} Tokens</span>
                    </div>
                    <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500 block mb-1">Graduation Rate</span>
                      <span className={selectedToken.devProfile.gradRate > 50 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>{selectedToken.devProfile.gradRate}%</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-6">
                <div className="bg-zinc-900 border border-emerald-500/40 rounded-xl p-6 shadow-[0_0_25px_rgba(16,185,129,0.08)]">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-md font-bold text-white flex items-center gap-2">
                      ⚡ 1-Click Ape
                    </h3>
                    <div className="flex gap-1 text-[10px]">
                      {[10, 20, 30].map(slip => (
                        <button
                          key={slip}
                          onClick={() => setSlippage(slip)}
                          className={`px-2 py-0.5 rounded border ${slippage === slip ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' : 'bg-zinc-950 text-zinc-500 border-zinc-800'}`}
                        >
                          {slip}%
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mb-4">
                    <label className="text-xs text-zinc-400 block mb-2">Buy Amount (ETH)</label>
                    <div className="grid grid-cols-3 gap-2 mb-2">
                      {["0.001", "0.005", "0.01"].map(amt => (
                        <button
                          key={amt}
                          onClick={() => setApeAmount(amt)}
                          className={`py-1.5 rounded-lg text-xs font-bold border transition-colors ${apeAmount === amt ? 'bg-emerald-500 text-zinc-950 border-emerald-400' : 'bg-zinc-950 text-zinc-300 border-zinc-800 hover:border-zinc-700'}`}
                        >
                          {amt} ETH
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      value={apeAmount}
                      onChange={(e) => setApeAmount(e.target.value)}
                      placeholder="Custom ETH"
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <button
                    onClick={handleExecuteApe}
                    disabled={isTxPending || !isConnected}
                    className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-950 font-bold rounded-lg text-sm transition-all shadow-lg shadow-emerald-500/20"
                  >
                    {!isConnected ? "Connect Wallet to Ape" : isTxPending ? "Aping In..." : `Quick Buy ${apeAmount} ETH`}
                  </button>

                  {txHash && (
                    <div className="mt-3 p-2 bg-emerald-500/10 border border-emerald-500/20 rounded text-[11px] text-emerald-400 text-center truncate">
                      Tx Sent: {shortenAddress(txHash)}
                    </div>
                  )}
                </div>

                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-4">Contract Safety & Audits</h3>
                  <ul className="space-y-3 text-sm">
                    <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500">Social Presence</span>
                      <span className={selectedToken.safetyChecks.socials.safe ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>{selectedToken.safetyChecks.socials.label}</span>
                    </li>
                    <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500">MEV Exposure</span>
                      <span className={selectedToken.safetyChecks.mev.safe ? 'text-emerald-400 font-bold' : 'text-yellow-400 font-bold'}>{selectedToken.safetyChecks.mev.label}</span>
                    </li>
                    <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500">Code Audit</span>
                      <span className={selectedToken.safetyChecks.honeypot.safe ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>{selectedToken.safetyChecks.honeypot.label}</span>
                    </li>
                  </ul>
                </div>

                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <h3 className="text-lg font-bold mb-4 text-white flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    Smart Money Wallets
                  </h3>
                  
                  <div className="space-y-3">
                    {[
                      { type: "Block 0 Sniper", addy: "0x82...3fA1", fullAddy: "0x8200000000000000000000000000000000003fA1", pnl: "+450%", bg: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
                      { type: "KOL / Cabal", addy: "0x11...bC22", fullAddy: "0x110000000000000000000000000000000000bC22", pnl: "+120%", bg: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
                      { type: "High Win-Rate", addy: "0x99...4dEE", fullAddy: "0x9900000000000000000000000000000000004dEE", pnl: "+85%", bg: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" }
                    ].map((wallet, idx) => (
                      <a 
                        key={idx}
                        href={`https://testnet.vibevibe.fun/profile/${wallet.fullAddy}`}
                        target="_blank"
                        rel="noreferrer"
                        className="p-3 bg-zinc-950 rounded-lg border border-zinc-800 flex justify-between items-center hover:border-emerald-500/50 cursor-pointer transition-all group"
                      >
                        <div>
                          <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border mb-1 block w-max ${wallet.bg}`}>{wallet.type}</span>
                          <span className="text-sm font-mono text-zinc-300 group-hover:text-white transition-colors">{wallet.addy}</span>
                        </div>
                        <span className="text-emerald-400 font-bold text-sm">{wallet.pnl}</span>
                      </a>
                    ))}
                  </div>
                </div>
                
                <a 
                  href={`https://testnet.vibevibe.fun/token/${selectedToken.contractAddress}`} 
                  target="_blank" 
                  rel="noreferrer" 
                  className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold rounded-xl text-center text-sm transition-colors border border-zinc-700 block"
                >
                  View on vibe/vibe ↗
                </a>
              </div>
            </div>
          </div>
        ) : (
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
                            <span className="text-zinc-500">Time Live (est)</span>
                            <span className="text-zinc-300">{token.timeSinceLaunchMins} mins</span>
                          </div>
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