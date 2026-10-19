import { createClient } from '@libsql/client/web';
import { getCloudflareContext } from '@opennextjs/cloudflare';

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

  return createClient({
    url: formattedUrl,
    authToken,
  });
}
