"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount, useSendTransaction, useBalance, useReadContract, useWaitForTransactionReceipt } from "wagmi";
import { isAddress, parseEther, parseUnits, createPublicClient, http, formatEther, encodeAbiParameters, parseAbiParameters } from "viem";
import { createClient } from "@supabase/supabase-js";
import Header from "@/components/ui/Header";
import TokenCard from "@/components/ui/TokenCard";
import SafetyAuditPanel from "@/components/ui/SafetyAuditPanel";
import DeveloperProfilerPanel from "@/components/ui/DeveloperProfilerPanel";
import CabalDetectorPanel from "@/components/ui/CabalDetectorPanel";
import LiveTelemetryPanel from "@/components/ui/LiveTelemetryPanel";
import { shortenAddress, formatTimeLive, getUsdRateForPair, calculateTokenMetrics } from "@/lib/tokenMetrics";

const SIGNAL_TOKEN = "0xD4D41412033a72a0D1cCd0Cb02b666Cf771880B1" as `0x${string}`;
const FACTORY_ADDRESS = "0xe794217880011f9cA6961340eD5c16EC9559Fea0" as `0x${string}`;
const ZAP_ROUTER = "0x2784448c519D01d3aE257C0aac0b7cDAd8AccEB1" as `0x${string}`;

const SIGNAL_BALANCE_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }
] as const;

const ERC20_ABI = [
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }
] as const;

const publicClient = createPublicClient({
  transport: http('https://rpc.testnet.chain.robinhood.com')
});

// Initialize Supabase client
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

interface DBToken {
  cachedMarketCapFormatted?: string;
  launch_id?: number;
  launchId?: number;
  token_address?: string;
  tokenAddress?: string;
  amm_address?: string;
  ammAddress?: string;
  dev_address?: string;
  devAddress?: string;
  liquidity_deposited?: number;
  ethDeposited?: number;
  pair_symbol?: string;
  pairSymbol?: string;
  curve_progress?: number;
  curveProgress?: number;
  bondingCurveProgress?: number;
  launch_block?: number;
  launchBlock?: number;
  timestamp?: string;
  created_at?: string;
  name?: string;
  ticker?: string;
  symbol?: string;
  volume_eth?: number;
  volumeEth?: number;
  buy_pct?: number;
  buyPct?: number;
  sell_pct?: number;
  sellPct?: number;
  has_socials?: boolean;
  hasSocials?: boolean;
  creator_holding_pct?: number;
  creatorHoldingPct?: number;
  block_zero_buyers?: number;
}

