import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Columns the dashboard's `DBToken` shape depends on. `creator_holding_pct`
 * is not guaranteed to exist on every deployment of the `launches` table, so
 * it is resolved defensively (see `resolveCreatorHoldingColumn`) instead of
 * being hard-coded into the projection — a missing column would otherwise
 * fail the entire query and blank the dashboard.
 */
const BASE_COLUMNS = [
    'launch_id',
    'token_address',
    'amm_address',
    'dev_address',
    'pair_symbol',
    'pair_currency_address',
    'liquidity_deposited',
    'curve_progress',
    'launch_block',
    'name',
    'symbol',
    'created_at',
    'volume_eth',
    'buy_count',
    'sell_count',
    'buy_pct',
    'sell_pct',
    'has_socials',
    'cachedMarketCapFormatted',
    'block_zero_buyers',
    'sniper_retention_pct',
] as const;

/**
 * Detects whether `launches.creator_holding_pct` exists. Cached per process so
 * we pay the `PRAGMA` cost at most once per cold start.
 */
let creatorHoldingColumn: Promise<boolean> | null = null;

function hasCreatorHoldingColumn(): Promise<boolean> {
    if (!creatorHoldingColumn) {
        creatorHoldingColumn = (async () => {
            try {
                const db = getDb();
                const info = await db.execute('PRAGMA table_info(launches)');
                return info.rows.some(
                    (row) => String((row as Record<string, unknown>).name) === 'creator_holding_pct'
                );
            } catch {
                // If the probe fails we simply omit the column; the dashboard
                // tolerates an undefined `creator_holding_pct`.
                return false;
            }
        })();
    }
    return creatorHoldingColumn;
}

function toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export async function GET() {
    let db;
    try {
        db = getDb();
    } catch (error) {
        // Credentials missing / client construction failed. This is a server
        // misconfiguration, not an empty dataset — surface it as 503 so the
        // dashboard can distinguish "not connected" from "0 launches".
        console.error('Turso client unavailable:', error);
        return NextResponse.json(
            { success: false, error: 'Database unavailable' },
            { status: 503 }
        );
    }

    try {
        const includeCreatorHolding = await hasCreatorHoldingColumn();
        const columns = includeCreatorHolding
            ? [...BASE_COLUMNS, 'creator_holding_pct']
            : [...BASE_COLUMNS];

        const result = await db.execute({
            sql: `SELECT ${columns.join(', ')} FROM launches ORDER BY launch_id DESC LIMIT 50`,
            args: [],
        });

        const formattedData = result.rows.map((db) => {
            const row = db as Record<string, unknown>;
            return {
                launchId: row.launch_id,
                tokenAddress: row.token_address,
                ammAddress: row.amm_address,
                devAddress: row.dev_address,
                ethDeposited: row.liquidity_deposited,
                // `pairSymbol` may be null (e.g. MOBLAND) — preserve null rather than
                // coercing to 'ETH', which would misprice a non-ETH pair. The
                // authoritative quote-asset key is `pairCurrencyAddress`.
                pairSymbol: row.pair_symbol ?? null,
                pairCurrencyAddress: row.pair_currency_address ?? null,
                curveProgress: row.curve_progress,
                launchBlock: row.launch_block,
                timestamp: row.created_at,
                name: row.name || `Token #${row.launch_id}`,
                ticker: row.symbol ? `$${row.symbol}` : '\$TKN',
                volume_eth: toNumberOrNull(row.volume_eth),
                buy_pct: toNumberOrNull(row.buy_pct),
                sell_pct: toNumberOrNull(row.sell_pct),
                has_socials: Number(row.has_socials ?? 0) === 1,
                creator_holding_pct: toNumberOrNull(row.creator_holding_pct),
                cachedMarketCapFormatted:
                    typeof row.cachedMarketCapFormatted === 'string'
                        ? row.cachedMarketCapFormatted
                        : null,
                block_zero_buyers: row.block_zero_buyers,
                sniper_retention_pct: row.sniper_retention_pct,
            };
        });

        return NextResponse.json(formattedData);
    } catch (error) {
        // Connection/auth/query failure. Never masquerade as an empty list.
        console.error('Failed to read Turso:', error);
        return NextResponse.json(
            { success: false, error: 'Database unavailable' },
            { status: 503 }
        );
    }
}
