import { NextResponse } from 'next/server';
import { isTokenGraduated } from '@/lib/tokenMetrics';

// ---------------------------------------------------------------------------
// Upstream VibeVibe API base. Both the legacy and V6 surfaces are queried and
// merged, because older launches only appear on the legacy surface.
// ---------------------------------------------------------------------------
const VIBE_API_BASE = 'https://testnet.vibevibe.fun/api/v1/chains/46630';

// Pagination safety breakers — prevent infinite loops / serverless timeouts.
//
// CRITICAL: the V6 wallet-launches endpoint (`/v6/wallets/{address}/launches`)
// REJECTS `limit=100` with HTTP 400 Bad Request (verified live against the
// testnet). It accepts 10/20/50 but NOT 100. The previous value of 100 made
// EVERY V6 launch request fail with a 400, which silently collapsed the V6
// surface to zero items and produced the "0 launches" Dev Profile bug. The
// legacy `/launches` and `/wallets/{address}/activity` endpoints accept 50
// fine, so 50 is the safe common denominator across all surfaces.
const PAGE_LIMIT = 50;
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
    /**
     * Some V6 endpoints return the launch list under `launches` instead of
     * `items`. The parser must accept BOTH shapes or it silently drops the
     * entire payload and reports a bogus "0 launches" profile.
     */
    launches?: any[];
    page?: VibePage;
  };
}

/**
 * Extracts the launch array from an upstream payload, tolerating both the
 * `data.items` and `data.launches` response shapes. Returns an empty array when
 * neither is present (a genuinely empty page), never `undefined`.
 */
function extractItems(payload: VibeResponse | null): any[] {
  if (!payload?.data) return [];
  if (Array.isArray(payload.data.items)) return payload.data.items;
  if (Array.isArray(payload.data.launches)) return payload.data.launches;
  return [];
}

/**
 * Fetches a single page from an upstream VibeVibe endpoint.
 *
 * Resilience: the upstream intermittently returns HTTP 503 with a
 * `BOARD_BUSY` body under load. A single retry (after a short backoff) rides
 * out that transient condition. Non-OK responses are logged explicitly so a
 * silent upstream failure can never masquerade as an empty developer profile.
 *
 * Returns null when the request ultimately fails, so callers can distinguish a
 * genuine empty page from a transient upstream failure.
 */
