"use client";

import { useState, useMemo, useEffect, useRef, useCallback, memo } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount, useSendTransaction, useBalance, useReadContract, useWaitForTransactionReceipt } from "wagmi";
import { isAddress, parseEther, parseUnits, createPublicClient, http, formatEther, encodeFunctionData, parseAbi, BaseError, ContractFunctionRevertedError } from "viem";
import { toPng } from "html-to-image";
import Header from "@/components/ui/Header";
import TokenCard, { type TokenCardData } from "@/components/ui/TokenCard";
import SafetyAuditPanel from "@/components/ui/SafetyAuditPanel";
import DeveloperProfilerPanel from "@/components/ui/DeveloperProfilerPanel";
import CabalDetectorPanel from "@/components/ui/CabalDetectorPanel";
import LiveTelemetryPanel from "@/components/ui/LiveTelemetryPanel";
import RadarHeader, { type RadarFilter } from "@/components/ui/RadarHeader";
import TradingTerminal from "@/components/ui/TradingTerminal";
import UserPortfolio from "@/components/ui/UserPortfolio";
import {
  shortenAddress,
  formatTimeLive,
  getUsdRateForPair,
  calculateTokenMetrics,
  calculateVibeScore,
  normalizeVibeResponse,
  parseCreatedAtMs,
  isTokenGraduated,
  ERC20_SYMBOL_ABI,
  type LiveTokenMetrics,
  type VibeScoreParams,
} from "@/lib/tokenMetrics";

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

// ---------------------------------------------------------------------------
// vibe/vibe V6 bonding-curve ABIs (verified against vibevibe.md section 5).
// The curve is the ONLY contract we trade against for pre-graduation tokens:
//   - buyExactIn(maxPairIn, minNetOut, recipient, deadline) payable
//   - sell(grossTokens, minPairOut, recipient, deadline)   // NO approve needed
// ---------------------------------------------------------------------------
const FACTORY_CURVE_ABI = parseAbi([
  "function curveOf(address token) view returns (address)",
  "function isV6Token(address) view returns (bool)",
]);

