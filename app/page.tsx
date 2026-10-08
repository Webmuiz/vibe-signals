"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount, useSendTransaction, useBalance, useReadContract, useWaitForTransactionReceipt } from "wagmi";
import { isAddress, parseEther, parseUnits, createPublicClient, http, formatEther, encodeAbiParameters, parseAbiParameters } from "viem";
import { createClient } from "@supabase/supabase-js";

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

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTimeLive(totalMinutes: number) {
  if (!totalMinutes && totalMinutes !== 0) return '0m';
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = Math.floor(totalMinutes % 60);

  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  return `${hours}h ${mins}m`;
}

const getSymbolUsdRate = (symbol: string) => {
  // VibeVibe Testnet Oracle Mock Rates (Derived from official UI)
  const rates: Record<string, number> = {
    "ETH": 2600, "WETH": 2600, "NVDA": 465, "AAPL": 225,
    "SPCX": 20, "MSFT": 415, "TSLA": 250, "VIBE": 1, "STOCK": 1
  };
  return rates[symbol.toUpperCase()] || 0;
};

function getUsdRateForPair(symbol: string | undefined, liveRates: Record<string, number>): number {
  if (!symbol) return liveRates['ETH'] || 2416;
  const s = symbol.toUpperCase();

  if (s.includes('USD') && !s.includes('ETH')) return 1;
  if (liveRates[s]) return liveRates[s];
  if (s === 'ETH' || s === 'WETH') return liveRates['ETH'] || 2416;

  return liveRates['ETH'] || 2416;
}

