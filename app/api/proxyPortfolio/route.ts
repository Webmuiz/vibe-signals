import { NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Upstream VibeVibe API base. Overridable so local dev can point elsewhere.
// ---------------------------------------------------------------------------
const VIBE_API_BASE = process.env.VIBE_API_BASE || 'https://testnet.vibevibe.fun';

// Aggressive per-request timeout so a slow upstream can never hang the drawer.
const UPSTREAM_TIMEOUT_MS = Number(process.env.VIBE_TIMEOUT_MS) || 6000;
const ORACLE_TIMEOUT_MS = Number(process.env.VIBE_ORACLE_TIMEOUT_MS) || 2500;
const FALLBACK_ETH_USD = 2600;

const UPSTREAM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

/**
 * Wraps fetch with an AbortController timeout. Returns a discriminated result
 * so the caller can distinguish a timeout from an HTTP error from a network
 * failure instead of a generic throw.
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

/**
 * Converts a wei-denominated string/number into a JS number of whole units.
 * Returns 0 for null/undefined/unparseable input so callers never render NaN.
 */
function weiToNumber(value: unknown, decimals = 18): number {
  if (value == null) return 0;
  try {
    const raw = typeof value === 'string' ? value.trim() : String(value);
    if (!raw || raw === '0') return 0;
    // Use BigInt to avoid precision loss on 18-decimal values, then scale.
    const asBigInt = BigInt(raw);
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = Number(asBigInt / divisor);
    const remainder = Number(asBigInt % divisor) / Number(divisor);
    return whole + remainder;
  } catch {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // Normalize the address immediately: the upstream index is case-sensitive and
  // a checksummed input would silently return an empty portfolio.
  const address = (searchParams.get('address') || '').trim().toLowerCase();

  if (!address) {
    return NextResponse.json({ error: 'Address is required' }, { status: 400 });
  }

  const portfolioUrl =
    `${VIBE_API_BASE}/api/v1/chains/46630/analytics/portfolios/${address}?limit=100`;

  // Portfolio + ETH oracle are fired concurrently. The oracle is best-effort
  // and must never block the portfolio response.
  const [portfolioSettled, ethSettled] = await Promise.allSettled([
    fetchWithTimeout(portfolioUrl, UPSTREAM_TIMEOUT_MS),
    fetchWithTimeout('https://api.coinbase.com/v2/prices/ETH-USD/spot', ORACLE_TIMEOUT_MS),
  ]);

  const portfolioRes =
    portfolioSettled.status === 'fulfilled'
      ? portfolioSettled.value
      : { ok: false as const, status: 502, reason: 'network' as const, detail: String(portfolioSettled.reason) };

  const ethRes =
    ethSettled.status === 'fulfilled'
      ? ethSettled.value
      : { ok: false as const, status: 502, reason: 'network' as const, detail: String(ethSettled.reason) };

  if (!portfolioRes.ok) {
    console.error(
      `[proxyPortfolio] upstream ${portfolioRes.reason} (status ${portfolioRes.status}): ${portfolioRes.detail}`
    );
    // 404 genuinely means "no portfolio for this wallet"; anything else is a
    // transient upstream failure the client should retry.
    const status = portfolioRes.status === 404 ? 404 : portfolioRes.status >= 500 ? portfolioRes.status : 502;
    return NextResponse.json(
      {
        error: portfolioRes.status === 404 ? 'Portfolio not found' : 'Upstream portfolio API unreachable',
        reason: portfolioRes.reason,
        detail: portfolioRes.detail,
      },
      { status }
    );
  }

  let ethPriceUsd = FALLBACK_ETH_USD;
  if (ethRes.ok && ethRes.json?.data?.amount) {
    ethPriceUsd = Number(ethRes.json.data.amount);
  }

  const data = portfolioRes.json?.data || {};
  const summary = data.summary || {};
  const rawItems: any[] = Array.isArray(data.items) ? data.items : [];

  // Normalize each position into a flat, display-ready shape. Every numeric
  // field is derived from the raw wei values so the UI never has to do BigInt
  // math. `valueUsd` is computed from the ETH-denominated estimated value.
  const positions = rawItems
    .map((item: any) => {
      const tokenAddress = String(item.tokenAddress || '').toLowerCase();
      const balance = weiToNumber(item.balanceBaseUnits, 18);
      const valueEth = weiToNumber(item.estimatedValueWei, 18);
      const costEth = weiToNumber(item.costBasisWei, 18);
      const unrealizedPnlEth = weiToNumber(item.unrealizedPnlWei, 18);
      const realizedPnlEth = weiToNumber(item.realizedPnlWei, 18);
      const currentPriceEth = weiToNumber(item.currentPriceWeiPerToken, 18);

      return {
        tokenAddress,
        name: item.name || item.symbol || 'Unknown',
        symbol: item.symbol || 'TKN',
        imageUri: item.identity?.image?.uri?.startsWith('ipfs://')
          ? item.identity.image.uri.replace('ipfs://', 'https://ipfs.io/ipfs/')
          : item.identity?.image?.uri || null,
        balance,
        valueEth,
        valueUsd: valueEth * ethPriceUsd,
        costEth,
        unrealizedPnlEth,
        unrealizedPnlUsd: unrealizedPnlEth * ethPriceUsd,
        realizedPnlEth,
        currentPriceEth,
        coverage: item.coverage || 'UNKNOWN',
        quoteAssetAddress: item.identity?.quoteAssetAddress || null,
      };
    })
    // Drop dust / empty positions so the list only shows real holdings.
    .filter((p) => p.tokenAddress && (p.balance > 0 || p.valueEth > 0));

  // Sort by USD value descending so the largest holdings surface first.
  positions.sort((a, b) => b.valueUsd - a.valueUsd);

  const totalValueEth = weiToNumber(summary.equityWei, 18);
  const totalValueUsd = totalValueEth * ethPriceUsd;
  const totalPnlEth = weiToNumber(summary.pnlWei, 18);
  const realizedPnlEth = weiToNumber(summary.realizedPnlWei, 18);
  const unrealizedPnlEth = weiToNumber(summary.unrealizedPnlWei, 18);

  return NextResponse.json({
    data: {
      address,
      ethPriceUsd,
      summary: {
        coverage: summary.coverage || 'UNKNOWN',
        totalValueEth,
        totalValueUsd,
        totalPnlEth,
        totalPnlUsd: totalPnlEth * ethPriceUsd,
        realizedPnlEth,
        realizedPnlUsd: realizedPnlEth * ethPriceUsd,
        unrealizedPnlEth,
        unrealizedPnlUsd: unrealizedPnlEth * ethPriceUsd,
        buyCount: Number(summary.buyCount || 0),
        sellCount: Number(summary.sellCount || 0),
        tokensTraded: Number(summary.tokensTraded || 0),
        openPositions: Number(summary.openPositions || positions.length),
      },
      positions,
    },
  });
}
