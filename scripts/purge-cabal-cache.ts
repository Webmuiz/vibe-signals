/**
 * purge-cabal-cache.ts
 * ====================
 *
 * One-shot maintenance script: clears every row from `insider_clusters`.
 *
 * Why: rows written before the protocol-contract filter landed were computed
 * with the AMM pair / bonding curve included as a "whale", inflating
 * `cabal_supply_pct` (e.g. 63.2% for 0xBURN). The route only recomputes when a
 * row is missing or older than one hour, so stale verdicts must be deleted
 * explicitly.
 *
 * Usage:
 *   npx tsx scripts/purge-cabal-cache.ts
 *
 * Reads TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from the environment, falling
 * back to `.env.local` in the project root.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@libsql/client';

/** Minimal `.env.local` loader (KEY=VALUE, `#` comments, optional quotes). */
function loadEnvLocal(): void {
    const envPath = resolve(process.cwd(), '.env.local');
    if (!existsSync(envPath)) return;

    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = value;
    }
}

async function main(): Promise<void> {
    loadEnvLocal();

    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url) {
        throw new Error('TURSO_DATABASE_URL is not set (checked env and .env.local)');
    }

    const db = createClient({
        url: url.replace(/^libsql:\/\//, 'https://'),
        authToken,
    });

    const before = await db.execute('SELECT COUNT(*) AS n FROM insider_clusters');
    const countBefore = Number(before.rows[0]?.n ?? 0);

    await db.execute('DELETE FROM insider_clusters');

    const after = await db.execute('SELECT COUNT(*) AS n FROM insider_clusters');
    const countAfter = Number(after.rows[0]?.n ?? 0);

    console.log(
        `[purge-cabal-cache] deleted ${countBefore} row(s); ${countAfter} remaining.`
    );
}

main().catch((error) => {
    console.error('[purge-cabal-cache] failed:', error);
    process.exit(1);
});
