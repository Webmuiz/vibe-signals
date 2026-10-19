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

/**
 * One entry of the VibeVibe `pair-prices` response.
 *
 * Per the official API contract (§4.15) `priceEthWad` is ALWAYS
 * "Price of 1 pair unit in ETH (WAD)" — for both sources. `pairAddress` is the
 * PAIR-CURRENCY address (the asset the token is quoted against), not a token or
 * AMM address. The feed is therefore a map of quote-asset → ETH price.
 */
interface PairPriceItem {
  /** Pair-currency (quote asset) address. */
  pairAddress?: string;
  /** Documented alias for `pairAddress`; some deployments emit this name. */
  pairCurrencyAddress?: string;
  symbol?: string | null;
  pairSymbol?: string | null;
  /**
   * Discriminates how the quote asset was priced:
   *   'ROUTE_POOL'  — priced through an authoritative conversion route.
   *   'LAUNCH_POOL' — priced from a launch pool (still ETH-denominated).
   */
  source?: string | null;
  /** Price of 1 pair unit in ETH, 18-decimal fixed point. */
  priceEthWad?: string | number | null;
  /** Injected below — resolved USD price of one unit of the quote asset. */
  priceUsd?: number;
  [key: string]: unknown;
}

interface PairPricesPayload {
  data?: {
    items?: PairPriceItem[];
    ethPriceUsd?: number;
    rates?: Record<string, number>;
    /** Injected below — quote assets that could not be priced by any hop. */
    unresolved?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** `market/quote-usd-rates` envelope — a secondary, independent USD oracle. */
interface QuoteUsdRatesPayload {
  data?: {
    items?: Array<{
      quoteAddress?: string;
      /** USD price of one quote unit, expressed in cents. */
      usdPerQuoteCents?: string | number | null;
      source?: string | null;
      [key: string]: unknown;
    }>;
    status?: string;
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

/**
 * Fetch the secondary quote-asset USD oracle.
 *
 * The chain-scoped path is the one the API actually serves; the unscoped
 * `/api/v1/market/quote-usd-rates` returns 404. We try the chain-scoped form
 * first and fall back to the unscoped one so either deployment shape works.
 * Returns `null` when neither responds successfully.
 */
async function fetchQuoteUsdRates(): Promise<Response | null> {
  const headers = {
    'Accept': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  const candidates = [
    'https://testnet.vibevibe.fun/api/v1/chains/46630/market/quote-usd-rates',
    'https://testnet.vibevibe.fun/api/v1/market/quote-usd-rates',
  ];
  for (const url of candidates) {
    const res = await fetchWithTimeout(
      url,
      { headers, cache: 'no-store' },
      UPSTREAM_TIMEOUT_MS
    );
    if (res?.ok) return res;
  }
  return null;
}

export async function GET() {
  try {
    const now = Date.now();
    if (cachedResponse && (now - lastCacheTime) < CACHE_TTL_MS) {
      return NextResponse.json(cachedResponse);
    }

    // The upstream sits behind Cloudflare bot management. A bare `Mozilla/5.0`
    // UA is challenged with a 403 "Just a moment..." page, which silently
    // degraded this route to the ETH-only fallback and left every non-ETH quote
    // asset unpriced. Send the same full browser UA that `/api/proxyVibe` uses
    // (verified to pass the challenge).
    const UPSTREAM_HEADERS: Record<string, string> = {
      'Accept': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };

    const [pairsRes, ethRes, quoteRatesRes] = await Promise.all([
      fetchWithTimeout(
        'https://testnet.vibevibe.fun/api/v1/chains/46630/v6/pair-prices',
        { headers: UPSTREAM_HEADERS, cache: 'no-store' },
        UPSTREAM_TIMEOUT_MS
      ),
      fetchWithTimeout(
        'https://api.coinbase.com/v2/prices/ETH-USD/spot',
        { cache: 'no-store' },
        UPSTREAM_TIMEOUT_MS
      ),
      // Secondary, independent USD oracle. It prices quote assets directly in
      // USD (cents), so it can resolve assets that never appear in the
      // pair-prices feed at all. Failure is non-fatal.
      //
      // NOTE: the chain-scoped path is the one that actually exists; the
      // unscoped `/api/v1/market/quote-usd-rates` returns 404. We try the
      // chain-scoped form first and fall back to the unscoped one so either
      // deployment shape works.
      fetchQuoteUsdRates(),
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
      // Log the exact cause — a silent fallback here is what previously hid the
      // Cloudflare bot-challenge (403) that left every non-ETH asset unpriced.
      console.warn(
        `[proxyPrices] pair-prices unavailable (status=${pairsRes ? pairsRes.status : 'no-response'}); serving ETH-only fallback`
      );
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

    // -----------------------------------------------------------------------
    // Multi-hop quote-asset → USD resolver
    // -----------------------------------------------------------------------
    //
    // The upstream `v6/pair-prices` feed is a map of PAIR-CURRENCY address →
    // price of one unit of that currency in ETH (WAD). Per the API contract
    // (§4.15) this holds for BOTH sources; `source` only records HOW the asset
    // was priced:
    //
    //   ROUTE_POOL  — priced through an authoritative conversion route.
    //   LAUNCH_POOL — priced from a launch pool.
    //
    // The previous implementation treated LAUNCH_POOL rows as per-token prices
    // denominated in their own quote asset and discarded them. That was wrong:
    // it dropped every quote asset that is not one of the 6 ROUTE_POOL entries
    // (VIBE/VIBEVIBE, OPENAI, …), leaving tokens paired against them with no
    // USD rate at all. We now resolve in three passes.
    //
    // `quoteRates` is the single source of truth: quote-asset address → USD.
    const quoteRates: Record<string, number> = {
      // Native ETH is the root of every conversion chain.
      '0x0000000000000000000000000000000000000000': ethPriceUsd,
    };

    /** Normalise an address for use as a map key. */
    const addrKey = (value: unknown): string | null => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim().toLowerCase();
      return /^0x[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
    };

    /** Record a rate only when it is a usable, finite, positive number. */
    const setRate = (key: string | null, usd: number): boolean => {
      if (!key) return false;
      if (!Number.isFinite(usd) || usd <= 0) return false;
      quoteRates[key] = usd;
      return true;
    };

    // --- Pass 0: secondary USD oracle -------------------------------------
    // Independent of the pair-prices feed, so it can price assets that never
    // appear there. Applied first so Pass 1/2 can override with fresher,
    // route-derived values.
    if (quoteRatesRes?.ok) {
      try {
        const oracle = (await quoteRatesRes.json()) as QuoteUsdRatesPayload;
        const oracleItems = Array.isArray(oracle?.data?.items)
          ? oracle.data.items
          : [];
        let applied = 0;
        for (const entry of oracleItems) {
          const key = addrKey(entry?.quoteAddress);
          const cents = Number(entry?.usdPerQuoteCents);
          if (setRate(key, cents / 100)) applied += 1;
        }
        console.log(
          `[proxyPrices] secondary oracle: ${applied}/${oracleItems.length} quote rates applied`
        );
      } catch (err) {
        console.warn('[proxyPrices] secondary oracle malformed:', err);
      }
    } else {
      console.warn(
        `[proxyPrices] secondary oracle unavailable (status=${
          quoteRatesRes ? quoteRatesRes.status : 'no-response'
        })`
      );
    }

    // --- Pass 1: base quotes from ROUTE_POOL ------------------------------
    // ETH-denominated → multiply by the ETH oracle.
    let baseQuotes = 0;
    items.forEach((item) => {
      if (item.source !== 'ROUTE_POOL') return;
      const key = addrKey(item.pairAddress ?? item.pairCurrencyAddress);
      const priceEth = Number(item.priceEthWad);
      if (!Number.isFinite(priceEth) || priceEth <= 0) return;
      const usd = (priceEth / 1e18) * ethPriceUsd;
      if (setRate(key, usd)) {
        item.priceUsd = usd;
        baseQuotes += 1;
      }
    });

    // --- Pass 2: derived quotes from LAUNCH_POOL --------------------------
    // These rows are ALSO ETH-denominated quote-asset prices, so they resolve
    // in a single hop. Adding them to `quoteRates` lets them act as quote
    // assets for tokens paired against them.
    let derivedQuotes = 0;
    items.forEach((item) => {
      if (item.source === 'ROUTE_POOL') return;
      const key = addrKey(item.pairAddress ?? item.pairCurrencyAddress);
      const priceEth = Number(item.priceEthWad);
      if (!Number.isFinite(priceEth) || priceEth <= 0) return;
      const usd = (priceEth / 1e18) * ethPriceUsd;
      // Do not clobber a Pass 1 route-derived rate with a launch-pool estimate.
      if (key && quoteRates[key] != null) return;
      if (setRate(key, usd)) {
        item.priceUsd = usd;
        derivedQuotes += 1;
      }
    });

    // --- Pass 3: deep pairs ----------------------------------------------
    // Any row still unpriced is either genuinely unpriced upstream
    // (`PAIR_LAUNCH_NOT_PRICED`) or quotes an asset that no hop can reach.
    // We deliberately OMIT these from `rates` instead of coercing them to zero
    // or to the ETH price — a wrong rate silently corrupts market cap and
    // volume, whereas a missing rate lets the UI fall back gracefully.
    const unresolved: string[] = [];
    items.forEach((item) => {
      const key = addrKey(item.pairAddress ?? item.pairCurrencyAddress);
      if (!key) return;
      if (quoteRates[key] != null) return;
      if (!unresolved.includes(key)) unresolved.push(key);
    });

    // Symbol aliases (ETH/WETH and any on-chain-resolved symbols) are additive
    // conveniences; the address keys above remain authoritative.
    quoteRates.ETH = ethPriceUsd;
    quoteRates.WETH = ethPriceUsd;
    items.forEach((item, i) => {
      const resolvedSym =
        symbols[i]?.status === 'success'
          ? String(symbols[i].result).toUpperCase()
          : null;
      if (resolvedSym) item.symbol = resolvedSym;
      const key = addrKey(item.pairAddress ?? item.pairCurrencyAddress);
      const usd = key ? quoteRates[key] : undefined;
      if (resolvedSym && usd != null && quoteRates[resolvedSym] == null) {
        quoteRates[resolvedSym] = usd;
      }
    });

    console.log(
      `[proxyPrices] quote rates: base=${baseQuotes} derived=${derivedQuotes} ` +
        `total=${Object.keys(quoteRates).length} unresolved=${unresolved.length}`
    );

    if (data && data.data) {
      data.data.ethPriceUsd = ethPriceUsd;
      data.data.rates = quoteRates;
      // Surfaced for diagnostics only — never consumed as a price source.
      data.data.unresolved = unresolved;
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
