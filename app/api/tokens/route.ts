import { NextResponse } from 'next/server';
import { createClient } from '@libsql/client';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        // Initialize inside the function so it doesn't run during build evaluation
        const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
        const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

        if (!TURSO_DATABASE_URL) {
            console.error("Missing Turso credentials");
            return NextResponse.json([]);
        }

        const client = createClient({
            url: TURSO_DATABASE_URL,
            authToken: TURSO_AUTH_TOKEN,
        });

        const result = await client.execute({
            sql: 'SELECT * FROM launches ORDER BY launch_id DESC LIMIT 50',
            args: [],
        });

        const formattedData = result.rows.map((db) => ({
            launchId: db.launch_id,
            tokenAddress: db.token_address,
            ammAddress: db.amm_address,
            devAddress: db.dev_address,
            ethDeposited: db.liquidity_deposited,
            pairSymbol: db.pair_symbol || 'ETH',
            curveProgress: db.curve_progress,
            launchBlock: db.launch_block,
            timestamp: db.created_at,
            name: db.name || `Token #${db.launch_id}`,
            ticker: db.symbol ? `$${db.symbol}` : '\$TKN'
        }));

        return NextResponse.json(formattedData);
    } catch (error) {
        console.error("Failed to read Turso:", error);
        return NextResponse.json([]);
    }
}
