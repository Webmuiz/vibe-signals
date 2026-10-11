import { NextResponse } from 'next/server';

// Upstream VibeVibe API base. Overridable so local dev can point elsewhere.
const VIBE_API_BASE = process.env.VIBE_API_BASE || 'https://testnet.vibevibe.fun';

// Aggressive per-request timeout. Every upstream call is capped at 4s so the
// total endpoint response can never exceed ~5s (4s fetch + JSON parse/serialize).
// This is what keeps JIT search from hanging past the platform's 10s ceiling.
const UPSTREAM_TIMEOUT_MS = Number(process.env.VIBE_TIMEOUT_MS) || 4000;

// The ETH oracle is BEST-EFFORT only. It must never block the launch/market
// response, so it gets its own short timeout and is raced against a fallback.
const ORACLE_TIMEOUT_MS = Number(process.env.VIBE_ORACLE_TIMEOUT_MS) || 2500;
const FALLBACK_ETH_USD = 2600;

const UPSTREAM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

/**
 * Wraps fetch with an AbortController timeout and structured error reporting.
 * Returns a discriminated result so the caller can log the EXACT upstream
 * failure (timeout vs HTTP status vs network error) instead of a generic throw.
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<
  | { ok: true; status: number; json: any }
  | { ok: false; status: number; reason: 'timeout' | 'http' | 'network'; detail: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: UPSTREAM_HEADERS,
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!res.ok) {
      // Read a small slice of the body to surface the upstream error message.
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        detail = '<unreadable body>';
      }
      return { ok: false, status: res.status, reason: 'http', detail };
    }

    const json = await res.json();
    return { ok: true, status: res.status, json };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ok: false, status: 504, reason: 'timeout', detail: `No response within ${timeoutMs}ms` };
    }
    return { ok: false, status: 502, reason: 'network', detail: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

type FetchResult = Awaited<ReturnType<typeof fetchWithTimeout>>;

/**
 * Normalizes a `Promise.allSettled` entry into the same discriminated shape
 * `fetchWithTimeout` returns, so a rejected promise (should never happen, but
 * defensive) is treated as a network failure rather than crashing the route.
 */
function settleToResult(settled: PromiseSettledResult<FetchResult>): FetchResult {
  if (settled.status === 'fulfilled') return settled.value;
  return {
    ok: false,
    status: 502,
    reason: 'network',
    detail: settled.reason?.message || String(settled.reason),
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address) {
    return NextResponse.json({ error: 'Address is required' }, { status: 400 });
  }

  const paths = ['v6/launches', 'v5/launches', 'launches'];
  // Track the last upstream failure so we can return an accurate status code
  // (504 timeout / 502 network) instead of a blanket 500.
  let lastFailure: { status: number; reason: string; detail: string; path: string } | null = null;
  let sawHttp404 = false;

  for (const path of paths) {
    const launchUrl = `${VIBE_API_BASE}/api/v1/chains/46630/${path}/${address}`;
    const marketUrl = `${VIBE_API_BASE}/api/v1/chains/46630/${path}/${address}/market?limit=2`;

    // Launch + market + ETH oracle are fired CONCURRENTLY. `allSettled` means a
    // single slow/failed upstream can never reject the whole batch — we inspect
    // each result independently and degrade gracefully.
    const [launchSettled, marketSettled, ethSettled] = await Promise.allSettled([
      fetchWithTimeout(launchUrl, UPSTREAM_TIMEOUT_MS),
      fetchWithTimeout(marketUrl, UPSTREAM_TIMEOUT_MS),
      fetchWithTimeout('https://api.coinbase.com/v2/prices/ETH-USD/spot', ORACLE_TIMEOUT_MS),
    ]);

    const launchRes = settleToResult(launchSettled);
    const marketRes = settleToResult(marketSettled);
    const ethRes = settleToResult(ethSettled);

    if (!launchRes.ok) {
      // Log the EXACT upstream error for this path so local debugging is possible.
      console.error(
        `[proxyVibe] upstream ${launchRes.reason} on ${path} (status ${launchRes.status}): ${launchRes.detail}`
      );
      lastFailure = {
        status: launchRes.status,
        reason: launchRes.reason,
        detail: launchRes.detail,
        path,
      };
      if (launchRes.status === 404) sawHttp404 = true;
      continue; // try the next API version
    }

    const data = launchRes.json;

    // PARTIAL PAYLOAD: launch succeeded but market stats timed out / failed.
    // Return the primary launch data immediately rather than 504/500-ing the
    // whole request. The client normalizer treats a missing `marketStats` as
    // "no volume data" and falls back to on-chain/curve metrics.
    const marketData = marketRes.ok ? marketRes.json : null;
    if (!marketRes.ok) {
      console.warn(
        `[proxyVibe] market stats ${marketRes.reason} on ${path} — returning partial launch payload: ${marketRes.detail}`
      );
    }

    let ethPriceUsd = FALLBACK_ETH_USD;
    if (ethRes.ok && ethRes.json?.data?.amount) {
      ethPriceUsd = Number(ethRes.json.data.amount);
    } else if (!ethRes.ok) {
      console.warn(
        `[proxyVibe] ETH oracle unavailable (${ethRes.reason}) — using fallback $${FALLBACK_ETH_USD}: ${ethRes.detail}`
      );
    }

    if (data && data.data) {
      data.data.marketStats = marketData?.data?.stats || null;
      data.data.marketTrades = marketData?.data?.trades || [];
      data.data.ethPriceUsd = ethPriceUsd;
      data.data.apiVersion = path;
      // Signal to the client that market telemetry is degraded so it can
      // hydrate from on-chain metrics instead of waiting on a spinner.
      data.data.partial = !marketRes.ok;
    }

    return NextResponse.json(data);
  }

  // No version returned a usable payload. Distinguish "genuinely not found"
  // (all upstreams answered 404) from "upstream unreachable" (timeout/network).
  if (sawHttp404 && (!lastFailure || lastFailure.status === 404)) {
    return NextResponse.json(
      { error: 'Token not found across any API version', upstream: lastFailure },
      { status: 404 }
    );
  }

  const status = lastFailure?.status && lastFailure.status >= 500 ? lastFailure.status : 502;
  return NextResponse.json(
    {
      error: 'Upstream VibeVibe API unreachable',
      reason: lastFailure?.reason || 'unknown',
      detail: lastFailure?.detail || null,
      path: lastFailure?.path || null,
    },
    { status }
  );
}
