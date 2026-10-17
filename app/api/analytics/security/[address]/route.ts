/**
 * GET /api/analytics/security/[address]
 * =====================================
 *
 * Returns the security profile of a token, served from the `security_simulations`
 * cache when fresh and recomputed on the fly when stale.
 *
 * Stale policy: a cached row is reused only while `simulated_at` is younger than
 * one hour. Older rows (or missing rows) trigger a fresh `simulateTokenSecurity()`
 * run, which persists its own verdict before returning.
 *
 * Response shape:
 *   { success: true,  data: SecuritySimulationResult }
 *   { success: false, error: "Failed to fetch security analysis" }  // HTTP 500
 *
 * Cloudflare / OpenNext notes:
 *   - `runtime = 'edge'` is deprecated in Next.js 16 and is intentionally NOT
 *     exported here. OpenNext compiles route handlers to the Workers runtime
 *     automatically, so the default `nodejs` segment config is correct.
 *   - `dynamic = 'force-dynamic'` keeps the handler out of any static
 *     optimisation pass, matching app/api/tokens/route.ts.
 *   - The Turso client is created lazily inside the request (see getDb) because
 *     env vars are not available during build-time module evaluation.
 */
import { NextResponse } from 'next/server';
import { createClient, type Client as LibsqlClient } from '@libsql/client';
import {
    simulateTokenSecurity,
    type RiskLevel,
    type SecuritySimulationResult,
} from '@/lib/analytics/securitySimulator';

export const dynamic = 'force-dynamic';

/** A cached verdict older than this is recomputed. */
const STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour

const ERROR_RESPONSE = {
    success: false as const,
    error: 'Failed to fetch security analysis',
};

// ---------------------------------------------------------------------------
// Turso client (lazy — env vars only exist at request time)
// ---------------------------------------------------------------------------
let db: LibsqlClient | null = null;

function getDb(): LibsqlClient {
    if (db) return db;
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) throw new Error('TURSO_DATABASE_URL is not set');
    db = createClient({ url, authToken });
    return db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Basic sanity check so we never hand a malformed string to viem. */
function isAddressLike(value: string): boolean {
    return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        const anyErr = error as any;
        return (anyErr.shortMessage || anyErr.details || error.message)
            .toString()
            .slice(0, 200);
    }
    return String(error).slice(0, 200);
}

/**
 * Parse a SQLite `CURRENT_TIMESTAMP` value ("YYYY-MM-DD HH:MM:SS", UTC) into
 * epoch milliseconds. Returns `null` when the value is missing or unparseable,
 * which the caller treats as stale.
 */
function parseSqliteTimestamp(value: unknown): number | null {
    if (value === null || value === undefined) return null;

    // libsql may hand back a Date, a number, or a string depending on the column
    // affinity and driver version — normalise all three.
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    const raw = String(value).trim();
    if (raw.length === 0) return null;

    // SQLite's CURRENT_TIMESTAMP has no timezone suffix but is always UTC.
    // Appending 'Z' prevents the JS engine from interpreting it as local time.
    const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
        ? raw
        : `${raw.replace(' ', 'T')}Z`;

    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
}

interface CachedSimulation {
    result: SecuritySimulationResult;
    simulatedAtMs: number | null;
}

/**
 * Read the cached verdict for `tokenAddress`.
 *
 * Returns `null` when no row exists. Throws only on a genuine DB failure, which
 * the route treats as "no cache" and falls through to a live simulation.
 */
async function readCachedSimulation(
    tokenAddress: string
): Promise<CachedSimulation | null> {
    const res = await getDb().execute({
        sql: `SELECT
                token_address,
                is_honeypot,
                buy_tax_percent,
                sell_tax_percent,
                can_black_list,
                is_mintable,
                risk_level,
                simulated_at
              FROM security_simulations
              WHERE token_address = ?
              LIMIT 1`,
        args: [tokenAddress],
    });

    const row = res.rows[0];
    if (!row) return null;

    const riskLevel = String(row.risk_level ?? 'MEDIUM') as RiskLevel;

    // The cache table stores only the persisted columns; `details` is not
    // persisted, so a cache hit reports an empty diagnostic block and flags
    // itself via `warnings` so consumers can tell it apart from a live run.
    const result: SecuritySimulationResult = {
        token_address: String(row.token_address ?? tokenAddress) as `0x${string}`,
        is_honeypot: Boolean(Number(row.is_honeypot ?? 0)),
        buy_tax_percent: Number(row.buy_tax_percent ?? 0),
        sell_tax_percent: Number(row.sell_tax_percent ?? 0),
        can_black_list: Boolean(Number(row.can_black_list ?? 0)),
        is_mintable: Boolean(Number(row.is_mintable ?? 0)),
        risk_level: riskLevel,
        simulated_at: row.simulated_at ? String(row.simulated_at) : '',
        details: {
            has_bytecode: true,
            curve_address: null,
            curve_complete: null,
            pair_currency: null,
            token_decimals: 18,
            owner: null,
            is_pausable: false,
            is_paused: null,
            max_tx_amount: null,
            max_wallet_amount: null,
            matched_blacklist_selectors: [],
            matched_mint_selectors: [],
            matched_pausable_selectors: [],
            warnings: ['Served from cache; diagnostic details are not persisted.'],
            curve_unavailable: true,
        },
    };

    return {
        result,
        simulatedAtMs: parseSqliteTimestamp(row.simulated_at),
    };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ address: string }> }
) {
    try {
        // Next.js 16: `params` is a Promise and must be awaited.
        const { address } = await params;

        if (!address || !isAddressLike(address)) {
            return NextResponse.json(
                { success: false, error: 'Invalid token address' },
                { status: 400 }
            );
        }

        const tokenAddress = address.toLowerCase();

        // -------------------------------------------------------------------
        // 1. Try the cache. A DB failure here must not fail the request — we
        //    simply fall through to a live simulation.
        // -------------------------------------------------------------------
        let cached: CachedSimulation | null = null;
        try {
            cached = await readCachedSimulation(tokenAddress);
        } catch (error) {
            console.warn(
                `[analytics/security] Cache read failed for ${tokenAddress}: ${errorMessage(error)}`
            );
        }

        const ageMs =
            cached?.simulatedAtMs != null
                ? Date.now() - cached.simulatedAtMs
                : Number.POSITIVE_INFINITY;

        const isFresh = cached !== null && ageMs < STALE_AFTER_MS;

        if (isFresh && cached) {
            return NextResponse.json({
                success: true,
                data: cached.result,
            });
        }

        // -------------------------------------------------------------------
        // 2. Missing or stale — recompute. `simulateTokenSecurity` persists the
        //    fresh verdict itself (persist defaults to true).
        // -------------------------------------------------------------------
        const fresh = await simulateTokenSecurity(
            tokenAddress as `0x${string}`
        );

        return NextResponse.json({
            success: true,
            data: fresh,
        });
    } catch (error) {
        console.error(
            `[analytics/security] Failed to fetch security analysis: ${errorMessage(error)}`
        );
        return NextResponse.json(ERROR_RESPONSE, { status: 500 });
    }
}
