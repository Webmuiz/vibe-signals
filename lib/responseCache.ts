/**
 * Tiny in-process TTL cache for read-only API routes.
 *
 * Why this exists: the Turso bill is driven by ROW READS, and every browser tab
 * polling a route re-runs the same `SELECT ... FROM launches` against Turso.
 * With N tabs and a 3s interval that is N x 20 identical full-table scans per
 * minute. A short server-side TTL collapses all of those into ONE query per
 * window, regardless of how many clients are connected.
 *
 * Scope: module-level state, so it lives per server instance (per Cloudflare
 * isolate / per Node process). That is exactly what we want — it is a
 * coalescing layer, not a source of truth. TTLs are deliberately short (a few
 * seconds) so data is never meaningfully stale.
 *
 * This mirrors the pattern already proven in `app/api/proxyPrices/route.ts`.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

/** In-flight promises, so concurrent misses share a single upstream query. */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Returns the cached value for `key`, or runs `loader` and caches the result
 * for `ttlMs`. Concurrent callers during a miss await the SAME loader promise,
 * which prevents a thundering herd of identical DB queries.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.value;

  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const promise = (async () => {
    try {
      const value = await loader();
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/** Drops a single key (or the whole cache when called with no argument). */
export function invalidate(key?: string): void {
  if (key === undefined) store.clear();
  else store.delete(key);
}
