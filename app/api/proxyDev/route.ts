import { NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Upstream VibeVibe API base. Both the legacy and V6 surfaces are queried and
// merged, because older launches only appear on the legacy surface.
// ---------------------------------------------------------------------------
const VIBE_API_BASE = 'https://testnet.vibevibe.fun/api/v1/chains/46630';

// Pagination safety breakers — prevent infinite loops / serverless timeouts.
// Live testing against the VibeVibe testnet API shows the opposite of the
// documented convention: `limit=50` returns "Origin unavailable", while
// `limit=100` returns complete launch data. We therefore use 100.
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

/**
 * Fetches a wallet's launches with a resilience fallback.
 *
 * Primary path: cursor-paginated `fetchAllPages`. If that fails outright OR
 * returns an empty page-1 result set, we retry once with a plain, non-cursor
 * query (`limit=${PAGE_LIMIT}`) — some upstream deployments reject the `cursor`
 * parameter or return empty arrays for it, and the plain query is the
 * documented form.
 *
 * `ok` is true when either attempt produced a usable (non-failed) response, so
 * a genuinely empty wallet is not mistaken for an upstream outage.
 */
async function fetchLaunchesWithFallback(
  buildPaginatedUrl: (cursor: string | null) => string,
  buildPlainUrl: () => string,
  headers: Record<string, string>
): Promise<{ items: any[]; ok: boolean }> {
  const paginated = await fetchAllPages(buildPaginatedUrl, headers);

  // Success with data → use it.
  if (paginated.ok && paginated.items.length > 0) return paginated;

  // Either the paginated call failed, or it succeeded but page 1 was empty.
  // Retry with the standard non-cursor query before giving up.
  const plain = await fetchPage(buildPlainUrl(), headers);
  if (plain !== null) {
    const plainItems = Array.isArray(plain.data?.items) ? plain.data!.items! : [];
    // Prefer whichever attempt actually returned data; otherwise report the
    // plain query's (possibly empty but successful) result.
    if (plainItems.length > 0 || paginated.items.length === 0) {
      return { items: plainItems, ok: true };
    }
  }

  // Plain retry also failed — fall back to whatever pagination collected.
  return paginated;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address) return NextResponse.json({ error: 'Missing address' }, { status: 400 });

  try {
    const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };
    const targetDev = address.toLowerCase();

    // 1. Fetch all launches created by this wallet.
    //
    //    V6 IS THE PRIMARY SOURCE. The legacy `/launches?creatorAddress=` surface
    //    returns EMPTY arrays for V6-deployed tokens (the V6 factory writes
    //    `launcherAddress`, which the legacy index does not project onto
    //    `creatorAddress`). Relying on it first — as the previous implementation
    //    did — is the root cause of the "0 launches" Dev Profile / Discipline
    //    scanner bug. We therefore query the V6 wallet-launches endpoint FIRST
    //    and treat the legacy surface as a best-effort secondary merge so that
    //    genuinely old (pre-V6) launches are still counted.
    //
    //    Both surfaces are queried with the LOWERCASED address: the upstream
    //    indexes are case-sensitive, so a checksummed (mixed-case) input would
    //    silently return zero launches and undercount the profiler.
    const v6Launches = await fetchLaunchesWithFallback(
      (cursor) =>
        `${VIBE_API_BASE}/v6/wallets/${targetDev}/launches?limit=${PAGE_LIMIT}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
      () => `${VIBE_API_BASE}/v6/wallets/${targetDev}/launches?limit=${PAGE_LIMIT}`,
      headers
    );

    // Legacy surface is a secondary, non-fatal merge. A failure here must NOT
    // discard the V6 results.
    const legacyLaunches = await fetchLaunchesWithFallback(
      (cursor) =>
        `${VIBE_API_BASE}/launches?creatorAddress=${targetDev}&limit=${PAGE_LIMIT}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
      () => `${VIBE_API_BASE}/launches?creatorAddress=${targetDev}&limit=${PAGE_LIMIT}`,
      headers
    );

    // SILENT-FAILURE GUARD: if BOTH launch surfaces failed outright we have no
    // reliable data. Returning 200 with totalLaunches: 0 would overwrite the
    // UI's accurate state with zeros, so we surface a 502 instead and let the
    // frontend's .catch() preserve the last-known-good values.
    if (!v6Launches.ok && !legacyLaunches.ok) {
      return NextResponse.json(
        { error: 'Upstream launch data unavailable' },
        { status: 502 }
      );
    }

    const combinedItems: any[] = [...v6Launches.items, ...legacyLaunches.items];

    // NORMALIZE THE CREATOR FIELD. V6 items carry `launcherAddress`; legacy
    // items carry `creatorAddress`. Every downstream consumer (the Discipline
    // scanner, the returned `items` payload, the frontend profiler) reads
    // `creatorAddress`, so we project `launcherAddress` onto it here. Without
    // this mapping the V6 tokens reach the scanner with an undefined creator and
    // are silently dropped, producing the "0 launches" symptom.
    const normalizedItems: any[] = combinedItems
      .filter((item: any) => item && item.tokenAddress)
      .map((item: any) => {
        const creator = String(
          item.launcherAddress || item.creatorAddress || ''
        ).toLowerCase();
        return {
          ...item,
          // Canonical internal key consumed downstream.
          creatorAddress: creator,
          // Preserve the V6-native field for any consumer that still reads it.
          launcherAddress: item.launcherAddress || creator,
        };
      });

    // Deduplicate by lowercased token address. Items without a tokenAddress are
    // dropped rather than allowed to throw (a single malformed item must not
    // 500 the whole profiler response).
    const deduplicated = Array.from(
      new Map(
        normalizedItems.map((item: any) => [String(item.tokenAddress).toLowerCase(), item])
      ).values()
    );

    // Isolate tokens created by this wallet. After normalization both surfaces
    // expose the creator under `creatorAddress`, but we still inspect both keys
    // and compare case-insensitively for defensive robustness.
    const createdTokens = deduplicated.filter((item: any) => {
      const launcher = String(item.launcherAddress || item.creatorAddress || '').toLowerCase();
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
        `${VIBE_API_BASE}/wallets/${targetDev}/activity?limit=${PAGE_LIMIT}` +
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
