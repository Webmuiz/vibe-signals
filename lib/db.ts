import { createClient, type Client } from '@libsql/client/web';
import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * Process-scoped client singleton.
 *
 * `getDb()` used to construct a fresh libSQL client on EVERY call. Each client
 * opens its own connection pool / fetch agent, so a route that called `getDb()`
 * per request paid connection setup on every poll — and, more importantly,
 * defeated any HTTP keep-alive reuse. One client per process is both cheaper
 * and the documented usage for `@libsql/client`.
 *
 * Keyed by URL so a credential/URL change (or a test harness) still gets a
 * distinct client instead of silently reusing a stale one.
 */
let cachedClient: Client | null = null;
let cachedClientKey: string | null = null;

export function getDb() {
  let url: string | undefined =
    process.env.TURSO_DATABASE_URL || process.env.NEXT_PUBLIC_TURSO_DATABASE_URL;
  let authToken: string | undefined = process.env.TURSO_AUTH_TOKEN;

  // Fallback to Cloudflare Worker execution context if process.env is unpopulated
  try {
    const cfContext = getCloudflareContext();
    if (cfContext?.env) {
      const cfEnv = cfContext.env as unknown as Record<string, string | undefined>;
      url = url || cfEnv.TURSO_DATABASE_URL;
      authToken = authToken || cfEnv.TURSO_AUTH_TOKEN;
    }
  } catch (_e) {
    // Ignore error when running outside Cloudflare Worker context (e.g. build time)
  }

  if (!url) {
    throw new Error('TURSO_DATABASE_URL is missing from environment secrets');
  }

  // Force protocol to https:// for Cloudflare Worker HTTP fetch compatibility
  const formattedUrl = url.replace(/^libsql:\/\//, 'https://');

  const key = `${formattedUrl}::${authToken ?? ''}`;
  if (cachedClient && cachedClientKey === key) return cachedClient;

  cachedClient = createClient({
    url: formattedUrl,
    authToken,
  });
  cachedClientKey = key;
  return cachedClient;
}