async function fetchPage(
  url: string,
  headers: Record<string, string>
): Promise<VibeResponse | null> {
  const MAX_ATTEMPTS = 2; // initial attempt + one retry

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers, cache: 'no-store' });
      if (res.ok) {
        return (await res.json()) as VibeResponse;
      }

      // Explicit, non-silent upstream error logging.
      console.error(
        `[proxyDev] Upstream error: ${res.status} ${res.statusText} (attempt ${attempt}/${MAX_ATTEMPTS}) ${url}`
      );

      // Retry once on 503 BOARD_BUSY (and any other 5xx) — these are transient.
      const isRetryable = res.status === 503 || res.status >= 500;
      if (isRetryable && attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      return null;
    } catch (err) {
      console.error(
        `[proxyDev] Upstream fetch threw (attempt ${attempt}/${MAX_ATTEMPTS}) ${url}:`,
        err
      );
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      return null;
    }
  }

  return null;
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

    // Accept both `data.items` and `data.launches` payload shapes.
    const pageItems = extractItems(page);
    if (pageItems.length > 0) items.push(...pageItems);

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
    const plainItems = extractItems(plain);
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

  // Normalize the requested developer address IMMEDIATELY: trim whitespace and
  // lowercase. The upstream indexes are case-sensitive, so a checksummed
  // (mixed-case) or padded input would silently return zero launches and
  // undercount the profiler. Every downstream comparison and upstream call uses
  // this single canonical value.
  const targetDev = (searchParams.get('address') || '').trim().toLowerCase();

  console.log('[proxyDev] targetDev:', targetDev);

  if (!targetDev) return NextResponse.json({ error: 'Missing address' }, { status: 400 });

  try {
    const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };

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
    const v6Url = `${VIBE_API_BASE}/v6/wallets/${targetDev}/launches?limit=${PAGE_LIMIT}`;
    const legacyUrl = `${VIBE_API_BASE}/launches?creatorAddress=${targetDev}&limit=${PAGE_LIMIT}`;

    const v6Launches = await fetchLaunchesWithFallback(
      (cursor) =>
        `${VIBE_API_BASE}/v6/wallets/${targetDev}/launches?limit=${PAGE_LIMIT}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
      () => `${VIBE_API_BASE}/v6/wallets/${targetDev}/launches?limit=${PAGE_LIMIT}`,
      headers
    );

    console.log('[proxyDev] V6 URL:', v6Url, 'ok:', v6Launches.ok, 'items:', v6Launches.items.length);

    // Legacy surface is a secondary, non-fatal merge. A failure here must NOT
    // discard the V6 results.
    const legacyLaunches = await fetchLaunchesWithFallback(
      (cursor) =>
        `${VIBE_API_BASE}/launches?creatorAddress=${targetDev}&limit=${PAGE_LIMIT}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
      () => `${VIBE_API_BASE}/launches?creatorAddress=${targetDev}&limit=${PAGE_LIMIT}`,
      headers
    );

    console.log('[proxyDev] V5 URL:', legacyUrl, 'ok:', legacyLaunches.ok, 'items:', legacyLaunches.items.length);
    console.log(
      '[proxyDev] Extracted V6 Items:',
      v6Launches.items.length,
      'V5 Items:',
      legacyLaunches.items.length
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

    // MERGE, DO NOT OVERWRITE. Both surfaces are concatenated so that a
    // successful V6 fetch can never discard genuinely-old (pre-V6) launches that
    // only the legacy index knows about — and vice versa. V6 items are placed
    // FIRST so that, during deduplication below, the richer V6 record wins for
    // any token that appears on both surfaces (the legacy projection lacks the
    // V6 `lifecycle` / `graduated` fields the graduation math depends on).
    const combinedItems: any[] = [...v6Launches.items, ...legacyLaunches.items];

    // NORMALIZE THE CREATOR + TOKEN ADDRESS FIELDS.
    //
    // Creator: V6 items carry `launcherAddress`; legacy items carry
    // `creatorAddress`. Every downstream consumer reads `creatorAddress`, so we
    // project `launcherAddress` onto it here. Without this mapping V6 tokens
    // reach the scanner with an undefined creator and are silently dropped,
    // producing the "0 launches" symptom.
    //
    // Token address: some payloads expose the contract under `address` rather
    // than `tokenAddress`. We canonicalize onto `tokenAddress` (lowercased) so
    // deduplication and set membership are consistent across both surfaces.
    const normalizedItems: any[] = combinedItems
      .filter((item: any) => item && (item.tokenAddress || item.address))
      .map((item: any) => {
        const creator = String(
          item.launcherAddress || item.creatorAddress || ''
        ).toLowerCase();
        const tokenAddress = String(item.tokenAddress || item.address || '').toLowerCase();
        return {
          ...item,
          // Canonical internal keys consumed downstream.
          tokenAddress,
          creatorAddress: creator,
          // Preserve the V6-native field for any consumer that still reads it.
          launcherAddress: item.launcherAddress || creator,
        };
      });

    // Deduplicate by lowercased token address. When a token appears on BOTH
    // surfaces we MERGE the two records rather than letting one clobber the
    // other: the V6 record is the base (it carries `lifecycle` / `graduated` /
    // `curve`), and any legacy-only fields are layered underneath so no data is
    // lost. This guarantees the legacy array is never ignored when V6 also
    // succeeds, while V6 retains precedence for shared tokens.
    const dedupMap = new Map<string, any>();
    normalizedItems.forEach((item: any, index: number) => {
      // GUARANTEE A UNIQUE, NON-EMPTY KEY. If `tokenAddress` is missing we must
      // NOT fall back to an empty string: every malformed item would then share
      // the "" key and overwrite each other in the Map, collapsing N tokens down
      // to 1 (or 0). We synthesize a per-item key from the launch id / tx hash,
      // and as a last resort the array index, so no item is ever lost.
      const rawKey = String(item.tokenAddress || item.address || '').toLowerCase();
      const key =
        rawKey ||
        String(item.launchId || item.createdTransactionHash || item.curveAddress || '').toLowerCase() ||
        `__unkeyed_${index}`;

      const existing = dedupMap.get(key);
      if (!existing) {
        dedupMap.set(key, item);
        return;
      }
      // `existing` is the earlier (V6-first) record; keep it authoritative for
      // identity/graduation fields while backfilling any missing legacy fields.
      dedupMap.set(key, { ...item, ...existing });
    });
    const deduplicated = Array.from(dedupMap.values());

    console.log('[proxyDev] Final Deduplicated Length:', deduplicated.length);

    // Isolate tokens created by this wallet. After normalization both surfaces
    // expose the creator under `creatorAddress`, but we still inspect both keys
    // and compare case-insensitively for defensive robustness.
    const createdTokens = deduplicated.filter((item: any) => {
      const launcher = String(item.launcherAddress || item.creatorAddress || '').toLowerCase();
      return launcher === targetDev;
    });

    const createdTokenSet = new Set(
      createdTokens.map((t: any) => String(t.tokenAddress || t.address || '').toLowerCase())
    );
    // Graduation is evaluated through the SHARED predicate so V6 (`lifecycle` /
    // `graduated`) and legacy (`curve_progress >= 100`) tokens are both counted.
    // It runs over the MERGED + DEDUPLICATED dataset, so a token that appears on
    // both surfaces is counted exactly once and V6 graduation fields take
    // precedence. Previously only the V6 fields were checked, which reported a
    // 0% rate for graduated tokens whose graduation was expressed via
    // `curve_progress`.
    const graduatedTokenSet = new Set(
      createdTokens
        .filter((item: any) => isTokenGraduated(item))
        .map((t: any) => String(t.tokenAddress || t.address || '').toLowerCase())
    );

    // Graduation timestamps, used to strictly isolate pre-graduation sells when
    // the event itself does not carry a `route` field.
    const graduationTimestampByToken = new Map<string, number>();
    createdTokens.forEach((item: any) => {
      const addr = String(item.tokenAddress || item.address || '').toLowerCase();
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