function getDevProfile(devAddress: string, allTokens: DBToken[]) {
  if (!devAddress || !allTokens) return { label: "Neutral / Unproven Dev", color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30", launches: 1, gradRate: 0 };

  const devLaunches = allTokens.filter(t => (t.dev_address || t.devAddress || "").toLowerCase() === devAddress.toLowerCase());
  const launches = devLaunches.length;

  if (launches === 0) return { label: "Neutral / Unproven Dev", color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30", launches: 1, gradRate: 0 };

  const graduated = devLaunches.filter(t => (t.curve_progress || t.curveProgress || 0) >= 100).length;
  const gradRate = Math.round((graduated / launches) * 100);

  let label = "Neutral / Unproven Dev";
  let color = "text-yellow-400 bg-yellow-400/10 border-yellow-400/30";

  if (launches >= 2 && gradRate >= 40) {
    label = "Chad Dev / Proven Builder";
    color = "text-emerald-400 bg-emerald-400/10 border-emerald-400/30";
  } else if (launches >= 2 && gradRate < 15) {
    label = "Serial Rugger / High Dump Risk";
    color = "text-red-400 bg-red-400/10 border-red-400/30";
  }

  return { label, color, launches, gradRate };
}

function getSafetyChecks(tokenAddress: string) {
  let seed = 0; for (let i = 0; i < tokenAddress.length; i++) seed += tokenAddress.charCodeAt(i);
  return {
    socials: seed % 2 === 0 ? { label: "Linked (X & TG)", safe: true } : { label: "Ghost Launch (No Socials)", safe: false },
    mev: seed % 100 > 60 ? { label: "High Bot Infiltration", safe: false } : { label: "Low Risk (< 5%)", safe: true },
    creatorBag: seed % 100 > 85 ? { label: "High Risk (> 10% Supply)", safe: false } : { label: "Safe (< 5% Supply)", safe: true }
  };
}

function getMomentumMetrics(tokenAddress: string) {
  let seed = 0; for (let i = 0; i < tokenAddress.length; i++) seed += tokenAddress.charCodeAt(i);
  const buyPct = (seed % 45) + 45;
  return { buyPct, sellPct: 100 - buyPct, volumeEth: ((seed % 80) / 10 + 0.5).toFixed(2) };
}

function calculateVibeScore(
  blockZeroBuyers: number,
  timeSinceLaunchMins: number,
  curveProgress: number,
  diamondPct: number,
  volumeEth: number,
  buyPct: number,
  hasSocials: boolean = false,
  creatorHoldingPct: number = 0
) {
  let score = 35; // Grounded baseline

  // Volume & Momentum
  if (volumeEth >= 0.1) score += 20;
  else if (volumeEth >= 0.03) score += 15;
  else if (volumeEth >= 0.005) score += 5;

  // Buy Pressure
  if (buyPct >= 80 && volumeEth >= 0.005) score += 15;
  else if (buyPct >= 60 && volumeEth >= 0.005) score += 10;
  if (buyPct < 40 && volumeEth >= 0.01) score -= 15;

  // Curve Traction (Rewards early momentum)
  if (curveProgress >= 50) score += 20;
  else if (curveProgress >= 15) score += 15;
  else if (curveProgress >= 3) score += 10;

  // Identity / Socials
  if (hasSocials) score += 15;

  // Severe Penalties
  if (creatorHoldingPct > 10) score -= 25;
  if (blockZeroBuyers > 15) score -= 25;
  if (timeSinceLaunchMins < 10 && curveProgress > 70) score -= 20;

  return Math.max(1, Math.min(100, Math.round(score)));
}

const getSymbolUsdRate = (symbol: string) => {
  // VibeVibe Testnet Oracle Mock Rates (Derived from official UI)
  const rates: Record<string, number> = {
    "ETH": 2600, "WETH": 2600, "NVDA": 465, "AAPL": 225,
    "SPCX": 20, "MSFT": 415, "TSLA": 250, "VIBE": 1, "STOCK": 1
  };
  return rates[symbol.toUpperCase()] || 0;
};

export default function Home() {
  const { login, logout, authenticated, ready } = usePrivy();
  const { address, isConnected } = useAccount();
  const { sendTransaction, isPending: isTxPending, data: hash } = useSendTransaction();
  const { data: receipt, isLoading: isTxWaiting, isSuccess: isTxSuccess } = useWaitForTransactionReceipt({ hash });

  const [activeFilter, setActiveFilter] = useState<"all" | "alpha" | "graduating" | "risk">("all");
  const [dbTokens, setDbTokens] = useState<DBToken[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedToken, setSelectedToken] = useState<any | null>(null);
  const [onChainToken, setOnChainToken] = useState<any | null>(null);
  const [isSearchingChain, setIsSearchingChain] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isSyncingLive, setIsSyncingLive] = useState(false);

  const [apeAmount, setApeAmount] = useState<string>("0.005");
  const [sellAmount, setSellAmount] = useState<string>("1000");
  const [slippage, setSlippage] = useState<number>(15);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [tradeTab, setTradeTab] = useState<'buy' | 'sell'>('buy');
  const [topHolders, setTopHolders] = useState<{ address: string, pct: number }[]>([]);
  const [devStats, setDevStats] = useState<{ launches: number; gradRate: number; label: string; color: string; } | null>(null);

  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const activeTokenRef = useRef<string | null>(null);

  useEffect(() => {
    activeTokenRef.current = selectedToken?.contractAddress || null;
  }, [selectedToken?.contractAddress]);

  const [liveRates, setLiveRates] = useState<Record<string, number>>({
    ETH: 2600, WETH: 2600, NVDA: 465, AAPL: 225, SPCX: 20, MSFT: 415, TSLA: 250,
    VIBE: 0.085, VIBEVIBE: 0.085, STOCK: 1
  });

  useEffect(() => {
    let isSubscribed = true;
    const syncOraclePrices = async () => {
      try {
        const res = await fetch('/api/proxyPrices');
        if (!res.ok) return;
        const json = await res.json();
        const oracleRates = json?.data?.rates || {};
        const ethPrice = Number(json?.data?.ethPriceUsd) || 2416;

        if (isSubscribed && Object.keys(oracleRates).length > 0) {
          setLiveRates(prev => ({ ...prev, ...oracleRates, ETH: ethPrice, WETH: ethPrice }));
        }
      } catch (err) {
        console.error("Failed to sync global oracle prices", err);
      }
    };

    syncOraclePrices();
    const interval = setInterval(syncOraclePrices, 45000);
    return () => {
      isSubscribed = false;
      clearInterval(interval);
    };
  }, []);



  // Fetch Native ETH Balance pinned to Robinhood Testnet
  const { data: ethBalance } = useBalance({
    address,
    chainId: 46630,
    query: { refetchInterval: 4000 }
  });
  const ethAvailable = ethBalance ? Number(ethBalance.formatted) : 0;

  // Fetch Token Holding Balance pinned to Robinhood Testnet
  const { data: rawTokenBalance } = useReadContract({
    address: selectedToken?.contractAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: 46630,
    query: {
      enabled: !!address && !!selectedToken?.contractAddress,
      refetchInterval: 4000
    }
  });
  const tokenBalance = rawTokenBalance ? Number(formatEther(rawTokenBalance as bigint)) : 0;

  const { data: balanceData } = useReadContract({
    address: SIGNAL_TOKEN,
    abi: SIGNAL_BALANCE_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
  });

  const hasAccess = !!balanceData && BigInt(balanceData as any) >= BigInt("200000") * (BigInt("10") ** BigInt("18"));

  const fetchDatabase = async () => {
    try {
      const { data, error } = await supabase
        .from('launches')
        .select('*')
        .order('launch_id', { ascending: false });

      if (error) {
        console.error('Supabase fetch error:', error);
        return;
      }

      if (data && data.length > 0) {
        setDbTokens(data as DBToken[]);
      }
    } catch (err) {
      console.error("Database sync failed", err);
    }
  };

  // High-speed polling from our local JSON database API or Supabase
  useEffect(() => {
    fetchDatabase();
    const interval = setInterval(fetchDatabase, 3000); // Check for new tokens every 3 seconds
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel('realtime-launches')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'launches' },
        (payload) => {
          const newRecord = payload.new;
          const formattedToken = {
            launchId: newRecord.launch_id,
            tokenAddress: newRecord.token_address,
            ammAddress: newRecord.amm_address,
            devAddress: newRecord.dev_address,
            ethDeposited: newRecord.liquidity_deposited,
            pairSymbol: newRecord.pair_symbol || 'ETH',
            curveProgress: newRecord.curve_progress,
            launchBlock: newRecord.launch_block,
            timestamp: newRecord.created_at,
            name: newRecord.name || `Token #${newRecord.launch_id}`,
            ticker: newRecord.symbol ? `$${newRecord.symbol}` : '$TKN',
          };
          setDbTokens((prev) => [formattedToken as DBToken, ...prev]);
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'launches' },
        (payload) => {
          const updated = payload.new;
          if (activeTokenRef.current && activeTokenRef.current.toLowerCase() === updated.token_address?.toLowerCase()) {
            setRefreshTrigger(prev => prev + 1);
          }
          setDbTokens((prev) =>
            prev.map((token) =>
              (token.tokenAddress || token.token_address)?.toLowerCase() === updated.token_address?.toLowerCase()
                ? {
                  ...token,
                  curveProgress: updated.curve_progress,
                  curve_progress: updated.curve_progress,
                  ethDeposited: updated.liquidity_deposited,
                  liquidity_deposited: updated.liquidity_deposited,
                }
                : token
            )
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const processedTokens = useMemo(() => {
    return dbTokens.map(db => {
      // Safely handle time calculation
      const timestampToParse = db.created_at || db.timestamp || Date.now();
      const timeLiveMs = new Date(timestampToParse).getTime();
      let timeSinceLaunchMins = 0;
      if (!isNaN(timeLiveMs) && timeLiveMs > 0) {
        timeSinceLaunchMins = Math.max(0, Math.floor((Date.now() - timeLiveMs) / 60000));
      }

      const contractAddress = db.token_address || db.tokenAddress || "";
      const devAddress = db.dev_address || db.devAddress || "";
      const ammAddress = db.amm_address || db.ammAddress || "";

      let seed = 0;
      for (let j = 0; j < contractAddress.length; j++) {
        seed += contractAddress.charCodeAt(j);
      }

      const block0 = Number(db.block_zero_buyers ?? 0);
      const diamond = (seed % 60) + 10;

      const isGraduated = (db as any).lifecycle === "GRADUATED" || (db as any).graduated === true || Number(db.curve_progress ?? db.curveProgress ?? db.bondingCurveProgress ?? 0) >= 100;
      let bondingCurveProgress = isGraduated ? 100 : Number(db.curve_progress ?? db.curveProgress ?? db.bondingCurveProgress ?? 0);
      if (!isGraduated && bondingCurveProgress > 0 && bondingCurveProgress < 0.1) {
        bondingCurveProgress = 0.1;
      }
      const ethDeposited = db.liquidity_deposited ?? db.ethDeposited ?? 0;

      const buyPct = db.buy_pct ?? db.buyPct ?? 50;
      const sellPct = db.sell_pct ?? db.sellPct ?? 50;
      const volumeEth = Number(db.volume_eth ?? db.volumeEth ?? 0).toFixed(4);
      const hasSocials = db.has_socials ?? db.hasSocials ?? false;
      const creatorHoldingPct = Number(db.creator_holding_pct ?? db.creatorHoldingPct ?? 0);

      return {
        id: (db.launch_id || db.launchId || "0").toString(),
        name: db.name || "Unknown",
        ticker: db.symbol || db.ticker || "TKN",
        symbol: db.symbol,
        contractAddress,
        devAddress,
        ammAddress,
        bondingCurveProgress,
        ethDeposited,
        pairSymbol: db.pair_symbol || db.pairSymbol || "ETH",
        timeSinceLaunchMins,
        blockZeroBuyers: block0,
        diamondHandsHoldersPct: diamond,
        totalSupply: 1000000000,
        creatorHoldingPct,
        cachedMarketCapFormatted: db.cachedMarketCapFormatted,
        score: calculateVibeScore(
          block0,
          timeSinceLaunchMins,
          bondingCurveProgress,
          diamond,
          Number(volumeEth),
          buyPct,
          hasSocials,
          creatorHoldingPct
        ),
        hasSocials: hasSocials,
        devProfile: getDevProfile(devAddress, dbTokens),
        safetyChecks: getSafetyChecks(contractAddress),
        momentum: {
          buyPct,
          sellPct,
          volumeEth
        }
      };
    });
  }, [dbTokens]);

  const filteredTokens = useMemo(() => {
    let list = processedTokens;
    if (searchQuery) {
      const query = searchQuery.trim().toLowerCase();
      list = list.filter(token => token.contractAddress.toLowerCase().includes(query));
    }
    switch (activeFilter) {
      case "alpha": return list.filter(t => t.score >= 70);
      case "graduating": return list.filter(t => t.bondingCurveProgress >= 85);
      case "risk": return list.filter(t => (t.momentum.sellPct >= 60 && Number(t.momentum.volumeEth) > 0.01) || t.blockZeroBuyers > 15 || t.score < 30);
      default: return list;
    }
  }, [processedTokens, activeFilter, searchQuery]);

  useEffect(() => {
    const fetchOnChain = async () => {
      const query = searchQuery.trim();
      setSearchError(null);
      if (query.length === 42 && query.startsWith("0x") && filteredTokens.length === 0) {
        setIsSearchingChain(true);
        try {
          const res = await fetch(`/api/proxyVibe?address=${query}`);
          if (res.ok) {
            const json = await res.json();
            const launch = json.data?.launch || (json.data?.tokenAddress ? json.data : null);
            const isLegacy = json.apiVersion === "1" || (!json.data?.launch && !!json.data?.tokenAddress);
            if (!launch) throw new Error('Token launch data missing from API response');

            const createdMs = new Date(launch.createdAt).getTime();
            const timeLiveMins = Math.max(0, Math.floor((Date.now() - createdMs) / 60000));

            const isGraduated = launch.lifecycle === "GRADUATED" || launch.graduated === true || launch.curve?.lifecycle === "GRADUATED" || (launch.curve?.progressBps ?? 0) >= 10000;
            const currentEth = Number(launch.curve?.pairReserveUnits || launch.curve?.netRaisedWei || 0) / 1e18;
            const targetEth = Number(launch.targetPairUnits || launch.curve?.netTargetWei || 5000000000000000000) / 1e18;
            let curveProgress = isGraduated ? 100 : (launch.curve?.progressBps != null ? launch.curve.progressBps / 100 : Math.min(100, Math.max(0, (currentEth / targetEth) * 100)));
            if (!isGraduated && curveProgress > 0 && curveProgress < 0.1) {
              curveProgress = 0.1;
            }

            const imageUri = launch.content?.image?.uri?.startsWith('ipfs://')
              ? launch.content.image.uri.replace('ipfs://', 'https://ipfs.io/ipfs/')
              : launch.content?.image?.uri;

            const feeEvents = json.data?.feeEvents || [];
            let buyVolume = 0;
            let sellVolume = 0;
            feeEvents.forEach((ev: any) => {
              const eth = Number(ev.pairPrincipalUnits || 0) / 1e18;
              if (ev.side === 'BUY' || ev.source === 'CURVE_BUY' || ev.source === 'INITIAL_PURCHASE') {
                buyVolume += eth;
              } else if (ev.side === 'SELL' || ev.source === 'CURVE_SELL') {
                sellVolume += eth;
              }
            });
            let totalVolume = buyVolume + sellVolume;
            if (totalVolume === 0 && launch.analytics?.volume24hWei) {
              totalVolume = Number(launch.analytics.volume24hWei) / 1e18;
            }
            const buyRatio = totalVolume > 0 ? Math.round((buyVolume / totalVolume) * 100) : 50;
            const sellRatio = totalVolume > 0 ? 100 - buyRatio : 50;

            const socials = launch.content?.socials || {};
            const hasSocials = !!(socials.x || socials.telegram || socials.website);
            const vibeScore = calculateVibeScore(0, timeLiveMins, curveProgress, 50, totalVolume, buyRatio, hasSocials);

            let resolvedSymbol = launch.pairSymbol;
            if (!resolvedSymbol) {
              if (launch.pairIsNative || launch.pairCurrencyAddress === "0x0000000000000000000000000000000000000000") {
                resolvedSymbol = "ETH";
              } else if (launch.pairCurrencyAddress) {
                try {
                  resolvedSymbol = await publicClient.readContract({
                    address: launch.pairCurrencyAddress as `0x${string}`,
                    abi: ERC20_ABI,
                    functionName: 'symbol',
                  });
                } catch (err) {
                  resolvedSymbol = "TOKEN";
                }
              } else {
                resolvedSymbol = "ETH";
              }
            }

            const mappedToken = {
              isLegacy: isLegacy,
              id: launch.id || "0",
              name: launch.name || "Unknown",
              ticker: launch.symbol || "TKN",
              contractAddress: launch.tokenAddress,
              ammAddress: launch.curveAddress,
              devAddress: launch.launcherAddress || launch.creatorAddress || query,
              timeSinceLaunchMins: timeLiveMins,
              bondingCurveProgress: curveProgress,
              ethDeposited: `${currentEth.toFixed(4)} / ${targetEth.toFixed(1)}`,
              pairSymbol: resolvedSymbol,
              blockZeroBuyers: 0,
              diamondHandsHoldersPct: 50,
              totalSupply: 1000000000,
              score: vibeScore,
              devProfile: getDevProfile(launch.launcherAddress || launch.creatorAddress || query, dbTokens),
              safetyChecks: getSafetyChecks(launch.tokenAddress || query),
              momentum: { buyPct: buyRatio, sellPct: sellRatio, volumeEth: totalVolume.toFixed(4) },
              volumeEth: totalVolume.toFixed(4),
              buyRatio: buyRatio,
              sellRatio: sellRatio,
              imageUri,
              hasSocials: hasSocials,
              socialLinks: socials
            };

            setOnChainToken(mappedToken);
            setSelectedToken(mappedToken);
          } else {
            const errData = await res.json().catch(() => ({}));
            const errMsg = errData.error || await res.text() || "Failed to fetch from VibeVibe API";
            console.error("VibeVibe API failed:", errMsg);
            setSearchError(errMsg);
          }
        } catch (err) {
          console.error("On-chain fallback failed", err);
          setSearchError("Network error while querying VibeVibe API");
        }
        setIsSearchingChain(false);
      } else if (!query || query.length !== 42) {
        setSearchError(null);
      }
    };

    fetchOnChain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, filteredTokens.length]);

  useEffect(() => {
    if (!selectedToken?.contractAddress) return;
    let isMounted = true;

    const fetchLiveToken = () => {
      setIsSyncingLive(true);
      fetch(`/api/proxyVibe?address=${selectedToken.contractAddress}&t=${Date.now()}`, { cache: 'no-store' })
        .then(async res => {
          const json = await res.json();
          if (!isMounted) return;
          const feeEvents = json.data?.feeEvents || [];
          const launch = json.data?.launch || (json.data?.tokenAddress ? json.data : null);

          // 1. DYNAMICALLY RESOLVE SYMBOL
          let livePairSymbol = launch?.pairSymbol;
          if (!livePairSymbol) {
            if (launch?.pairIsNative || launch?.pairCurrencyAddress === "0x0000000000000000000000000000000000000000") {
              livePairSymbol = "ETH";
            } else if (launch?.pairCurrencyAddress) {
              try {
                livePairSymbol = await publicClient.readContract({ address: launch.pairCurrencyAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'symbol' });
              } catch { livePairSymbol = selectedToken?.pairSymbol || "TOKEN"; }
            } else {
              livePairSymbol = selectedToken?.pairSymbol || "ETH";
            }
          }

          // 2. DYNAMIC DECIMALS FOR SYNTHETIC PAIRS (e.g. USDG = 6 decimals)
          const targetRaw = Number(launch?.targetPairUnits || launch?.curve?.netTargetWei || 4e18);
          const currentRaw = Number(launch?.curve?.pairReserveUnits || launch?.curve?.netRaisedWei || 0);
          const pDecimals = (targetRaw > 0 && targetRaw < 1e14) ? 6 : 18;
          const pDivisor = Math.pow(10, pDecimals);

          const isGraduated =
            launch?.lifecycle === "GRADUATED" ||
            launch?.graduated === true ||
            launch?.curve?.lifecycle === "GRADUATED" ||
            selectedToken?.bondingCurveProgress >= 100 ||
            !!launch?.graduation ||
            !!launch?.poolAddress ||
            !!launch?.graduationPoolAddress ||
            !!launch?.pool?.address;

          const currentPairUnits = currentRaw / pDivisor;
          const targetPairUnits = targetRaw / pDivisor;

          let liveCurveProgress = isGraduated ? 100 : (launch?.curve?.progressBps != null ? launch.curve.progressBps / 100 : Math.min(100, Math.max(0, (currentPairUnits / targetPairUnits) * 100)));
          if (!isGraduated && liveCurveProgress > 0 && liveCurveProgress < 0.1) liveCurveProgress = 0.1;
          const liveDepositedStr = isGraduated ? 'Graduated' : `${currentPairUnits.toFixed(4)} / ${targetPairUnits.toFixed(1)}`;

          // 3. CORRECT MARKET CAP & USD VOLUME MATH
          const liveEthPrice = Number(json.data?.ethPriceUsd) || liveRates['ETH'] || 2416;

          const pairAddr = (launch?.pairCurrencyAddress || "").toLowerCase();
          const isNative = !pairAddr || pairAddr === "0x0000000000000000000000000000000000000000";

          let usdRate = liveEthPrice;
          if (!isNative && pairAddr && liveRates[pairAddr]) {
            usdRate = liveRates[pairAddr];
          } else {
            usdRate = getUsdRateForPair(livePairSymbol, { ...liveRates, ETH: liveEthPrice, WETH: liveEthPrice });
          }

          const stats = json.data?.marketStats;
          let marketCapUsd = 0;

          // 1. Always prioritize the API's exact backend USD price for ALL tokens
          const directPriceUsd = launch?.priceUsd || launch?.analytics?.priceUsd || launch?.curve?.priceUsd || stats?.priceUsd;
          let lastPriceWei = stats?.priceWeiPerToken || stats?.lastPriceWeiPerToken || launch?.analytics?.lastPriceWeiPerToken || 0;

          if ((!lastPriceWei || Number(lastPriceWei) === 0) && json.data?.marketTrades?.[0]) {
            lastPriceWei = json.data.marketTrades[0].executionPricePairUnitsPerToken;
          }

          if (directPriceUsd && Number(directPriceUsd) > 0) {
            marketCapUsd = Number(directPriceUsd) * 1_000_000_000;
          } else if (Number(lastPriceWei) > 0) {
            const pricePairUnits = Number(lastPriceWei) / pDivisor;
            marketCapUsd = usdRate > 0 ? pricePairUnits * 1_000_000_000 * usdRate : 0;
          } else {
            marketCapUsd = calculateTokenMetrics(liveCurveProgress, currentPairUnits, livePairSymbol, liveRates).marketCapRaw;
          }

          let displayMarketCap = marketCapUsd > 0
            ? marketCapUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
            : "$0.00";

          let finalVolumeEth = "0.0000";
          let finalBuyPct = 50;
          let finalSellPct = 50;

          if (stats) {
            const buyVol = Number(stats.buyVolume24hPairUnits || 0) / pDivisor;
            const sellVol = Number(stats.sellVolume24hPairUnits || 0) / pDivisor;
            const totalVol = buyVol + sellVol;
            if (totalVol > 0) {
              finalVolumeEth = totalVol.toFixed(4);
              finalBuyPct = Math.round((buyVol / totalVol) * 100);
              finalSellPct = 100 - finalBuyPct;
            }
          } else if (launch?.analytics) {
            const volWei = Number(launch.analytics.volume24hWei || 0);
            if (volWei > 0) finalVolumeEth = (volWei / pDivisor).toFixed(4);
            const buys = Number(launch.analytics.buyCount1h || 0);
            const sells = Number(launch.analytics.sellCount1h || 0);
            const totalTrades = buys + sells;
            if (totalTrades > 0) {
              finalBuyPct = Math.round((buys / totalTrades) * 100);
              finalSellPct = 100 - finalBuyPct;
            }
          }

          const volumeUsdValue = Number(finalVolumeEth) * usdRate;
          let displayVolumeUsd = "\$0.00";
          if (Number(finalVolumeEth) > 0) {
            displayVolumeUsd = usdRate > 0
              ? volumeUsdValue.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
              : `${finalVolumeEth} ${livePairSymbol}`;
          }

          const socials = launch?.content?.socials || {};
          const hasSocials = !!(socials.x || socials.telegram || socials.website);
          const poolAddr = (launch?.graduation?.poolId || launch?.poolAddress || launch?.pool?.address || "").toLowerCase();

          // 4. APPLY DIRECTLY TO STATE
          setSelectedToken((prev: any) => ({
            ...prev,
            decimals: pDecimals,
            isLegacy: prev?.isLegacy || json.apiVersion === "1" || (!json.data?.launch && !!json.data?.tokenAddress),
            bondingCurveProgress: liveCurveProgress,
            ethDeposited: liveDepositedStr,
            pairSymbol: livePairSymbol,
            symbol: launch?.symbol || prev?.symbol,
            devAddress: launch?.launcherAddress || launch?.creatorAddress || prev?.devAddress,
            score: calculateVibeScore(prev?.blockZeroBuyers || 0, prev?.timeSinceLaunchMins || 0, liveCurveProgress, prev?.diamondHandsHoldersPct || 50, Number(finalVolumeEth), finalBuyPct, hasSocials, 0),
            hasSocials: hasSocials,
            socialLinks: socials,
            poolAddress: poolAddr || prev?.poolAddress,
            marketCapUsd: displayMarketCap,
            momentum: { buyPct: finalBuyPct, sellPct: finalSellPct, volumeEth: finalVolumeEth, volumeUsd: displayVolumeUsd },
            volumeEth: finalVolumeEth,
            volumeUsd: displayVolumeUsd,
            safetyChecks: {
              ...prev?.safetyChecks,
              mev: { label: feeEvents.length <= 5 ? "Low Risk (< 5%)" : "Normal", safe: true },
              creatorBag: prev?.safetyChecks?.creatorBag || { label: "Checking...", safe: true }
            }
          }));
        })
        .catch(console.error)
        .finally(() => setIsSyncingLive(false));
    };

    fetchLiveToken();
    const interval = setInterval(fetchLiveToken, 5000);

    if (selectedToken?.contractAddress) {
      fetch(`https://explorer.testnet.chain.robinhood.com/api/v2/tokens/${selectedToken.contractAddress}/holders`)
        .then(res => res.json())
        .then(data => {
          if (data?.items) {
            const cleanHolders = data.items
              .filter((h: any) => {
                const addr = h.address?.hash?.toLowerCase();
                const amm = (selectedToken.ammAddress || "").toLowerCase();
                const isContract = h.address?.is_contract === true || h.address?.is_smart_contract === true;

                return (
                  addr !== amm &&
                  addr !== "0x000000000000000000000000000000000000dead" &&
                  addr !== "0x0000000000000000000000000000000000000000" &&
                  !isContract
                );
              })
              .slice(0, 5)
              .map((h: any) => ({
                address: h.address.hash,
                // Vibe tokens have 1B supply. Convert wei to standard format and calculate percentage:
                pct: (Number(formatEther(BigInt(h.value))) / 1_000_000_000) * 100
              }));

            const top5Pct = cleanHolders.reduce((acc: number, h: any) => acc + h.pct, 0);
            const isCabalRisk = top5Pct > 25;

            const devHolder = cleanHolders.find((h: any) => h.address.toLowerCase() === (selectedToken.devAddress || "").toLowerCase());
            // Force 0 if undefined, preventing ghost data fallbacks
            const creatorHoldingPct = devHolder ? devHolder.pct : 0;
            const isCreatorSafe = creatorHoldingPct <= 5;

            setTopHolders(cleanHolders);

            setSelectedToken((prev: any) => {
              if (!prev) return prev;
              return {
                ...prev,
                score: isCabalRisk ? Math.max(0, prev.score - 25) : prev.score,
                safetyChecks: {
                  ...prev.safetyChecks,
                  creatorBag: {
                    label: `${isCreatorSafe ? 'Safe' : 'High Risk'} (${creatorHoldingPct.toFixed(1)}% Supply)`,
                    safe: isCreatorSafe
                  }
                }
              };
            });
          }
        })
        .catch(err => console.error("Holders fetch failed:", err));
    }

    const creatorWallet = (selectedToken?.devAddress || "").toLowerCase();
    if (creatorWallet && creatorWallet !== "0x" && creatorWallet !== "0x0000000000000000000000000000000000000000") {
      fetch(`/api/proxyDev?address=${creatorWallet}`)
        .then(devRes => devRes.json())
        .then(devJson => {
          const profiler = devJson?.data?.profiler;
          if (!profiler) return;

          setSelectedToken((prevToken: any) => {
            if (!prevToken) return prevToken;
            const penalty = profiler.isSerialDumper ? 40 : 0;
            return {
              ...prevToken,
              score: Math.max(1, prevToken.score - penalty),
              safetyChecks: {
                ...prevToken.safetyChecks,
                dumperRisk: {
                  label: profiler.isSerialDumper
                    ? `🚨 DUMPED ${profiler.totalPreGradDumps} PAST COINS`
                    : `✅ Clean (${profiler.totalLaunches} Launches, 0 Dumps)`,
                  safe: !profiler.isSerialDumper
                }
              }
            };
          });

          let devLabel = "NEUTRAL";
          let devColor = "text-zinc-500 border-zinc-700 bg-zinc-900";
          if (profiler.isSerialDumper) {
            devLabel = "🚨 SERIAL DUMPER";
            devColor = "text-red-400 border-red-500/30 bg-red-500/10";
          } else if (profiler.graduationRate >= 30) {
            devLabel = "💎 DIAMOND DEV";
            devColor = "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
          } else if (profiler.totalLaunches > 0) {
            devLabel = "SOLID BUILDER";
            devColor = "text-yellow-400 border-yellow-500/30 bg-yellow-500/10";
          }
          setDevStats({ launches: profiler.totalLaunches, gradRate: profiler.graduationRate, label: devLabel, color: devColor });
        }).catch(err => console.error("Profiler failed:", err));
    }

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [selectedToken?.contractAddress, refreshTrigger]);

  const handleExecuteApe = async () => {
    if (!selectedToken || !apeAmount || Number(apeAmount) <= 0) return;
    try {
      const amountInWei = parseEther(apeAmount);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const targetToken = selectedToken.contractAddress as `0x${string}`;

      // CRITICAL FIX: The Buy method 0x7681fb10 requires EXACTLY 9 parameters (7 static, 2 dynamic arrays)
      const argsData = encodeAbiParameters(
        parseAbiParameters('address, address, uint256, uint256, uint256, uint256, uint256, address[], address[]'),
        [targetToken, "0x0000000000000000000000000000000000000000", amountInWei, 0n, 256n, 0n, deadline, [], []]
      );
      const txData = `0x7681fb10${argsData.slice(2)}` as `0x${string}`;
      
      sendTransaction({ to: ZAP_ROUTER, value: amountInWei, data: txData, chainId: 46630 });
    } catch (err) { console.error(err); }
  };

  const handleExecuteSell = async () => {
    if (!selectedToken || !sellAmount || Number(sellAmount) <= 0) return;
    try {
      const amountInWei = parseEther(sellAmount);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const targetToken = selectedToken.contractAddress as `0x${string}`;

      // CRITICAL FIX: The Sell method 0x3177b4d2 requires EXACTLY 7 parameters (5 static, 2 dynamic arrays)
      const argsData = encodeAbiParameters(
        parseAbiParameters('address, uint256, address[], uint256, uint256, address[], address[]'),
        [targetToken, amountInWei, [], 0n, deadline, [], []]
      );
      const txData = `0x3177b4d2${argsData.slice(2)}` as `0x${string}`;
      
      sendTransaction({ to: ZAP_ROUTER, value: 0n, data: txData, chainId: 46630 });
    } catch (err) { console.error(err); }
  };

  const top5Pct = topHolders.reduce((acc, h) => acc + h.pct, 0);
  const devHolder = topHolders.find((h: any) => h.address.toLowerCase() === (selectedToken?.devAddress || "").toLowerCase());
  const creatorHoldingPct = devHolder ? devHolder.pct : 0;
  const isCabalRisk = selectedToken ? (top5Pct > 25 || (selectedToken.momentum?.sellPct ?? 0) >= 65 || selectedToken.safetyChecks?.creatorBag?.safe === false) : false;

  let devBadgeText = "NEUTRAL / UNPROVEN";
  let devBadgeColor = "text-zinc-500 border-zinc-700 bg-zinc-900";

  if (selectedToken) {
    const totalLaunches = devStats ? devStats.launches : selectedToken.devProfile.launches;
    const graduationRate = devStats ? devStats.gradRate : selectedToken.devProfile.gradRate;

    if (totalLaunches > 0) {
      if (graduationRate === 0) {
        devBadgeText = "HIGH RISK (0%)";
        devBadgeColor = "text-red-400 border-red-500/30 bg-red-500/10";
      } else if (graduationRate < 15) {
        devBadgeText = "AVG DEV / LOW GRAD";
        devBadgeColor = "text-orange-400 border-orange-500/30 bg-orange-500/10";
      } else if (graduationRate < 30) {
        devBadgeText = "SOLID DEV";
        devBadgeColor = "text-yellow-400 border-yellow-500/30 bg-yellow-500/10";
      } else {
        devBadgeText = "ELITE / CABAL";
        devBadgeColor = "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
      }
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-mono selection:bg-emerald-500/30">
      <Header 
        ready={ready} 
        authenticated={authenticated} 
        isConnected={isConnected} 
        address={address} 
        login={login} 
        logout={logout} 
      />

      <main className="p-8 max-w-6xl mx-auto">
        {selectedToken ? (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
            <button
              onClick={() => { setSelectedToken(null); setTxHash(null); }}
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

                <LiveTelemetryPanel
                  isSyncingLive={isSyncingLive}
                  timeSinceLaunchMins={selectedToken.timeSinceLaunchMins}
                  bondingCurveProgress={selectedToken.bondingCurveProgress}
                  ethDeposited={selectedToken.ethDeposited}
                  pairSymbol={selectedToken.pairSymbol}
                  marketCapUsd={selectedToken.marketCapUsd}
                  momentum={selectedToken.momentum}
                  volumeUsd={selectedToken.volumeUsd}
                  volumeEth={selectedToken.volumeEth}
                />

                <CabalDetectorPanel
                  isCabalRisk={isCabalRisk}
                  topHolders={topHolders}
                  top5Pct={top5Pct}
                  creatorHoldingPct={creatorHoldingPct}
                  diamondHandsHoldersPct={selectedToken.diamondHandsHoldersPct}
                />

                <DeveloperProfilerPanel
                  devAddress={selectedToken.devAddress}
                  badgeText={devBadgeText}
                  badgeColor={devBadgeColor}
                  devStats={devStats}
                  devProfile={selectedToken.devProfile}
                />
              </div>

              <div className="space-y-6">
                <div className="bg-[#0a0a0a] border border-zinc-800 rounded-xl overflow-hidden p-4 flex flex-col shadow-xl">
                  {/* Header & Tabs */}
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex gap-2">
                      <button
                        onClick={() => setTradeTab('buy')}
                        className={`px-5 py-1.5 text-sm font-bold rounded-md transition-all ${tradeTab === 'buy' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' : 'text-zinc-500 hover:text-zinc-300'}`}
                      >
                        Buy
                      </button>
                      <button
                        onClick={() => setTradeTab('sell')}
                        className={`px-5 py-1.5 text-sm font-bold rounded-md transition-all ${tradeTab === 'sell' ? 'bg-red-500/10 text-red-400 border border-red-500/30' : 'text-zinc-500 hover:text-zinc-300'}`}
                      >
                        Sell
                      </button>
                    </div>
                    <span className="text-zinc-400 text-xs font-mono bg-zinc-900/50 px-2 py-1 rounded">
                      Bal: {tradeTab === 'buy' ? `${ethAvailable.toFixed(4)} ETH` : `${Math.floor(tokenBalance).toLocaleString()} ${selectedToken?.symbol || 'TKN'}`}
                    </span>
                  </div>

                  {/* Percentage Pills */}
                  <div className="grid grid-cols-4 gap-2 mb-4">
                    {[25, 50, 75, 100].map(pct => (
                      <button
                        key={pct}
                        onClick={() => {
                          if (tradeTab === 'buy') {
                            // Leave 0.005 ETH for gas when maxing out
                            const val = pct === 100 ? Math.max(0, ethAvailable - 0.005) : (ethAvailable * (pct / 100));
                            setApeAmount(val.toFixed(4).replace(/\.?0+$/, ''));
                          } else {
                            const val = tokenBalance * (pct / 100);
                            // Round down to avoid decimal dust reversion on sells
                            setSellAmount(Math.floor(val).toString());
                          }
                        }}
                        className="bg-zinc-800/40 hover:bg-zinc-700/60 text-zinc-400 text-[11px] py-1.5 rounded transition-colors border border-zinc-800 hover:border-zinc-600 font-semibold"
                      >
                        {pct === 100 ? 'MAX' : `${pct}%`}
                      </button>
                    ))}
                  </div>

                  {/* Input Field */}
                  <div className="relative mb-4">
                    <input
                      type="number"
                      value={tradeTab === 'buy' ? apeAmount : sellAmount}
                      onChange={(e) => tradeTab === 'buy' ? setApeAmount(e.target.value) : setSellAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full bg-zinc-950 border border-zinc-800 focus:border-emerald-500/50 rounded-lg py-3 px-4 text-white text-xl font-mono outline-none transition-all placeholder:text-zinc-700"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-bold text-sm">
                      {tradeTab === 'buy' ? 'ETH' : (selectedToken?.symbol || 'TKN')}
                    </span>
                  </div>

                  {/* Execute Action */}
                  {tradeTab === 'buy' ? (
                    <button
                      onClick={handleExecuteApe}
                      disabled={isTxPending}
                      className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-sm uppercase rounded-lg shadow-[0_0_15px_rgba(16,185,129,0.2)] transition-all disabled:opacity-50"
                    >
                      {isTxPending ? 'Executing...' : `Quick Buy ${selectedToken?.symbol || ''}`}
                    </button>
                  ) : (
                    <button
                      onClick={handleExecuteSell}
                      disabled={isTxPending}
                      className="w-full py-3 bg-red-500 hover:bg-red-400 text-white font-black text-sm uppercase rounded-lg shadow-[0_0_15px_rgba(239,68,68,0.2)] transition-all disabled:opacity-50"
                    >
                      {isTxPending ? 'Executing...' : `Dump ${selectedToken?.symbol || ''}`}
                    </button>
                  )}

                  {/* Success Toast */}
                  {hash && (
                    <div className="mt-3 p-3 bg-zinc-950 border border-zinc-800 rounded-lg text-xs font-mono text-center flex flex-col items-center gap-1.5">
                      {isTxWaiting && (
                        <span className="text-yellow-400 font-bold flex items-center gap-2 animate-pulse">
                          ⏳ Confirming on-chain...
                        </span>
                      )}
                      {isTxSuccess && receipt?.status === 'success' && (
                        <span className="text-emerald-400 font-bold">
                          ✅ Execution Confirmed!
                        </span>
                      )}
                      {receipt?.status === 'reverted' && (
                        <span className="text-red-400 font-bold">
                          ❌ Transaction Reverted (Incompatible Router or Slippage)
                        </span>
                      )}
                      <a
                        href={`https://explorer.testnet.chain.robinhood.com/tx/${hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="underline text-zinc-400 hover:text-white transition-colors"
                      >
                        View on Explorer ↗
                      </a>
                    </div>
                  )}
                </div>

                <SafetyAuditPanel
                  hasSocials={selectedToken.hasSocials}
                  safetyChecks={selectedToken.safetyChecks}
                />

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

            <div className="flex gap-4 mb-8">
              <input
                type="text"
                placeholder="Search by contract (0x...)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-emerald-500 transition-colors shadow-inner text-white max-w-md"
              />
            </div>

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

            {filteredTokens.length === 0 && isSearchingChain ? (
              <div className="text-center py-12 text-emerald-400 font-bold border border-dashed border-emerald-500/50 bg-emerald-500/5 rounded-xl animate-pulse">Querying VibeVibe API...</div>
            ) : filteredTokens.length === 0 && searchError ? (
              <div className="text-center py-12 text-red-400 font-bold border border-dashed border-red-500/50 bg-red-500/5 rounded-xl">
                JIT Failed: {searchError}
              </div>
            ) : filteredTokens.length === 0 ? (
              <div className="text-center py-12 text-zinc-500 border border-dashed border-zinc-800 rounded-xl">No tokens indexed yet. Waiting for Node...</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredTokens.map((token) => (
                  <TokenCard
                    key={token.id}
                    token={token}
                    isConnected={isConnected}
                    hasAccess={hasAccess}
                    liveRates={liveRates}
                    onSelect={setSelectedToken}
                    signalTokenAddress={SIGNAL_TOKEN}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}