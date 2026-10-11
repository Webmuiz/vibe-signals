import { NextResponse } from 'next/server';

// Upstream VibeVibe API base. Overridable so local dev can point elsewhere.
const VIBE_API_BASE = process.env.VIBE_API_BASE || 'https://testnet.vibevibe.fun';

// Per-request timeout. Local networks are often slow/blocked, so we fail fast
// with a clear 504 instead of hanging until the platform kills the function.
const UPSTREAM_TIMEOUT_MS = Number(process.env.VIBE_TIMEOUT_MS) || 8000;

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

    // Launch + market are required; the ETH oracle is best-effort.
    const [launchRes, marketRes, ethRes] = await Promise.all([
      fetchWithTimeout(launchUrl, UPSTREAM_TIMEOUT_MS),
      fetchWithTimeout(marketUrl, UPSTREAM_TIMEOUT_MS),
      fetchWithTimeout('https://api.coinbase.com/v2/prices/ETH-USD/spot', UPSTREAM_TIMEOUT_MS),
    ]);

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
    const marketData = marketRes.ok ? marketRes.json : null;

    let ethPriceUsd = 2600;
    if (ethRes.ok && ethRes.json?.data?.amount) {
      ethPriceUsd = Number(ethRes.json.data.amount);
    } else if (!ethRes.ok) {
      console.warn(`[proxyVibe] ETH oracle unavailable (${ethRes.reason}): ${ethRes.detail}`);
    }

    if (data && data.data) {
      data.data.marketStats = marketData?.data?.stats || null;
      data.data.marketTrades = marketData?.data?.trades || [];
      data.data.ethPriceUsd = ethPriceUsd;
      data.data.apiVersion = path;
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
