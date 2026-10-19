import { createClient, type Client } from '@libsql/client';

/**
 * Turso / libSQL singleton client.
 *
 * The indexer (running on Azure) writes live liquidity syncs and buy events
 * into the same database this frontend reads from. We keep a single client
 * instance per server process so we don't open a new HTTP connection on every
 * request — important on serverless/edge runtimes where modules are reused
 * across invocations.
 *
 * Credentials are read from the environment:
 *   - TURSO_DATABASE_URL  (server-side, preferred)
 *   - NEXT_PUBLIC_TURSO_DATABASE_URL (fallback, for preview deployments)
 *   - TURSO_AUTH_TOKEN
 *
 * The client is created lazily so importing this module during `next build`
 * (when env vars may be absent) never throws.
 */

const globalForDb = globalThis as unknown as {
  __vibeTursoClient?: Client;
};

function resolveDatabaseUrl(): string | undefined {
  return (
    process.env.TURSO_DATABASE_URL ||
    process.env.NEXT_PUBLIC_TURSO_DATABASE_URL ||
    undefined
  );
}

/**
 * Returns the shared Turso client, creating it on first use.
 *
 * @throws Error when no database URL is configured. Callers that want a
 * graceful degradation (e.g. API routes returning mock data) should catch
 * this and fall back.
 */
export function getDb(): Client {
  if (globalForDb.__vibeTursoClient) {
    return globalForDb.__vibeTursoClient;
  }

  const url = resolveDatabaseUrl();
  if (!url) {
    throw new Error(
      'Turso database URL is not configured. Set TURSO_DATABASE_URL (or NEXT_PUBLIC_TURSO_DATABASE_URL) in your environment.'
    );
  }

  const client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  // Cache on globalThis so hot-reloads in dev don't leak connections.
  globalForDb.__vibeTursoClient = client;
  return client;
}

/**
 * Eagerly-created proxy client. Property access is forwarded to the lazily
 * created singleton, so `db.execute(...)` works without importing `getDb`.
 */
export const db: Client = new Proxy({} as Client, {
  get(_target, prop, receiver) {
    const client = getDb();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

export default db;