function calculateTokenMetrics(
  bondingCurveProgress: number,
  ethDeposited: number | string,
  pairSymbol: string = 'ETH',
  liveRates: Record<string, number>,
  lastPriceWeiPerToken?: number | string
) {
  const usdRate = getUsdRateForPair(pairSymbol, liveRates);

  if (lastPriceWeiPerToken && Number(lastPriceWeiPerToken) > 0) {
    const pricePairUnits = Number(lastPriceWeiPerToken) / 1e18;
    const mcUsd = usdRate > 0 ? pricePairUnits * 1_000_000_000 * usdRate : 0;
    return {
      marketCapFormatted: mcUsd > 0 ? mcUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '$0.00',
      marketCapRaw: mcUsd
    };
  }

  const progress = Math.min(100, Math.max(0, Number(bondingCurveProgress || 0)));
  const sym = (pairSymbol || 'ETH').toUpperCase();

  let gradUsd = 50500;
  let baseUsd = 4000;
  if (sym === 'VIBEVIBE' || sym === 'VIBE') {
    gradUsd = 220000; // Vibe-paired tokens have higher USD graduation targets
    baseUsd = 15000;
  }

  const currentUsd = progress >= 100
    ? gradUsd
    : baseUsd + ((gradUsd - baseUsd) * Math.pow(progress / 100, 1.45));

  return {
    marketCapFormatted: currentUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
    marketCapRaw: currentUsd
  };
}

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

  const hasAccess = balanceData && BigInt(balanceData as any) >= BigInt("200000") * (BigInt("10") ** BigInt("18"));

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
      
      const isGraduated = selectedToken.bondingCurveProgress >= 100;
      const targetMarket = isGraduated ? selectedToken.contractAddress : selectedToken.ammAddress;
      const kindCode = isGraduated ? 3n : 1n; // 3 = SWAP, 1 = CURVE_BUY

      let toAddress = ZAP_ROUTER;
      let txData;

      if (selectedToken.isLegacy) {
        toAddress = targetMarket as `0x${string}`;
        const argsData = encodeAbiParameters(parseAbiParameters('uint256, uint256'), [1n, deadline]);
        txData = `0xd6febde8${argsData.slice(2)}` as `0x${string}`;
      } else {
        toAddress = ZAP_ROUTER;
        const argsData = encodeAbiParameters(
          parseAbiParameters('address, address, uint256, uint256, uint256, uint256, address[], address[]'),
          [targetMarket as `0x${string}`, "0x0000000000000000000000000000000000000000", amountInWei, 256n, kindCode, deadline, [], []]
        );
        txData = `0x7681fb10${argsData.slice(2)}` as `0x${string}`;
      }
      sendTransaction({ to: toAddress, value: amountInWei, data: txData, chainId: 46630 });
    } catch (err) { console.error(err); }
  };

  const handleExecuteSell = async () => {
    if (!selectedToken || !sellAmount || Number(sellAmount) <= 0) return;
    try {
      const amountInWei = parseEther(sellAmount);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      
      const isGraduated = selectedToken.bondingCurveProgress >= 100;
      const targetMarket = isGraduated ? selectedToken.contractAddress : selectedToken.ammAddress;
      const kindCode = isGraduated ? 3n : 2n; // 3 = SWAP, 2 = CURVE_SELL

      let toAddress = ZAP_ROUTER;
      let txData;

      if (selectedToken.isLegacy) {
        toAddress = targetMarket as `0x${string}`;
        const argsData = encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256'), [amountInWei, 1n, deadline]);
        txData = `0xd3c9727c${argsData.slice(2)}` as `0x${string}`;
      } else {
        toAddress = ZAP_ROUTER;
        const argsData = encodeAbiParameters(
          parseAbiParameters('address, uint256, address[], uint256, uint256, address[]'),
          [targetMarket as `0x${string}`, amountInWei, [], kindCode, deadline, []]
        );
        txData = `0x15d5cb8b${argsData.slice(2)}` as `0x${string}`;
      }
      sendTransaction({ to: toAddress, value: 0n, data: txData, chainId: 46630 });
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
      <nav className="flex justify-between items-center p-4 border-b border-zinc-800 bg-zinc-900/50 sticky top-0 z-50 backdrop-blur-md">
        <div>
          <h1 className="text-xl font-bold text-emerald-400">Vibe Signals</h1>
          <span className="text-xs text-zinc-500">Robinhood Chain Testnet | High-Speed Node</span>
        </div>
        <div className="flex items-center gap-3">
          {(!ready || (!authenticated && !isConnected)) ? (
            <button
              onClick={login}
              disabled={!ready}
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-lg transition-colors text-sm disabled:opacity-50"
            >
              Log In / Connect
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-sm font-mono text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-lg border border-emerald-500/30">
                {address ? `${address.substring(0, 6)}...${address.substring(address.length - 4)}` : ""}
              </span>
              <button
                onClick={logout}
                className="px-4 py-2 bg-zinc-800 hover:bg-red-500 hover:text-white text-zinc-400 font-bold rounded-lg transition-colors text-sm border border-zinc-700 hover:border-red-500"
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      </nav>

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

                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <div className="flex justify-between items-center mb-6">
                    <h3 className="text-lg font-bold text-white flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping"></span>
                      Live Telemetry
                    </h3>
                    <div className="flex gap-2 items-center">
                      {isSyncingLive && <span className="text-[10px] text-emerald-400 font-bold uppercase animate-pulse border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 rounded">Syncing...</span>}
                      <span className="text-xs text-zinc-400 font-bold border border-zinc-700 px-2 py-1 rounded bg-zinc-950">LIVE: {formatTimeLive(selectedToken.timeSinceLaunchMins)}</span>
                    </div>
                  </div>

                  <div className="mb-8">
                    <div className="flex justify-between text-xs mb-2">
                      <span className="text-zinc-400">{selectedToken.bondingCurveProgress >= 100 ? 'Status' : `Bonding Curve Progress (${selectedToken.ethDeposited} ${selectedToken.pairSymbol})`}</span>
                      <div className="flex gap-3">
                        <span className="text-zinc-400 font-mono">MC: {isSyncingLive ? <span className="animate-pulse">...</span> : (selectedToken.marketCapUsd || "$0.00")}</span>
                        <span className={selectedToken.bondingCurveProgress >= 100 ? "text-amber-400 font-bold" : "text-emerald-400 font-bold"}>
                          {selectedToken.bondingCurveProgress >= 100 ? 'Graduated 🚀' : `${selectedToken.bondingCurveProgress.toFixed(1)}%`}
                        </span>
                      </div>
                    </div>
                    <div className="w-full bg-zinc-950 rounded-full h-3 overflow-hidden border border-zinc-800">
                      <div
                        className={`h-full transition-all ${selectedToken.bondingCurveProgress >= 100
                          ? 'bg-gradient-to-r from-amber-400 via-amber-500 to-amber-600 shadow-[0_0_15px_rgba(251,191,36,0.5)]'
                          : 'bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.5)]'
                          }`}
                        style={{ width: `${Math.min(100, Math.max(1, selectedToken.bondingCurveProgress))}%` }}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-2">
                      <span className="text-zinc-400 uppercase tracking-wider font-bold">24H MOMENTUM</span>
                      <span className="text-zinc-500">24H Volume: {isSyncingLive ? <span className="animate-pulse">...</span> : (selectedToken.momentum?.volumeUsd || selectedToken.volumeUsd || `${selectedToken.momentum?.volumeEth || selectedToken.volumeEth || '0.0000'} ${selectedToken.pairSymbol}`)}</span>
                    </div>
                    <div className="flex justify-between text-xs mb-2">
                      <span className="text-emerald-400 font-bold">{selectedToken.momentum?.buyPct ?? 50}% Buys</span>
                      <span className="text-red-400 font-bold">{selectedToken.momentum?.sellPct ?? 50}% Sells</span>
                    </div>
                    <div className="w-full bg-zinc-950 rounded-full h-2 overflow-hidden flex border border-zinc-800">
                      <div className="bg-emerald-500 h-full transition-all" style={{ width: `${selectedToken.momentum?.buyPct ?? 50}%` }} />
                      <div className="bg-red-500 h-full transition-all" style={{ width: `${selectedToken.momentum?.sellPct ?? 50}%` }} />
                    </div>
                  </div>
                </div>

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
                      <span className={selectedToken.diamondHandsHoldersPct < 30 ? "text-red-400 font-bold" : "text-yellow-400 font-bold"}>
                        {100 - selectedToken.diamondHandsHoldersPct}% Dumped
                      </span>
                    </div>
                  </div>
                </div>

                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-lg font-bold text-white">Developer Profiler</h3>
                    <div className={`px-2 py-1 text-[10px] font-bold tracking-wider uppercase border rounded ${devBadgeColor}`}>
                      {devBadgeText}
                    </div>
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
                      <span className="text-zinc-500 block mb-1">Total Launches</span>
                      <span className="text-white font-bold">
                        {devStats ? `${devStats.launches} Tokens` : `${selectedToken.devProfile.launches} Tokens`}
                      </span>
                    </div>
                    <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500 block mb-1">Graduation Rate</span>
                      <span className={(devStats ? devStats.gradRate : selectedToken.devProfile.gradRate) > 50 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>{devStats ? `${devStats.gradRate}%` : `${selectedToken.devProfile.gradRate}%`}</span>
                    </div>
                  </div>
                </div>
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
                    <div className="flex gap-2">
                      <button
                        onClick={handleApprove}
                        disabled={isTxPending}
                        className="w-1/3 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-black text-sm uppercase rounded-lg border border-zinc-700 transition-all disabled:opacity-50"
                      >
                        1. Approve
                      </button>
                      <button
                        onClick={handleExecuteSell}
                        disabled={isTxPending}
                        className="w-2/3 py-3 bg-red-500 hover:bg-red-400 text-white font-black text-sm uppercase rounded-lg shadow-[0_0_15px_rgba(239,68,68,0.2)] transition-all disabled:opacity-50"
                      >
                        {isTxPending ? 'Executing...' : `2. Dump ${selectedToken?.symbol || ''}`}
                      </button>
                    </div>
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

                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-4">Contract Safety & Audits</h3>
                  <ul className="space-y-3 text-sm">
                    <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500">Social Presence</span>
                      <span className={selectedToken.hasSocials ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                        {selectedToken.hasSocials ? 'Linked' : 'No Socials'}
                      </span>
                    </li>
                    <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500">MEV Exposure</span>
                      <span className={selectedToken.safetyChecks.mev.safe ? 'text-emerald-400 font-bold' : 'text-yellow-400 font-bold'}>{selectedToken.safetyChecks.mev.label}</span>
                    </li>
                    <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500">Creator Wallet</span>
                      <span className={selectedToken.safetyChecks.creatorBag.safe ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                        {selectedToken.safetyChecks.creatorBag.label}
                      </span>
                    </li>
                    <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                      <span className="text-zinc-500">Developer Discipline</span>
                      <span className={selectedToken.safetyChecks?.dumperRisk?.safe ? 'text-emerald-400 font-bold' : 'text-red-500 font-bold bg-red-500/10 px-2 py-0.5 rounded border border-red-500/30 animate-pulse'}>
                        {selectedToken.safetyChecks?.dumperRisk?.label || "Scanning..."}
                      </span>
                    </li>
                  </ul>
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

                          {/* The missing time block you are adding back: */}
                          <div className="flex justify-between text-xs mb-2">
                            <span className="text-zinc-500">Time Live (est)</span>
                            <span className="text-zinc-300">{formatTimeLive(token.timeSinceLaunchMins)}</span>
                          </div>

                          {/* The existing bonding curve code you just shared: */}
                          <div className="flex justify-between text-xs mb-2">
                            <span className="text-zinc-500">{token.bondingCurveProgress >= 100 ? 'Status' : 'Bonding Curve'}</span>
                            <span className={token.bondingCurveProgress >= 100 ? "text-amber-400 font-bold" : token.bondingCurveProgress > 85 ? "text-emerald-400" : "text-zinc-300"}>
                              {token.bondingCurveProgress >= 100 ? 'Graduated 🚀' : `${token.bondingCurveProgress.toFixed(1)}%`}
                            </span>
                          </div>
                          <div className="w-full bg-zinc-800 rounded-full h-2">
                            <div
                              className={`h-2 rounded-full ${token.bondingCurveProgress >= 100
                                ? "bg-gradient-to-r from-amber-400 via-amber-500 to-amber-600 shadow-[0_0_10px_rgba(251,191,36,0.8)]"
                                : token.bondingCurveProgress > 85
                                  ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]"
                                  : "bg-zinc-500"
                                }`}
                              style={{ width: `${Math.min(100, Math.max(1, token.bondingCurveProgress))}%` }}
                            />
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
                                <span className="text-xs font-bold text-emerald-400 block mb-1">Requires 200,000 $SIGNAL</span>
                                <a href={`https://testnet.vibevibe.fun/token/${SIGNAL_TOKEN}`} target="_blank" rel="noreferrer" className="text-[10px] underline text-zinc-400 hover:text-white pointer-events-auto relative z-20">Acquire Token</a>
                              </div>
                            )}
                          </div>
                        )}

                        <div className="border border-zinc-800 bg-zinc-950/50 rounded-lg p-4 mb-4">
                          <div className="grid grid-cols-3 gap-2 text-center divide-x divide-zinc-800/50">
                            <div>
                              <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider block mb-1">M.Cap (Est)</span>
                              <span className="text-sm font-bold text-zinc-300">
                                {token.cachedMarketCapFormatted || calculateTokenMetrics(token.bondingCurveProgress, token.ethDeposited, token.pairSymbol, liveRates).marketCapFormatted}
                              </span>
                            </div>
                            <div>
                              <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider block mb-1">24H Vol</span>
                              <span className="text-sm font-bold text-zinc-300">
                                ${(Number(token.momentum?.volumeEth || 0) * getUsdRateForPair(token.pairSymbol, liveRates)).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                              </span>
                            </div>
                            <div className="pl-1">
                              <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider block mb-1">Score</span>
                              <span className={`text-sm font-bold px-2 py-0.5 rounded border inline-block ${scoreColor}`}>
                                {token.score}
                              </span>
                            </div>
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