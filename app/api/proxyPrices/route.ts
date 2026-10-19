import { NextResponse } from 'next/server';
import { createPublicClient, http, fallback } from 'viem';

const robinhoodTestnet = {
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
} as const;

// Resilient RPC transport: explicit timeout + retries, with an optional
// secondary endpoint (SECONDARY_RPC_URL) that viem fails over to automatically.
const PRIMARY_RPC_URL =
  process.env.PRIMARY_RPC_URL || 'https://rpc.testnet.chain.robinhood.com';
const SECONDARY_RPC_URL = process.env.SECONDARY_RPC_URL;

const publicClient = createPublicClient({
  chain: robinhoodTestnet,
  transport: fallback(
    [
      http(PRIMARY_RPC_URL, { timeout: 20000, retryCount: 5, retryDelay: 1000 }),
      ...(SECONDARY_RPC_URL
        ? [http(SECONDARY_RPC_URL, { timeout: 20000, retryCount: 5, retryDelay: 1000 })]
        : []),
    ],
    { rank: false, retryCount: 2 }
  ),
});

// ---------------------------------------------------------------------------
// Upstream payload shapes
// ---------------------------------------------------------------------------

/** One entry of the VibeVibe `pair-prices` response. */
interface PairPriceItem {
  pairAddress?: string;
  symbol?: string | null;
  /** Price denominated in ETH, as an 18-decimal fixed-point string. */
  priceEthWad?: string | number | null;
  /** Injected below — USD price derived from `priceEthWad`. */
  priceUsd?: number;
  [key: string]: unknown;
}

interface PairPricesPayload {
  data?: {
    items?: PairPriceItem[];
    ethPriceUsd?: number;
    rates?: Record<string, number>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Coinbase spot-price envelope: `{ data: { amount: "2416.12", ... } }`. */
interface CoinbaseSpotPayload {
  data?: { amount?: string; base?: string; currency?: string };
}

let cachedResponse: PairPricesPayload | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 15000;

/** Upstream budget. The client's oracle gate waits on this route. */
const UPSTREAM_TIMEOUT_MS = 4000;
/** Last-resort ETH price when Coinbase is unreachable. */
const FALLBACK_ETH_PRICE_USD = 2416;

/**
 * A structurally valid payload containing only the ETH/WETH rates.
 *
 * This is what lets `oracleReady` flip to `true` in the dashboard even when
 * the upstream pair-price service is down: the client gets a usable rate map
 * instead of an `{ error }` body with no `data`, which previously left the
 * oracle gate permanently closed and every USD metric stuck on "Syncing...".
 */
function buildFallbackPayload(ethPriceUsd: number): PairPricesPayload {
  return {
    data: {
      items: [],
      ethPriceUsd,
      rates: {
        ETH: ethPriceUsd,
        WETH: ethPriceUsd,
        '0x0000000000000000000000000000000000000000': ethPriceUsd,
      },
    },
  };
}

/** Fetch with a hard abort deadline; resolves to `null` on timeout/error. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    console.warn(`[proxyPrices] ${url} failed: ${(err as Error)?.message ?? err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  try {
    const now = Date.now();
    if (cachedResponse && (now - lastCacheTime) < CACHE_TTL_MS) {
      return NextResponse.json(cachedResponse);
    }

    const [pairsRes, ethRes] = await Promise.all([
      fetchWithTimeout(
        'https://testnet.vibevibe.fun/api/v1/chains/46630/v6/pair-prices',
        {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
          cache: 'no-store',
        },
        UPSTREAM_TIMEOUT_MS
      ),
      fetchWithTimeout(
        'https://api.coinbase.com/v2/prices/ETH-USD/spot',
        { cache: 'no-store' },
        UPSTREAM_TIMEOUT_MS
      ),
    ]);

    // Resolve the ETH oracle first — it is needed by both the success and the
    // fallback path.
    let ethPriceUsd = FALLBACK_ETH_PRICE_USD;
    if (ethRes?.ok) {
      try {
        const cbData = (await ethRes.json()) as CoinbaseSpotPayload;
        const amount = Number(cbData?.data?.amount);
        if (Number.isFinite(amount) && amount > 0) ethPriceUsd = amount;
      } catch {
        /* keep the fallback rate */
      }
    }

    if (!pairsRes || !pairsRes.ok) {
      // Upstream unavailable: still answer 200 with a valid ETH/WETH rate map
      // so the dashboard's oracle gate opens instead of hanging.
      const fallback = buildFallbackPayload(ethPriceUsd);
      cachedResponse = fallback;
      lastCacheTime = now;
      return NextResponse.json(fallback);
    }

    let data: PairPricesPayload;
    try {
      data = (await pairsRes.json()) as PairPricesPayload;
    } catch (err) {
      console.warn('[proxyPrices] malformed upstream JSON:', err);
      const fallback = buildFallbackPayload(ethPriceUsd);
      cachedResponse = fallback;
      lastCacheTime = now;
      return NextResponse.json(fallback);
    }

    const items: PairPriceItem[] = Array.isArray(data?.data?.items)
      ? data.data.items
      : [];

    // Resolve on-chain symbols for all pairs in one RPC multicall
    const symbolCalls = items.map((item) => ({
      address: item.pairAddress as `0x${string}`,
      abi: [{ name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const,
      functionName: 'symbol',
    }));

    let symbols: readonly any[] = [];
    try {
      symbols = await publicClient.multicall({ contracts: symbolCalls, allowFailure: true });
    } catch (e) {
      console.error('Multicall symbol resolution failed:', e);
    }

    const rates: Record<string, number> = {
      ETH: ethPriceUsd,
      WETH: ethPriceUsd,
      '0x0000000000000000000000000000000000000000': ethPriceUsd
    };

    items.forEach((item, i) => {
      const resolvedSym =
        symbols[i]?.status === 'success'
          ? String(symbols[i].result).toUpperCase()
          : null;
      if (resolvedSym) item.symbol = resolvedSym;

      // `priceEthWad` is denominated in ETH (confirmed against the raw VibeVibe
      // API payload), so converting to USD requires multiplying by the ETH
      // oracle price. This is the CORRECT conversion and must be kept.
      const priceEth = Number(item.priceEthWad || 0) / 1e18;
      const priceUsd = priceEth * ethPriceUsd;
      item.priceUsd = priceUsd;

      // Key the rate map by BOTH the pair address and the resolved symbol. The
      // address is the authoritative key: `pairSymbol` can be null (e.g.
      // MOBLAND) or mislabeled, so consumers must be able to look up by address.
      if (item.pairAddress) {
        rates[String(item.pairAddress).toLowerCase()] = priceUsd;
      }
      if (resolvedSym) {
        rates[resolvedSym] = priceUsd;
      }
    });

    if (data && data.data) {
      data.data.ethPriceUsd = ethPriceUsd;
      data.data.rates = rates;
      data.data.items = items;
    }

    cachedResponse = data;
    lastCacheTime = now;

    return NextResponse.json(data);
  } catch (err) {
    console.error('[proxyPrices] unexpected failure:', err);
    // Never return a body without `data` — the client treats that as "oracle
    // not ready" and blocks every USD value behind a spinner.
    return NextResponse.json(buildFallbackPayload(FALLBACK_ETH_PRICE_USD));
  }
}