const CURVE_ABI = parseAbi([
  "function token() view returns (address)",
  "function pairCurrency() view returns (address)",
  "function complete() view returns (bool)",
  "function currentRateBps() view returns (uint256)",
  "function quoteBuyExactIn(uint256 pairIn) view returns (uint256 gross, uint256 net, uint256 cost, uint256 pairFee, uint256 refund)",
  "function quoteSell(uint256 grossTokens) view returns (uint256 net, uint256 proceeds, uint256 pairFee, uint256 pairOut)",
  "function buyExactIn(uint256 maxPairIn, uint256 minNetOut, address recipient, uint256 deadline) payable",
  "function sell(uint256 grossTokens, uint256 minPairOut, address recipient, uint256 deadline)",
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

// Slippage tolerance applied to the quoted output (3% — within the 1-3% band
// the spec recommends to survive volatile blocks without reverting).
const SLIPPAGE_BPS = 300n;
const BPS_DENOMINATOR = 10000n;

/**
 * Resolves the bonding curve for a token via `factory.curveOf(token)`.
 * Falls back to the token's indexed `ammAddress` when the factory read fails
 * (e.g. legacy V5 tokens) so the trade box still has a target.
 */
async function resolveCurveAddress(
  tokenAddress: `0x${string}`,
  fallbackAmm?: string
): Promise<`0x${string}`> {
  try {
    const curve = (await publicClient.readContract({
      address: FACTORY_ADDRESS,
      abi: FACTORY_CURVE_ABI,
      functionName: "curveOf",
      args: [tokenAddress],
    })) as `0x${string}`;
    if (curve && curve !== ZERO_ADDRESS) return curve;
  } catch (err) {
    console.warn("[trade] factory.curveOf failed, using indexed ammAddress:", err);
  }
  if (fallbackAmm && isAddress(fallbackAmm)) return fallbackAmm as `0x${string}`;
  throw new Error("Could not resolve bonding curve address for this token");
}

/**
 * Extracts a human-readable revert reason from a viem error so the exact
 * on-chain failure (SlippageExceeded, CurveClosed, InsufficientValue, ...)
 * is visible in the console instead of a generic "transaction failed".
 */
function describeTxError(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk(
      (e) => e instanceof ContractFunctionRevertedError
    ) as ContractFunctionRevertedError | null;
    if (revert) {
      const name = revert.data?.errorName ?? revert.shortMessage;
      return `revert: ${name}`;
    }
    return err.shortMessage || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

const publicClient = createPublicClient({
  transport: http('https://rpc.testnet.chain.robinhood.com')
});


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
  pair_currency_address?: string;
  pairCurrencyAddress?: string;
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
  sniper_retention_pct?: number;
  sniperRetentionPct?: number;
}

/**
 * Shallow-compares two DBToken rows. Used by the 10s polling reconciler to
 * decide whether a token actually changed; when it did not, the previous
 * object reference is reused so downstream `useMemo`/`React.memo` boundaries
 * stay referentially stable and the UI (incl. the Vibe Score) does not
 * re-render/flicker on every poll tick.
 */
function shallowEqualToken(a: DBToken, b: DBToken): boolean {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const av = (a as Record<string, unknown>)[key];
    const bv = (b as Record<string, unknown>)[key];
    if (av !== bv) return false;
  }
  return true;
}

function getDevProfile(devAddress: string, allTokens: DBToken[]) {
  if (!devAddress || !allTokens) return { label: "Neutral / Unproven Dev", color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30", launches: 1, gradRate: 0 };

  const devLaunches = allTokens.filter(t => (t.dev_address || t.devAddress || "").toLowerCase() === devAddress.toLowerCase());
  const launches = devLaunches.length;

  if (launches === 0) return { label: "Neutral / Unproven Dev", color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30", launches: 1, gradRate: 0 };

  // Use the SHARED graduation predicate so V6 tokens (which express graduation
  // via `lifecycle` / `graduated` rather than a 100% curve progress) are counted
  // correctly. Checking only `curve_progress` produced a 0% rate for graduated
  // V6 launches.
  const graduated = devLaunches.filter(t => isTokenGraduated(t)).length;
  const gradRate = launches > 0 ? Math.round((graduated / launches) * 100) : 0;

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

/**
 * Builds safety checks from REAL data only. No pseudo-random fabrication.
 * `mev` is derived from observed fee-event count; `creatorBag` starts in a
 * neutral "pending" state until the holders endpoint resolves it.
 */
function getSafetyChecks(
  feeEventCount: number,
  hasSocials: boolean,
  creatorHoldingPct: number | null
) {
  return {
    socials: hasSocials
      ? { label: "Linked (X & TG)", safe: true }
      : { label: "Ghost Launch (No Socials)", safe: false },
    mev: feeEventCount <= 5
      ? { label: "Low Risk (< 5%)", safe: true }
      : { label: "Elevated Activity", safe: true },
    creatorBag:
      creatorHoldingPct == null
        ? { label: "Checking...", safe: true }
        : creatorHoldingPct <= 5
          ? { label: `Safe (${creatorHoldingPct.toFixed(1)}% Supply)`, safe: true }
          : { label: `High Risk (${creatorHoldingPct.toFixed(1)}% Supply)`, safe: false },
  };
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
  const { sendTransaction, isPending: isTxPending, data: hash, reset: resetSendTransaction } = useSendTransaction();
  const { data: receipt, isLoading: isTxWaiting, isSuccess: isTxSuccess } = useWaitForTransactionReceipt({ hash });

  const [activeFilter, setActiveFilter] = useState<RadarFilter>("all");
  const [dbTokens, setDbTokens] = useState<DBToken[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedToken, setSelectedToken] = useState<any | null>(null);
  const [onChainToken, setOnChainToken] = useState<any | null>(null);
  const [isSearchingChain, setIsSearchingChain] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isSyncingLive, setIsSyncingLive] = useState(false);

  const [apeAmount, setApeAmount] = useState<string>("0.005");
  const [sellAmount, setSellAmount] = useState<string>("1000");
  const [tradeTab, setTradeTab] = useState<'buy' | 'sell'>('buy');
  const [topHolders, setTopHolders] = useState<{ address: string, pct: number }[]>([]);
  const [devStats, setDevStats] = useState<{ launches: number; gradRate: number; label: string; color: string; } | null>(null);

  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const activeTokenRef = useRef<string | null>(null);

  // User Portfolio drawer visibility.
  const [isPortfolioOpen, setIsPortfolioOpen] = useState(false);

  // Ref wrapping the token header + live telemetry + Vibe Score block that the
  // "Share 📸" button snapshots into a PNG.
  const shareCardRef = useRef<HTMLDivElement | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);

  // Cache of REAL, API-derived metrics keyed by lowercase contract address.
  // Both the homepage cards and the detail view read from this so they can
  // never disagree on market cap / volume / curve progress.
  const [liveMetrics, setLiveMetrics] = useState<Record<string, LiveTokenMetrics>>({});
  const liveMetricsRef = useRef<Record<string, LiveTokenMetrics>>({});
  const inFlightRef = useRef<Set<string>>(new Set());
  // Monotonic per-token fetch sequence. Every fetch (grid poller OR detail
  // poller) claims the next number for its token; a fetch may only commit its
  // result to state if it still owns the LATEST sequence for that token. This
  // is the core race-condition guard: a slow, older request that resolves
  // after a newer one is silently discarded instead of clobbering fresh data
  // (the cause of the Market Cap / Volume flashing between values).
  const fetchSeqRef = useRef<Map<string, number>>(new Map());
  // Tracks whether the ETH/quote oracle price has been loaded from the API at
  // least once. Until it has, USD-denominated metrics must NOT be rendered —
  // they would be computed against the hard-coded seed rate and then jump when
  // the real oracle price arrives.
  const [oracleReady, setOracleReady] = useState(false);
  const oracleReadyRef = useRef(false);
  // Mirror of the oracle rates so background pollers always read the freshest
  // prices WITHOUT the polling effects having to re-subscribe on every sync.
  const liveRatesRef = useRef<Record<string, number>>({});
  // Tracks which tokens have ever received real API metrics. Used to decide
  // whether a poll is an initial load (show syncing/blur) or a background
  // refresh (update silently, never re-trigger the blur).
  const resolvedOnceRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    activeTokenRef.current = selectedToken?.contractAddress || null;
  }, [selectedToken?.contractAddress]);

  // Auto-dismiss the transaction status toast 5s after the tx settles
  // (success or revert). Without this the "Confirming…/Confirmed/Reverted"
  // banner lingered forever and made the trade box look stuck.
  useEffect(() => {
    if (!hash) return;
    if (!isTxSuccess && receipt?.status !== "reverted") return;
    const timer = setTimeout(() => {
      resetSendTransaction();
    }, 5000);
    return () => clearTimeout(timer);
  }, [hash, isTxSuccess, receipt?.status, resetSendTransaction]);

  // Reset all transaction state whenever the user opens a different token, so
  // a new detail drawer always starts with a clean UI slate (no stale hash or
  // success/revert banner from the previously viewed token).
  useEffect(() => {
    resetSendTransaction();
  }, [selectedToken?.contractAddress, resetSendTransaction]);

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
          const mergedRates = { ...liveRatesRef.current, ...oracleRates, ETH: ethPrice, WETH: ethPrice };
          // CRITICAL: mirror the merged rates into the ref BEFORE/alongside the
          // state update. The background pollers (`fetchLiveMetricsFor` and
          // `fetchLiveToken`) read `liveRatesRef.current` — NOT the `liveRates`
          // state — so if the ref is never written it stays `{}` forever and
          // every non-ETH quote asset resolves to a null USD rate, forcing the
          // synthetic fallback. This was the root cause of the $18.5K / $55.8K /
          // $220K divergence.
          liveRatesRef.current = mergedRates;
          setLiveRates(mergedRates);
          // Mark the oracle as loaded so USD metrics may now be rendered. Until
          // this flips, the UI shows "Syncing..." instead of computing values
          // against the hard-coded seed rate (which caused the initial flash).
          oracleReadyRef.current = true;
          setOracleReady(true);
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
      const res = await fetch('/api/tokens', { cache: 'no-store' });
      if (!res.ok) {
        console.error('Turso fetch error:', res.status);
        return;
      }
      const data: DBToken[] = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        setDbTokens(data);
      }
    } catch (err) {
      console.error("Database sync failed", err);
    }
  };

  // High-speed polling from our local JSON database API or Turso
  useEffect(() => {
    fetchDatabase();
    const interval = setInterval(fetchDatabase, 3000); // Check for new tokens every 3 seconds
    return () => clearInterval(interval);
  }, []);

  // Keep a ref mirror of liveMetrics so async fetchers can read the latest
  // cache without re-subscribing.
  useEffect(() => {
    liveMetricsRef.current = liveMetrics;
  }, [liveMetrics]);

  // Keep a ref mirror of the oracle rates so background pollers always use the
  // freshest prices without forcing their intervals to restart on every sync.
  useEffect(() => {
    liveRatesRef.current = liveRates;
  }, [liveRates]);

  /**
   * Fetches REAL market metrics for a single token from `/api/proxyVibe` and
   * stores the normalized result in `liveMetrics`. This is the shared source
   * of truth for both the homepage cards and the detail view.
   */
  const fetchLiveMetricsFor = async (contractAddress: string, fallback?: Partial<LiveTokenMetrics>) => {
    const key = contractAddress.toLowerCase();
    if (!key || inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);
    // Claim the next sequence number for this token. Only the fetch that still
    // owns the latest sequence is allowed to commit to state, so a slow older
    // request can never overwrite a newer one's result.
    const seq = (fetchSeqRef.current.get(key) ?? 0) + 1;
    fetchSeqRef.current.set(key, seq);
    const isLatest = () => fetchSeqRef.current.get(key) === seq;
    // Hard client-side ceiling so a slow/blocked proxy can never leave a card
    // stuck on the synthetic fallback. The proxy itself now responds in <3s
    // (oracle is non-blocking), so 12s is a generous safety net.
    const controller = new AbortController();
    const clientTimeout = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(`/api/proxyVibe?address=${key}&t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });

      if (!res.ok) {
        // Upstream unreachable / timed out. Do NOT overwrite the cache with
        // zeros — keep whatever real metrics we already have, and only seed a
        // fallback-derived entry if this token has never been resolved.
        const body = await res.json().catch(() => null);
        console.warn(
          `[liveMetrics] proxyVibe HTTP ${res.status} for ${key}:`,
          body?.reason || body?.error || 'unknown'
        );
        // Only the latest fetch may seed a fallback entry; a stale error
        // response must not resurrect a placeholder over newer real data.
        if (!isLatest()) return;
        setLiveMetrics((prev) => {
          if (prev[key]) return prev; // preserve last-known-good real data
          if (!fallback) return prev;
          return {
            ...prev,
            [key]: {
              ...(fallback as LiveTokenMetrics),
              contractAddress: key,
              // Mark as unresolved so the UI can show an estimate, not a fake $0.
              priceUsd: fallback.priceUsd ?? 0,
            },
          };
        });
        return;
      }

      const json = await res.json();
      // Read the freshest oracle rates from the ref so this poller never needs
      // to re-subscribe when `liveRates` changes.
      const normalized = await normalizeVibeResponse(
        json,
        liveRatesRef.current,
        { ...fallback, contractAddress: key },
        async (addr) => {
          try {
            return (await publicClient.readContract({
              address: addr as `0x${string}`,
              abi: ERC20_SYMBOL_ABI,
              functionName: 'symbol',
            })) as string;
          } catch {
            return null;
          }
        }
      );

      // STALE-GUARD: if a newer fetch for this token was issued while this one
      // was in flight, discard this result entirely. Without this, a slow
      // response could overwrite fresher Market Cap / Volume values, producing
      // the reported "flash to $26.1K then back" behaviour.
      if (!isLatest()) {
        console.warn(`[liveMetrics] discarding stale response for ${key} (seq ${seq})`);
        return;
      }

      // Mark this token as resolved so the card's blur is permanently lifted
      // and never re-triggered by subsequent background refreshes.
      resolvedOnceRef.current.add(key);

      setLiveMetrics((prev) => ({ ...prev, [key]: normalized }));

      // Keep the detail view in lock-step with the grid: if the token the user
      // is currently viewing was just refreshed by the grid poller, publish the
      // same numbers into `selectedToken` so both surfaces never drift.
      if (activeTokenRef.current?.toLowerCase() === key) {
        setSelectedToken((prev: any) => {
          if (!prev) return prev;
          return {
            ...prev,
            bondingCurveProgress: normalized.bondingCurveProgress,
            ethDeposited: normalized.ethDeposited,
            pairSymbol: normalized.pairSymbol,
            symbol: normalized.symbol || prev.symbol,
            devAddress: normalized.devAddress || prev.devAddress,
            hasSocials: normalized.hasSocials,
            socialLinks: normalized.socialLinks,
            marketCapUsd: normalized.marketCapUsd,
            volumeEth: normalized.volumeEth,
            volumeUsd: normalized.volumeUsd,
            momentum: {
              buyPct: normalized.buyPct,
              sellPct: normalized.sellPct,
              volumeEth: normalized.volumeEth,
              volumeUsd: normalized.volumeUsd,
            },
          };
        });
      }
    } catch (err: any) {
      // Network-level failure (offline, DNS, CORS) or client timeout.
      // Preserve existing cache so we never zero out real data.
      const reason = err?.name === 'AbortError' ? 'client timeout (12s)' : err?.message || String(err);
      console.error(`[liveMetrics] fetch failed for ${key}: ${reason}`);
    } finally {
      clearTimeout(clientTimeout);
      inFlightRef.current.delete(key);
    }
  };

  // Poll real metrics for every visible token so the homepage cards always
  // reflect the same numbers the detail view will show.
  //
  // NOTE: this effect intentionally does NOT depend on `liveRates` — the poller
  // reads rates via `liveRatesRef`, so an oracle sync no longer tears down and
  // restarts the interval (which previously caused a burst of refetches and
  // visible card churn every 45s).
  useEffect(() => {
    if (dbTokens.length === 0) return;
    const addresses = dbTokens
      .map((db) => (db.token_address || db.tokenAddress || '').toLowerCase())
      .filter(Boolean)
      .slice(0, 30);

    addresses.forEach((addr) => fetchLiveMetricsFor(addr));
    const interval = setInterval(() => {
      addresses.forEach((addr) => fetchLiveMetricsFor(addr));
    }, 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbTokens.length]);

  // Turso/libSQL has no realtime subscription channel, so we poll the
  // `/api/tokens` route (which reads the same `launches` table) on an interval
  // and reconcile inserts/updates into local state.
  useEffect(() => {
    let cancelled = false;

    const pollTokens = async () => {
      try {
        const res = await fetch('/api/tokens', { cache: 'no-store' });
        if (!res.ok) return;
        const rows: DBToken[] = await res.json();
        if (cancelled || !Array.isArray(rows)) return;

        setDbTokens((prev) => {
          const byAddress = new Map<string, DBToken>();
          for (const t of prev) {
            const key = (t.tokenAddress || t.token_address || '').toLowerCase();
            if (key) byAddress.set(key, t);
          }

          let changed = false;
          for (const row of rows) {
            const key = (row.tokenAddress || row.token_address || '').toLowerCase();
            if (!key) continue;
            const existing = byAddress.get(key);
            if (!existing) {
              // Brand-new token — always a real change.
              byAddress.set(key, row);
              changed = true;
              continue;
            }
            // Reconcile field-by-field and REUSE the previous object reference
            // when every value is identical. This keeps `processedTokens` /
            // `filteredTokens` referentially stable across the 10s poll, so
            // memoized cards and the detail drawer do not re-render (and the
            // Vibe Score does not flicker) when nothing actually changed.
            const merged = { ...existing, ...row };
            if (!shallowEqualToken(existing, merged)) {
              byAddress.set(key, merged);
              changed = true;
            }
          }

          // Preserve insertion order but avoid allocating a new array (and thus
          // new element identities) when nothing changed.
          if (!changed && byAddress.size === prev.length) return prev;
          return Array.from(byAddress.values());
        });

        if (
          activeTokenRef.current &&
          rows.some(
            (r) =>
              (r.tokenAddress || r.token_address || '').toLowerCase() ===
              activeTokenRef.current!.toLowerCase()
          )
        ) {
          setRefreshTrigger((prev) => prev + 1);
        }
      } catch {
        /* transient network hiccup — retry on next tick */
      }
    };

    pollTokens();
    const interval = setInterval(pollTokens, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
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

      const block0 = Number(db.block_zero_buyers ?? 0);

      // REAL sniper retention: percentage of block-0 snipers still holding.
      // Persisted by the indexer / indexToken route. When the field is absent
      // (legacy rows) we default to 100% retained (0% dumped) rather than
      // fabricating a value from the address hash.
      const rawRetention = db.sniper_retention_pct ?? db.sniperRetentionPct;
      const diamond =
        rawRetention == null || Number.isNaN(Number(rawRetention))
          ? 100
          : Math.max(0, Math.min(100, Number(rawRetention)));

      const isGraduated = (db as any).lifecycle === "GRADUATED" || (db as any).graduated === true || Number(db.curve_progress ?? db.curveProgress ?? db.bondingCurveProgress ?? 0) >= 100;
      let bondingCurveProgress = isGraduated ? 100 : Number(db.curve_progress ?? db.curveProgress ?? db.bondingCurveProgress ?? 0);
      if (!isGraduated && bondingCurveProgress > 0 && bondingCurveProgress < 0.1) {
        bondingCurveProgress = 0.1;
      }
      const ethDeposited = db.liquidity_deposited ?? db.ethDeposited ?? 0;

      // Prefer REAL API-derived metrics when available; fall back to Supabase.
      const live = liveMetrics[contractAddress.toLowerCase()];

      const buyPct = live?.buyPct ?? db.buy_pct ?? db.buyPct ?? 50;
      const sellPct = live?.sellPct ?? db.sell_pct ?? db.sellPct ?? 50;
      const volumeEth = live?.volumeEth ?? Number(db.volume_eth ?? db.volumeEth ?? 0).toFixed(4);
      const hasSocials = live?.hasSocials ?? db.has_socials ?? db.hasSocials ?? false;
      const creatorHoldingPct = Number(db.creator_holding_pct ?? db.creatorHoldingPct ?? 0);
      // Top-5 concentration is only known for the selected token (holders are
      // fetched on demand); when absent we pass 0 so the rule simply doesn't
      // fire rather than fabricating a risk.
      const top5Pct = Number((db as any).top5_pct ?? (db as any).top5Pct ?? 0);

      // When live data exists, its curve progress is authoritative.
      const resolvedCurveProgress = live ? live.bondingCurveProgress : bondingCurveProgress;
      const resolvedEthDeposited = live ? live.ethDeposited : ethDeposited;
      // The pair currency ADDRESS is the authoritative quote-asset key. It is
      // preferred over `pairSymbol`, which can be null (e.g. MOBLAND) or
      // mislabeled. Only fall back to 'ETH' when there is genuinely no pair
      // address (i.e. a native-ETH pair).
      const resolvedPairCurrencyAddress =
        live?.pairCurrencyAddress ||
        db.pair_currency_address ||
        db.pairCurrencyAddress ||
        "";
      const resolvedPairSymbol =
        live?.pairSymbol ||
        db.pair_symbol ||
        db.pairSymbol ||
        (resolvedPairCurrencyAddress &&
        resolvedPairCurrencyAddress !== "0x0000000000000000000000000000000000000000"
          ? ""
          : "ETH");

      const devProfile = getDevProfile(devAddress, dbTokens);
      const vibeParams: VibeScoreParams = {
        blockZeroBuyers: block0,
        timeSinceLaunchMins: live?.timeSinceLaunchMins ?? timeSinceLaunchMins,
        curveProgress: resolvedCurveProgress,
        diamondPct: diamond,
        volumeEth: Number(volumeEth),
        buyPct,
        hasSocials,
        creatorHoldingPct,
        top5Pct,
        totalLaunches: devProfile.launches,
        graduationRate: devProfile.gradRate,
        totalPreGradDumps: 0,
        isSerialDumper: false,
      };

      // Developer discipline stats. `totalPreGradDumps` is only known once the
      // profiler resolves for a token; grid rows default to 0 (no known dumps)
      // so the "Clean Devs" / "High Risk" filters never fabricate a risk.
      const totalPreGradDumps = Number(
        (db as any).total_pre_grad_dumps ?? (db as any).totalPreGradDumps ?? 0
      );
      const devStats = {
        launches: devProfile.launches,
        gradRate: devProfile.gradRate,
        totalPreGradDumps,
        isSerialDumper: totalPreGradDumps > 0,
      };

      return {
        id: (db.launch_id || db.launchId || "0").toString(),
        name: live?.name || db.name || "Unknown",
        ticker: live?.ticker || db.symbol || db.ticker || "TKN",
        symbol: live?.symbol || db.symbol,
        contractAddress,
        devAddress: live?.devAddress || devAddress,
        ammAddress: live?.ammAddress || ammAddress,
        bondingCurveProgress: resolvedCurveProgress,
        ethDeposited: resolvedEthDeposited,
        pairSymbol: resolvedPairSymbol,
        pairCurrencyAddress: resolvedPairCurrencyAddress,
        timeSinceLaunchMins: live?.timeSinceLaunchMins ?? timeSinceLaunchMins,
        blockZeroBuyers: block0,
        diamondHandsHoldersPct: diamond,
        totalSupply: 1000000000,
        creatorHoldingPct,
        top5Pct,
        cachedMarketCapFormatted: db.cachedMarketCapFormatted,
        // Real, API-derived market cap + volume (same values the detail view shows).
        marketCapUsd: live?.marketCapUsd,
        marketCapIsEstimate: live ? live.priceUsd === 0 : true,
        volumeUsd: live?.volumeUsd,
        score: calculateVibeScore(vibeParams),
        hasSocials: hasSocials,
        devProfile,
        devStats,
        safetyChecks: getSafetyChecks(0, hasSocials, null),
        momentum: {
          buyPct,
          sellPct,
          volumeEth
        }
      };
    });
  }, [dbTokens, liveMetrics]);

  const filteredTokens = useMemo(() => {
    let list = processedTokens;
    if (searchQuery) {
      const query = searchQuery.trim().toLowerCase();
      list = list.filter(token => token.contractAddress.toLowerCase().includes(query));
    }
    // Preset filter tabs. These are pure, in-memory predicates over the already
    // processed token list — switching tabs never triggers a data refetch, so
    // the grid updates instantly.
    switch (activeFilter) {
      case "alpha":
        // High Alpha: strong Vibe Score.
        return list.filter(t => t.score >= 70);
      case "graduating":
        // Graduating Soon: on the curve and close to (but not yet) graduated.
        return list.filter(t => t.bondingCurveProgress > 85 && t.bondingCurveProgress < 100);
      case "clean":
        // Clean Devs: creator holds nothing AND the dev has never dumped a
        // pre-graduation token.
        return list.filter(t => t.creatorHoldingPct === 0 && t.devStats.totalPreGradDumps === 0);
      case "risk":
        // High Risk / Sniped. This tab must rely ONLY on fields that are
        // guaranteed to exist on every grid row — `top5Pct` and
        // `devStats.totalPreGradDumps` are fetched on-demand for the detail
        // drawer and are usually 0/undefined at the grid level, which made this
        // tab return an empty array. Instead we catch tokens via:
        //   1. A low Vibe Score (the scoring engine already penalises
        //      concentrated supply, snipers and dumper devs).
        //   2. Block-0 snipers that are dumping (retention <= 50%).
        //   3. A creator bag > 15% when the grid row happens to carry it.
        return list.filter(
          (t) =>
            t.score <= 30 ||
            (t.blockZeroBuyers > 0 && t.diamondHandsHoldersPct <= 50) ||
            t.creatorHoldingPct > 15
        );
      default:
        return list;
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
            // A partial payload (market stats timed out upstream) still carries
            // the launch identity, so we can hydrate the detail view from it.
            const isPartial = json.data?.partial === true;
            if (!launch) throw new Error('Token launch data missing from API response');

            // Normalize seconds-vs-milliseconds: a 10-digit Unix timestamp fed
            // to `new Date()` would be read as 1970 and render a bogus multi-day
            // runtime. `parseCreatedAtMs` returns null when unparseable.
            const createdMs = parseCreatedAtMs(launch.createdAt);
            const timeLiveMins =
              createdMs == null ? 0 : Math.max(0, Math.floor((Date.now() - createdMs) / 60000));

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
            const onChainDevAddress = launch.launcherAddress || launch.creatorAddress || query;
            const onChainDevProfile = getDevProfile(onChainDevAddress, dbTokens);
            const vibeScore = calculateVibeScore({
              blockZeroBuyers: 0,
              timeSinceLaunchMins: timeLiveMins,
              curveProgress,
              diamondPct: 50,
              volumeEth: totalVolume,
              buyPct: buyRatio,
              hasSocials,
              creatorHoldingPct: 0,
              totalLaunches: onChainDevProfile.launches,
              graduationRate: onChainDevProfile.gradRate,
              totalPreGradDumps: 0,
              isSerialDumper: false,
            });

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
              safetyChecks: getSafetyChecks(feeEvents.length, hasSocials, null),
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

            // JIT INGESTION: persist the freshly-discovered token into Turso
            // so it becomes a first-class grid entry (and survives reloads).
            // Fire-and-forget so a slow/failed write never blocks the UI.
            void (async () => {
              try {
                const row = {
                  launch_id: Number(launch.id) || undefined,
                  token_address: launch.tokenAddress,
                  amm_address: launch.curveAddress || null,
                  dev_address: launch.launcherAddress || launch.creatorAddress || query,
                  liquidity_deposited: currentEth,
                  pair_symbol: resolvedSymbol,
                  curve_progress: curveProgress,
                  name: launch.name || null,
                  symbol: launch.symbol || null,
                  created_at: launch.createdAt || new Date().toISOString(),
                };
                const res = await fetch(
                  `/api/indexToken?address=${encodeURIComponent(launch.tokenAddress)}`,
                  { method: 'GET', cache: 'no-store' }
                );
                if (!res.ok) {
                  console.warn('[JIT] Turso index failed:', res.status);
                } else {
                  // Optimistically surface it in the grid immediately; the
                  // polling loop will reconcile it.
                  setDbTokens((prev) => {
                    const exists = prev.some(
                      (t) => (t.token_address || t.tokenAddress || '').toLowerCase() === launch.tokenAddress.toLowerCase()
                    );
                    if (exists) return prev;
                    return [row as DBToken, ...prev];
                  });
                }
              } catch (upsertErr) {
                console.warn('[JIT] Turso index threw:', upsertErr);
              }
            })();
          } else {
            const errData = await res.json().catch(() => ({}));
            const errMsg = errData.error || "Failed to fetch from VibeVibe API";
            console.error("VibeVibe API failed:", errMsg);
            // A 404 genuinely means "not found". Anything else (502/504) is a
            // transient upstream failure — surface a soft message rather than
            // the alarming "JIT Failed" banner.
            setSearchError(res.status === 404 ? errMsg : "Upstream temporarily unavailable — retry shortly");
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

    // Reset the resolved profiler stats on token switch. Without this, the
    // panel would display the PREVIOUS token's launches/graduation rate until
    // the new profiler fetch resolves — and indefinitely if that fetch fails.
    // Clearing to null makes the panel fall back to the selected token's own
    // `devProfile` (grid-derived) until fresh, authoritative data arrives.
    setDevStats(null);

    /**
     * Hydrates the telemetry panel from on-chain/contract metrics when the
     * proxy is slow, times out, or returns a partial payload. This is the
     * guaranteed fallback that prevents the panel from hanging on
     * "SYNCING..." / "MC: ..." indefinitely.
     */
    const hydrateFromOnChain = async (seq: number) => {
      const detailKey = selectedToken.contractAddress.toLowerCase();
      // Only hydrate if this detail fetch still owns the latest sequence for
      // the token — otherwise a slow on-chain read could overwrite the fresh
      // API metrics a newer fetch already committed.
      const isLatest = () => fetchSeqRef.current.get(detailKey) === seq;
      try {
        // Read the raw ETH reserve directly from the bonding curve contract
        // when the API is unavailable. `pairReserveUnits`/`netRaisedWei` are
        // the same fields the normalizer consumes, so the derived curve
        // progress stays consistent with the API path.
        let onChainEth = 0;
        const amm = selectedToken.ammAddress as `0x${string}` | undefined;
        if (amm) {
          try {
            const reserve = await publicClient.readContract({
              address: amm,
              abi: [
                { name: 'pairReserveUnits', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
              ] as const,
              functionName: 'pairReserveUnits',
            });
            onChainEth = Number(formatEther(reserve as bigint));
          } catch {
            // Contract may not expose that getter — fall back to the last
            // known curve progress already held in state.
          }
        }

        const targetEth = 4; // default bonding-curve target (ETH-equivalent)
        const fallbackProgress =
          onChainEth > 0
            ? Math.min(100, Math.max(0.1, (onChainEth / targetEth) * 100))
            : selectedToken.bondingCurveProgress ?? 0;

        // Publish a metrics entry so the grid card and detail view agree.
        // Preserve any REAL market cap / volume we already hold. Writing a
        // literal '$0.00' here would poison the shared `liveMetrics` cache: the
        // grid card reads `marketCapUsd` as a truthy string and renders "$0.00"
        // (or, if empty, falls through to the synthetic target). Leaving these
        // undefined keeps the UI in the "Syncing..." state until valid data
        // arrives from the API.
        const priorMarketCapUsd =
          selectedToken.marketCapUsd && selectedToken.marketCapUsd !== '$0.00'
            ? selectedToken.marketCapUsd
            : undefined;
        const priorVolumeUsd =
          selectedToken.volumeUsd && selectedToken.volumeUsd !== '$0.00'
            ? selectedToken.volumeUsd
            : undefined;

        const fallbackMetrics: LiveTokenMetrics = {
          contractAddress: detailKey,
          name: selectedToken.name || 'Unknown',
          ticker: selectedToken.ticker || 'TKN',
          symbol: selectedToken.symbol || '',
          pairSymbol: selectedToken.pairSymbol || 'ETH',
          bondingCurveProgress: fallbackProgress,
          ethDeposited: onChainEth > 0 ? `${onChainEth.toFixed(4)} / ${targetEth.toFixed(1)}` : (selectedToken.ethDeposited || '0.0000 / 4.0'),
          marketCapUsd: priorMarketCapUsd,
          marketCapRaw: 0,
          volumeEth: selectedToken.volumeEth || '0.0000',
          volumeUsd: priorVolumeUsd,
          buyPct: selectedToken.momentum?.buyPct ?? 50,
          sellPct: selectedToken.momentum?.sellPct ?? 50,
          priceUsd: 0,
          hasSocials: selectedToken.hasSocials ?? false,
          socialLinks: selectedToken.socialLinks || {},
          devAddress: selectedToken.devAddress || '',
          ammAddress: selectedToken.ammAddress || '',
          timeSinceLaunchMins: selectedToken.timeSinceLaunchMins ?? 0,
          isGraduated: fallbackProgress >= 100,
          imageUri: selectedToken.imageUri,
          isLegacy: selectedToken.isLegacy ?? false,
        };

        if (!isMounted || !isLatest()) return;
        resolvedOnceRef.current.add(detailKey);
        setLiveMetrics((prev) => ({ ...prev, [detailKey]: fallbackMetrics }));
        setSelectedToken((prev: any) => {
          if (!prev) return prev;
          return {
            ...prev,
            bondingCurveProgress: fallbackProgress,
            ethDeposited: fallbackMetrics.ethDeposited,
            pairSymbol: fallbackMetrics.pairSymbol,
          };
        });
      } catch (err) {
        console.warn('[detail] on-chain hydration failed:', err);
      } finally {
        // Always lift the syncing state so the panel can never hang.
        if (isMounted) setIsSyncingLive(false);
      }
    };

    const fetchLiveToken = () => {
      const detailKey = selectedToken.contractAddress.toLowerCase();
      // Claim the next sequence for this token so this detail fetch and the
      // grid poller share a single ordering. Only the latest owner may commit.
      const seq = (fetchSeqRef.current.get(detailKey) ?? 0) + 1;
      fetchSeqRef.current.set(detailKey, seq);
      const isLatest = () => fetchSeqRef.current.get(detailKey) === seq;
      // Only surface the "Syncing..." state on the FIRST load for this token.
      // Background refreshes update silently so the telemetry panel never
      // flashes placeholders (or re-triggers the card blur) every 5 seconds.
      if (!resolvedOnceRef.current.has(detailKey)) {
        setIsSyncingLive(true);
      }
      // Hard client-side ceiling: if the proxy hasn't answered in 5s we abort
      // and hydrate from on-chain metrics rather than hanging on "SYNCING...".
      const controller = new AbortController();
      const clientTimeout = setTimeout(() => controller.abort(), 5000);
      fetch(`/api/proxyVibe?address=${selectedToken.contractAddress}&t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
        .then(async res => {
          if (!isMounted) return;

          // Guard against error payloads (404/502/504). Parsing an error body
          // and feeding it to the normalizer would zero out every metric.
          // Instead, hydrate from on-chain metrics so the panel still renders.
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            console.warn(
              `[detail] proxyVibe ${res.status} for ${selectedToken.contractAddress}:`,
              body?.reason || body?.error || 'unknown'
            );
            await hydrateFromOnChain(seq);
            return;
          }

          const json = await res.json();
          if (!isMounted) return;

          // Use the SAME normalizer the homepage cards use, so both views
          // derive every shared metric from identical logic.
          const metrics = await normalizeVibeResponse(
            json,
            liveRatesRef.current,
            {
              contractAddress: selectedToken.contractAddress,
              name: selectedToken.name,
              ticker: selectedToken.ticker,
              symbol: selectedToken.symbol,
              pairSymbol: selectedToken.pairSymbol,
              devAddress: selectedToken.devAddress,
              ammAddress: selectedToken.ammAddress,
              timeSinceLaunchMins: selectedToken.timeSinceLaunchMins,
              bondingCurveProgress: selectedToken.bondingCurveProgress,
            },
            async (addr) => {
              try {
                return (await publicClient.readContract({
                  address: addr as `0x${string}`,
                  abi: ERC20_SYMBOL_ABI,
                  functionName: 'symbol',
                })) as string;
              } catch {
                return null;
              }
            }
          );

          // PARTIAL PAYLOAD: the proxy returned launch identity but market
          // stats timed out upstream. The normalizer already degraded volume /
          // market cap gracefully; additionally hydrate the curve progress from
          // on-chain reserves so the telemetry panel shows real numbers.
          if (json.data?.partial === true) {
            console.warn(`[detail] partial payload for ${detailKey} — hydrating on-chain metrics`);
            await hydrateFromOnChain(seq);
          }

          // STALE-GUARD: a newer fetch for this token superseded us while the
          // response was in flight — discard so we never overwrite fresher
          // Market Cap / Volume values.
          if (!isMounted || !isLatest()) return;

          // Mark resolved so the card blur is lifted permanently and future
          // background refreshes never re-trigger the syncing state.
          resolvedOnceRef.current.add(metrics.contractAddress);

          // Publish to the shared cache so the homepage card for this token
          // immediately reflects the same numbers.
          setLiveMetrics((prev) => ({ ...prev, [metrics.contractAddress]: metrics }));

          const launch = json.data?.launch || (json.data?.tokenAddress ? json.data : null);
          const poolAddr = (launch?.graduation?.poolId || launch?.poolAddress || launch?.pool?.address || "").toLowerCase();

          // Final stale-guard before mutating the detail view. If a newer fetch
          // superseded us, bail so the drawer keeps the fresher numbers.
          if (!isMounted || !isLatest()) return;

          setSelectedToken((prev: any) => ({
            ...prev,
            isLegacy: prev?.isLegacy || metrics.isLegacy,
            bondingCurveProgress: metrics.bondingCurveProgress,
            ethDeposited: metrics.ethDeposited,
            pairSymbol: metrics.pairSymbol,
            symbol: metrics.symbol || prev?.symbol,
            devAddress: metrics.devAddress || prev?.devAddress,
            score: calculateVibeScore({
              blockZeroBuyers: prev?.blockZeroBuyers || 0,
              timeSinceLaunchMins: metrics.timeSinceLaunchMins,
              curveProgress: metrics.bondingCurveProgress,
              diamondPct: prev?.diamondHandsHoldersPct || 50,
              volumeEth: Number(metrics.volumeEth),
              buyPct: metrics.buyPct,
              hasSocials: metrics.hasSocials,
              creatorHoldingPct: 0,
              totalLaunches: prev?.devProfile?.launches ?? 0,
              graduationRate: prev?.devProfile?.gradRate ?? 0,
              totalPreGradDumps: 0,
              isSerialDumper: false,
            }),
            hasSocials: metrics.hasSocials,
            socialLinks: metrics.socialLinks,
            poolAddress: poolAddr || prev?.poolAddress,
            marketCapUsd: metrics.marketCapUsd,
            momentum: {
              buyPct: metrics.buyPct,
              sellPct: metrics.sellPct,
              volumeEth: metrics.volumeEth,
              volumeUsd: metrics.volumeUsd,
            },
            volumeEth: metrics.volumeEth,
            volumeUsd: metrics.volumeUsd,
            safetyChecks: {
              ...prev?.safetyChecks,
              mev: metrics.priceUsd > 0
                ? { label: "Low Risk (< 5%)", safe: true }
                : { label: "Checking...", safe: true },
              creatorBag: prev?.safetyChecks?.creatorBag || { label: "Checking...", safe: true },
            },
          }));
        })
        .catch(async (err) => {
          // Client timeout (AbortError) or network failure: hydrate from
          // on-chain metrics so the panel renders real numbers instead of
          // hanging on "SYNCING..." / "MC: ...".
          const reason = err?.name === 'AbortError' ? 'client timeout (5s)' : err?.message || String(err);
          console.warn(`[detail] proxyVibe fetch failed for ${detailKey}: ${reason}`);
          await hydrateFromOnChain(seq);
        })
        .finally(() => {
          clearTimeout(clientTimeout);
          // Only clear the syncing flag if this fetch was the initial load for
          // this token AND it still owns the latest sequence. A superseded
          // fetch must not clear the flag set by a newer in-flight load.
          if (!resolvedOnceRef.current.has(detailKey) && isLatest()) {
            setIsSyncingLive(false);
          }
        });
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

    // Resolve the developer address from EVERY shape the token may carry:
    //   - `devAddress`     : canonical internal key (set by the normalizer).
    //   - `launcherAddress`: V6-native creator field.
    //   - `creatorAddress` : legacy creator field.
    // Non-SIGNAL tokens frequently arrive with only the V6/legacy field set, so
    // reading `devAddress` alone passed an empty string to the profiler and the
    // panel reported "0 launches".
    const creatorWallet = (
      selectedToken?.devAddress ||
      (selectedToken as any)?.launcherAddress ||
      (selectedToken as any)?.creatorAddress ||
      ""
    ).toLowerCase();
    if (creatorWallet && creatorWallet !== "0x" && creatorWallet !== "0x0000000000000000000000000000000000000000") {
      fetch(`/api/proxyDev?address=${creatorWallet}`)
        .then(devRes => {
          // A 502 means the upstream launch data was unavailable. Throw so the
          // .catch() below fires and the existing devStats/UI state is preserved
          // instead of being overwritten with zeros.
          if (!devRes.ok) throw new Error(`Profiler upstream ${devRes.status}`);
          return devRes.json();
        })
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
      // Reset the syncing indicator on token switch / unmount so a pending
      // initial load can never leave the panel stuck in "Syncing...".
      setIsSyncingLive(false);
    };
  }, [selectedToken?.contractAddress, refreshTrigger]);

  /**
   * BUY — native ETH -> curve token via `curve.buyExactIn`.
   *
   * Spec (vibevibe.md §5/§6):
   *   buyExactIn(uint256 maxPairIn, uint256 minNetOut, address recipient, uint256 deadline) payable
   *   - `value` MUST equal `maxPairIn` (the ETH sent in).
   *   - `minNetOut` is derived from `quoteBuyExactIn(pairIn).net` minus slippage.
   *   - Only valid for ETH-paired tokens whose curve is not yet complete.
   */
  const handleExecuteApe = async () => {
    if (!selectedToken || !apeAmount || Number(apeAmount) <= 0) return;
    if (!address) {
      console.error("[trade] buy aborted: no connected wallet address");
      return;
    }

    try {
      const tokenAddress = selectedToken.contractAddress as `0x${string}`;
      const amountInWei = parseEther(apeAmount);
      const curve = await resolveCurveAddress(tokenAddress, selectedToken.ammAddress);

      // Pre-flight guards so we fail fast with a clear reason instead of a revert.
      const [pairCurrency, complete] = await Promise.all([
        publicClient.readContract({ address: curve, abi: CURVE_ABI, functionName: "pairCurrency" }),
        publicClient.readContract({ address: curve, abi: CURVE_ABI, functionName: "complete" }),
      ]);

      if (complete) {
        console.error("[trade] buy aborted: CurveClosed() — curve already graduated");
        return;
      }
      if ((pairCurrency as string).toLowerCase() !== ZERO_ADDRESS) {
        console.error(
          "[trade] buy aborted: token is not ETH-paired; use the zap router on vibe/vibe for non-ETH pairs"
        );
        return;
      }

      // Quote immediately before trading (spec §4: always quote right before trading).
      const quote = (await publicClient.readContract({
        address: curve,
        abi: CURVE_ABI,
        functionName: "quoteBuyExactIn",
        args: [amountInWei],
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      const netOut = quote[1];

      if (netOut <= 0n) {
        console.error("[trade] buy aborted: quote returned 0 net tokens");
        return;
      }

      // 3% slippage tolerance on the quoted net output.
      const minNetOut = (netOut * (BPS_DENOMINATOR - SLIPPAGE_BPS)) / BPS_DENOMINATOR;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

      const data = encodeFunctionData({
        abi: CURVE_ABI,
        functionName: "buyExactIn",
        args: [amountInWei, minNetOut, address as `0x${string}`, deadline],
      });

      console.log(
        `[trade] BUY curve=${curve} ethIn=${apeAmount} minNetOut=${minNetOut.toString()}`
      );

      sendTransaction({
        to: curve,
        value: amountInWei,
        data,
        chainId: 46630,
      });
    } catch (err) {
      console.error("[trade] BUY failed:", describeTxError(err), err);
    }
  };

  /**
   * SELL — curve token -> native ETH via `curve.sell`.
   *
   * Spec (vibevibe.md §5/§6): "Selling on the curve needs NO approve: tokens
   * already allow their own curve." So this executes the sell directly on
   * click — no allowance check, no approve transaction, no waiting.
   *
   *   sell(uint256 grossTokens, uint256 minPairOut, address recipient, uint256 deadline)
   */
  const handleExecuteSell = async () => {
    if (!selectedToken || !sellAmount || Number(sellAmount) <= 0) return;
    if (!address) {
      console.error("[trade] sell aborted: no connected wallet address");
      return;
    }

    try {
      const tokenAddress = selectedToken.contractAddress as `0x${string}`;
      const grossTokens = parseEther(sellAmount);
      const curve = await resolveCurveAddress(tokenAddress, selectedToken.ammAddress);

      const complete = await publicClient.readContract({
        address: curve,
        abi: CURVE_ABI,
        functionName: "complete",
      });
      if (complete) {
        console.error("[trade] sell aborted: CurveClosed() — curve already graduated");
        return;
      }

      // Quote the exact pair-currency proceeds right before selling.
      const quote = (await publicClient.readContract({
        address: curve,
        abi: CURVE_ABI,
        functionName: "quoteSell",
        args: [grossTokens],
      })) as readonly [bigint, bigint, bigint, bigint];
      const pairOut = quote[3];

      if (pairOut <= 0n) {
        console.error("[trade] sell aborted: quote returned 0 pair out");
        return;
      }

      // 3% slippage tolerance on the quoted proceeds.
      const minPairOut = (pairOut * (BPS_DENOMINATOR - SLIPPAGE_BPS)) / BPS_DENOMINATOR;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

      const data = encodeFunctionData({
        abi: CURVE_ABI,
        functionName: "sell",
        args: [grossTokens, minPairOut, address as `0x${string}`, deadline],
      });

      console.log(
        `[trade] SELL curve=${curve} grossTokens=${sellAmount} minPairOut=${minPairOut.toString()} (no approve)`
      );

      // Direct call — the curve is pre-approved by the token contract itself.
      sendTransaction({
        to: curve,
        value: 0n,
        data,
        chainId: 46630,
      });
    } catch (err) {
      console.error("[trade] SELL failed:", describeTxError(err), err);
    }
  };

  // Memoized so the detail-drawer score only re-renders when the integer score
  // actually changes — not when the parent replaces `selectedToken` with a new
  // object reference on every 10s poll tick.
  const VibeScoreDisplay = useMemo(
    () =>
      memo(function VibeScoreDisplay({ score }: { score: number }) {
        const color =
          score >= 70
            ? "text-emerald-400"
            : score >= 45
              ? "text-yellow-400"
              : "text-red-400";
        return <span className={`text-3xl font-bold ${color}`}>{score}</span>;
      }),
    []
  );

  // Stable selection handler. Without this, a fresh inline arrow was created on
  // every render, defeating the `React.memo` on TokenCard and re-rendering all
  // cards (and their Vibe Scores) on each 10s poll.
  const handleSelectToken = useCallback((selected: TokenCardData) => {
    // Seed the detail view from the SAME cached live metrics the card is
    // displaying, so there is no stale-state jump.
    const live = liveMetrics[selected.contractAddress.toLowerCase()];
    setSelectedToken(
      live
        ? {
            ...selected,
            ...live,
            id: selected.id,
            blockZeroBuyers: (selected as any).blockZeroBuyers ?? 0,
            diamondHandsHoldersPct: (selected as any).diamondHandsHoldersPct ?? 50,
            devProfile: (selected as any).devProfile,
            safetyChecks: (selected as any).safetyChecks,
            momentum: {
              buyPct: live.buyPct,
              sellPct: live.sellPct,
              volumeEth: live.volumeEth,
              volumeUsd: live.volumeUsd,
            },
          }
        : selected
    );
  }, [liveMetrics]);

  /**
   * Captures the token header + live telemetry + Vibe Score block as a PNG and
   * triggers a download named `vibe-signal-[symbol].png`.
   *
   * The snapshot is rendered with an explicit dark background so the exported
   * image is legible regardless of the viewer's theme (the app is dark-only,
   * but the transparent PNG would otherwise show through on light backgrounds).
   */
  const handleShareImage = useCallback(async () => {
    const node = shareCardRef.current;
    if (!node || !selectedToken) return;
    setIsSharing(true);
    setShareStatus(null);
    try {
      const dataUrl = await toPng(node, {
        cacheBust: true,
        pixelRatio: 2,
        // Force a solid dark canvas so the PNG is readable everywhere.
        backgroundColor: "#09090b",
        style: {
          // Neutralise any transient hover/transform state during capture.
          transform: "none",
        },
      });

      const symbol = (selectedToken.symbol || selectedToken.ticker || "token")
        .toString()
        .replace(/[^a-zA-Z0-9]/g, "")
        .toLowerCase();
      const filename = `vibe-signal-${symbol || "token"}.png`;

      // Prefer the clipboard when available (nicer for social sharing), and
      // always fall back to a file download.
      let copied = false;
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && "write" in navigator.clipboard) {
          const blob = await (await fetch(dataUrl)).blob();
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob }),
          ]);
          copied = true;
        }
      } catch {
        // Clipboard image write is unsupported/blocked — fall through to download.
        copied = false;
      }

      const link = document.createElement("a");
      link.download = filename;
      link.href = dataUrl;
      link.click();

      setShareStatus(copied ? "Copied & downloaded ✓" : "Downloaded ✓");
    } catch (err) {
      console.error("[share] snapshot failed:", err);
      setShareStatus("Snapshot failed");
    } finally {
      setIsSharing(false);
      // Auto-clear the status toast.
      setTimeout(() => setShareStatus(null), 3000);
    }
  }, [selectedToken]);

  // A token is treated as graduated when the API reports it as such OR the
  // curve progress has reached 100%. Graduated tokens trade on the Uniswap v4
  // pool, not the bonding curve, so the terminal swaps to a DEX link.
  const isGraduated = !!selectedToken && (
    (selectedToken as any).isGraduated === true ||
    (selectedToken as any).lifecycle === "GRADUATED" ||
    (selectedToken as any).graduated === true ||
    Number(selectedToken.bondingCurveProgress ?? 0) >= 100
  );
  const vibeTradeUrl = selectedToken
    ? `https://testnet.vibevibe.fun/token/${selectedToken.contractAddress}`
    : undefined;

  const top5Pct = topHolders.reduce((acc, h) => acc + h.pct, 0);
  const devHolder = topHolders.find((h: any) => h.address.toLowerCase() === (selectedToken?.devAddress || "").toLowerCase());
  const creatorHoldingPct = devHolder ? devHolder.pct : 0;
  const isCabalRisk = selectedToken ? (top5Pct > 25 || (selectedToken.momentum?.sellPct ?? 0) >= 65 || selectedToken.safetyChecks?.creatorBag?.safe === false) : false;

  // Recompute the detail-view Vibe Score with the REAL holder concentration
  // once the holders endpoint resolves. This is what lets the Critical Risk
  // rules (creator > 15% / top-5 > 40% / dev dumps) actually fire — the score
  // produced during the initial fetch has no holder data yet.
  const detailScore = useMemo(() => {
    if (!selectedToken) return 0;
    return calculateVibeScore({
      blockZeroBuyers: selectedToken.blockZeroBuyers || 0,
      timeSinceLaunchMins: selectedToken.timeSinceLaunchMins,
      curveProgress: selectedToken.bondingCurveProgress,
      diamondPct: selectedToken.diamondHandsHoldersPct ?? 50,
      volumeEth: Number(selectedToken.momentum?.volumeEth ?? 0),
      buyPct: selectedToken.momentum?.buyPct ?? 50,
      hasSocials: selectedToken.hasSocials ?? false,
      creatorHoldingPct,
      top5Pct,
      totalLaunches: devStats?.launches ?? selectedToken.devProfile?.launches ?? 0,
      graduationRate: devStats?.gradRate ?? selectedToken.devProfile?.gradRate ?? 0,
      totalPreGradDumps: (selectedToken as any).totalPreGradDumps ?? 0,
      isSerialDumper: (selectedToken as any).isSerialDumper ?? false,
    });
  }, [selectedToken, creatorHoldingPct, top5Pct, devStats]);

  // Critical-risk evaluation for the detail drawer. Each entry is a fully
  // formatted, human-readable warning derived from REAL data only — no
  // fabricated risks. The banner renders when at least one condition fires.
  const criticalRisks = useMemo<string[]>(() => {
    if (!selectedToken) return [];
    const risks: string[] = [];

    // Condition 1: creator holds a dangerous share of supply.
    if (creatorHoldingPct > 15) {
      risks.push(`🚨 HIGH RISK: Creator holds ${creatorHoldingPct.toFixed(1)}% of total supply.`);
    }

    // Condition 2: top-5 wallets control a dangerous share of supply.
    if (top5Pct > 40) {
      risks.push(`🚨 CABAL WARNING: Top 5 wallets control ${top5Pct.toFixed(1)}% of supply.`);
    }

    // Condition 3: the developer has dumped a past token pre-graduation.
    const dumps = Number((selectedToken as any).totalPreGradDumps ?? 0);
    if (dumps > 0) {
      risks.push(`🚨 SERIAL DUMPER: Dev dumped ${dumps} past token${dumps > 1 ? 's' : ''} before graduation.`);
    }

    return risks;
  }, [selectedToken, creatorHoldingPct, top5Pct]);

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
        onOpenPortfolio={() => setIsPortfolioOpen(true)}
      />

      <UserPortfolio
        address={address}
        isOpen={isPortfolioOpen}
        onClose={() => setIsPortfolioOpen(false)}
        onSelectToken={(tokenAddress) => {
          // Close the drawer and open the token's detail view. The grid poller
          // will hydrate the full metrics for this address.
          setIsPortfolioOpen(false);
          setSearchQuery(tokenAddress);
        }}
      />

      <main className="p-8 max-w-6xl mx-auto">
        {selectedToken ? (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
            <button
              onClick={() => { setSelectedToken(null); }}
              className="mb-6 text-zinc-400 hover:text-white flex items-center gap-2 text-sm transition-colors"
            >
              ← Back to Radar
            </button>

            {/*
              SHARE SNAPSHOT REGION.
              This wrapper is the exact DOM subtree converted to a PNG by the
              "Share 📸" button. It intentionally contains ONLY the token header
              card (name, ticker, contract address, Vibe Score) — the bonding
              curve, live telemetry, and volume panels are deliberately excluded
              so the exported image stays a clean, focused share card. It carries
              an explicit dark background so the PNG is legible on any viewer
              theme, plus padding so the card isn't cropped at the edges.
            */}
            <div ref={shareCardRef} className="bg-zinc-950 rounded-xl p-6 border border-zinc-800">
              <header className="flex justify-between items-end">
                <div>
                  <h2 className="text-4xl font-bold tracking-tight mb-2 flex items-center gap-3">
                    {selectedToken.name}
                    <span className="text-xl text-emerald-400 bg-emerald-400/10 px-3 py-1 rounded-lg border border-emerald-400/20">{selectedToken.ticker}</span>
                  </h2>
                  <p className="text-zinc-500 text-sm">Contract: {selectedToken.contractAddress}</p>
                </div>
                <div className="text-right flex flex-col items-end gap-2">
                  <div>
                    <span className="block text-sm text-zinc-400 mb-1">Vibe Score</span>
                    <VibeScoreDisplay score={detailScore} />
                  </div>
                </div>
              </header>
            </div>

            {/* Share control lives OUTSIDE the snapshot region so the button and
                status text never appear in the exported PNG. */}
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={handleShareImage}
                disabled={isSharing}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-emerald-500 hover:text-zinc-950 text-zinc-300 font-bold rounded-lg text-xs border border-zinc-700 hover:border-emerald-500 transition-colors disabled:opacity-50"
                title="Download a PNG snapshot of this token's Vibe Score and metrics"
              >
                {isSharing ? "Capturing..." : "Share 📸"}
              </button>
              {shareStatus && (
                <span className="text-[10px] text-emerald-400 font-bold animate-pulse">
                  {shareStatus}
                </span>
              )}
            </div>

            <LiveTelemetryPanel
              isSyncingLive={isSyncingLive}
              oracleReady={oracleReady}
              timeSinceLaunchMins={selectedToken.timeSinceLaunchMins}
              bondingCurveProgress={selectedToken.bondingCurveProgress}
              ethDeposited={selectedToken.ethDeposited}
              pairSymbol={selectedToken.pairSymbol}
              marketCapUsd={selectedToken.marketCapUsd}
              momentum={selectedToken.momentum}
              volumeUsd={selectedToken.volumeUsd}
              volumeEth={selectedToken.volumeEth}
            />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
              <div className="lg:col-span-2 space-y-6">

                {criticalRisks.length > 0 && (
                  <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-3 rounded-lg mb-4 flex items-center gap-2 text-sm">
                    <span className="text-lg leading-none">⚠️</span>
                    <div className="flex flex-col gap-1">
                      {criticalRisks.map((risk, i) => (
                        <span key={i} className="font-bold">{risk}</span>
                      ))}
                    </div>
                  </div>
                )}

                <CabalDetectorPanel
                  isCabalRisk={isCabalRisk}
                  topHolders={topHolders}
                  top5Pct={top5Pct}
                  creatorHoldingPct={creatorHoldingPct}
                  diamondHandsHoldersPct={selectedToken.diamondHandsHoldersPct}
                />

                <DeveloperProfilerPanel
                  devAddress={
                    selectedToken.devAddress ||
                    (selectedToken as any).launcherAddress ||
                    (selectedToken as any).creatorAddress ||
                    ""
                  }
                  badgeText={devBadgeText}
                  badgeColor={devBadgeColor}
                  devStats={devStats}
                  devProfile={selectedToken.devProfile}
                  isLoading={devStats === null}
                />
              </div>

              <div className="space-y-6">
                <TradingTerminal
                  symbol={selectedToken?.symbol || ""}
                  tradeTab={tradeTab}
                  onTradeTabChange={setTradeTab}
                  apeAmount={apeAmount}
                  onApeAmountChange={setApeAmount}
                  sellAmount={sellAmount}
                  onSellAmountChange={setSellAmount}
                  ethAvailable={ethAvailable}
                  tokenBalance={tokenBalance}
                  isTxPending={isTxPending}
                  hash={hash}
                  isTxWaiting={isTxWaiting}
                  isTxSuccess={isTxSuccess}
                  receiptStatus={receipt?.status}
                  onExecuteApe={handleExecuteApe}
                  onExecuteSell={handleExecuteSell}
                  isGraduated={isGraduated}
                  tradeUrl={vibeTradeUrl}
                />

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
            <RadarHeader
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              activeFilter={activeFilter}
              onFilterChange={setActiveFilter}
            />

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
                    liveMetricsResolved={!!liveMetrics[token.contractAddress.toLowerCase()]}
                    oracleReady={oracleReady}
                    onSelect={handleSelectToken}
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