import { NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Upstream VibeVibe API base. Both the legacy and V6 surfaces are queried and
// merged, because older launches only appear on the legacy surface.
// ---------------------------------------------------------------------------
const VIBE_API_BASE = 'https://testnet.vibevibe.fun/api/v1/chains/46630';

// Pagination safety breakers — prevent infinite loops / serverless timeouts.
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;
const MAX_EVENTS = 500;

interface VibePage {
  limit?: number;
  nextCursor?: string | null;
  hasMore?: boolean;
}

interface VibeResponse {
  data?: {
    items?: any[];
    page?: VibePage;
  };
}

/**
 * Fetches a single page from an upstream VibeVibe endpoint. Returns null when
 * the request fails or the response is not OK, so callers can distinguish a
 * genuine empty page from a transient upstream failure.
 */
async function fetchPage(
  url: string,
  headers: Record<string, string>
): Promise<VibeResponse | null> {
  try {
    const res = await fetch(url, { headers, cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as VibeResponse;
  } catch {
    return null;
  }
}

/**
 * Paginates an upstream list endpoint using its `data.page.nextCursor` /
 * `hasMore` contract, accumulating items until the cursor is exhausted or a
 * safety breaker trips.
 *
 * Returns `{ items, ok }` where `ok` is false only when the FIRST page failed
 * outright (i.e. we learned nothing). Later-page failures stop the loop but
 * keep whatever was already collected, so a mid-pagination hiccup degrades
 * gracefully instead of discarding good data.
 */
async function fetchAllPages(
  buildUrl: (cursor: string | null) => string,
  headers: Record<string, string>
): Promise<{ items: any[]; ok: boolean }> {
  const items: any[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  let firstPageOk = false;

  while (pageCount < MAX_PAGES && items.length < MAX_EVENTS) {
    const page = await fetchPage(buildUrl(cursor), headers);
    if (page === null) {
      // First page failing means the upstream is down for this resource.
      if (pageCount === 0) return { items, ok: false };
      break;
    }
    if (pageCount === 0) firstPageOk = true;

    const pageItems = page.data?.items;
    if (Array.isArray(pageItems)) items.push(...pageItems);

    const pageMeta = page.data?.page;
    const nextCursor = pageMeta?.nextCursor ?? null;
    const hasMore = pageMeta?.hasMore === true;

    pageCount += 1;
    if (!hasMore || !nextCursor) break;
    cursor = nextCursor;
  }

  return { items, ok: firstPageOk };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address) return NextResponse.json({ error: 'Missing address' }, { status: 400 });

  try {
    const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };
    const targetDev = address.toLowerCase();

    // 1. Fetch all launches created by this wallet (legacy + V6), paginated.
    const [legacyLaunches, v6Launches] = await Promise.all([
      fetchAllPages(
        (cursor) =>
          `${VIBE_API_BASE}/launches?creatorAddress=${address}&limit=${PAGE_LIMIT}` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
        headers
      ),
      fetchAllPages(
        (cursor) =>
          `${VIBE_API_BASE}/v6/wallets/${address}/launches?limit=${PAGE_LIMIT}` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
        headers
      ),
    ]);

    // SILENT-FAILURE GUARD: if BOTH launch surfaces failed outright we have no
    // reliable data. Returning 200 with totalLaunches: 0 would overwrite the
    // UI's accurate state with zeros, so we surface a 502 instead and let the
    // frontend's .catch() preserve the last-known-good values.
    if (!legacyLaunches.ok && !v6Launches.ok) {
      return NextResponse.json(
        { error: 'Upstream launch data unavailable' },
        { status: 502 }
      );
    }

    const combinedItems: any[] = [...legacyLaunches.items, ...v6Launches.items];

    // Deduplicate and isolate tokens created by this wallet
    const deduplicated = Array.from(
      new Map(combinedItems.map((item) => [item.tokenAddress.toLowerCase(), item])).values()
    );
    const createdTokens = deduplicated.filter((item: any) => {
      const launcher = (item.launcherAddress || item.creatorAddress || '').toLowerCase();
      return launcher === targetDev;
    });

    const createdTokenSet = new Set(createdTokens.map((t: any) => t.tokenAddress.toLowerCase()));
    const graduatedTokenSet = new Set(
      createdTokens
        .filter(
          (item: any) =>
            item.lifecycle === 'GRADUATED' ||
            item.graduated === true ||
            item.curve?.lifecycle === 'GRADUATED'
        )
        .map((t: any) => t.tokenAddress.toLowerCase())
    );

    // Graduation timestamps, used to strictly isolate pre-graduation sells when
    // the event itself does not carry a `route` field.
    const graduationTimestampByToken = new Map<string, number>();
    createdTokens.forEach((item: any) => {
      const addr = (item.tokenAddress || '').toLowerCase();
      const ts = item.graduatedAt || item.graduationTimestamp || item.graduation?.timestamp;
      if (addr && ts != null) {
        const parsed = typeof ts === 'number' ? ts : Date.parse(String(ts));
        if (!Number.isNaN(parsed)) graduationTimestampByToken.set(addr, parsed);
      }
    });

    // 2. Fetch the Developer's Personal Activity Ledger (Immune to token trade
    //    volume), paginated. A failure here is non-fatal: we still return the
    //    launch data, just without dump detection.
    const activity = await fetchAllPages(
      (cursor) =>
        `${VIBE_API_BASE}/wallets/${address}/activity?limit=${PAGE_LIMIT}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
      headers
    );

    const walletEvents = activity.items;

    const uniqueWalletEvents = Array.from(
      new Map(walletEvents.map((ev: any) => [ev.id || `${ev.txHash}-${ev.logIndex}`, ev])).values()
    );

    // 3. Mathematical Verification: Detect PRE-graduation sells on self-deployed
    //    tokens. Post-graduation DEX/AMM sells are legitimate exits, never rugs,
    //    so they must not be counted.
    const dumpedTokenAddresses = new Set<string>();
    let totalDumpVolumeEth = 0;

    uniqueWalletEvents.forEach((ev: any) => {
      const isSell = ev.side === 'SELL' || ev.type === 'SELL';
      const tokenAddr = (ev.tokenAddress || '').toLowerCase();

      // Only evaluate if this sell was executed on a token THEY deployed.
      if (!isSell || !createdTokenSet.has(tokenAddr)) return;

      // STRICT pre-graduation gate. A sell counts as a dump ONLY when it
      // happened on the bonding curve:
      //   - explicit curve route, OR
      //   - the token has not graduated at all, OR
      //   - the event timestamp precedes the token's graduation timestamp.
      // A post-graduation AMM/DEX sell is explicitly excluded.
      const route = String(ev.route || ev.source || '').toUpperCase();
      const isCurveRoute = route === 'CURVE' || route === 'CURVE_SELL';
      const isDexRoute = route === 'AMM' || route === 'DEX' || route === 'POOL';

      let isPreGraduation: boolean;
      if (isCurveRoute) {
        isPreGraduation = true;
      } else if (isDexRoute) {
        isPreGraduation = false;
      } else if (!graduatedTokenSet.has(tokenAddr)) {
        // Never graduated → any sell is necessarily pre-graduation.
        isPreGraduation = true;
      } else {
        // Graduated and no explicit route: fall back to timestamp comparison.
        const gradTs = graduationTimestampByToken.get(tokenAddr);
        const evTsRaw = ev.timestamp || ev.blockTimestamp || ev.createdAt;
        const evTs =
          evTsRaw == null
            ? null
            : typeof evTsRaw === 'number'
              ? evTsRaw
              : Date.parse(String(evTsRaw));
        isPreGraduation =
          gradTs != null && evTs != null && !Number.isNaN(evTs) ? evTs < gradTs : false;
      }

      if (isPreGraduation) {
        dumpedTokenAddresses.add(tokenAddr);
        const ethWei = Number(ev.amountOutBaseUnits || ev.ethAmount || ev.pairPrincipalUnits || 0);
        totalDumpVolumeEth += ethWei > 1000 ? ethWei / 1e18 : ethWei;
      }
    });

    const totalLaunches = createdTokens.length;
    const graduatedCount = graduatedTokenSet.size;
    const totalPreGradDumps = dumpedTokenAddresses.size;

    return NextResponse.json({
      data: {
        items: createdTokens,
        profiler: {
          totalLaunches,
          graduatedCount,
          graduationRate: totalLaunches > 0 ? Math.round((graduatedCount / totalLaunches) * 100) : 0,
          totalPreGradDumps,
          totalDumpVolumeEth,
          isSerialDumper: totalPreGradDumps > 0,
          dumpedTokens: Array.from(dumpedTokenAddresses),
        },
        page: { totalCount: totalLaunches },
      },
    });
  } catch (err) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
