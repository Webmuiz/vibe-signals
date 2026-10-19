import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  buildMockTokens,
  deriveSignals,
  mapLaunchRow,
  type RawLaunchRow,
  type SignalsResponse,
} from '@/lib/signals';

// Always read fresh data — this endpoint is polled every few seconds.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SIGNAL_LIMIT = 50;
const TOKEN_SCAN_LIMIT = 60;

export async function GET() {
  const generatedAt = new Date().toISOString();

  try {
    const db = getDb();

    const result = await db.execute({
      sql: `SELECT launch_id, token_address, amm_address, dev_address, pair_symbol,
                   liquidity_deposited, curve_progress, name, symbol, has_socials,
                   cachedMarketCapFormatted, volume_eth, buy_count, sell_count,
                   buy_pct, block_zero_buyers, created_at
            FROM launches
            ORDER BY launch_id DESC
            LIMIT ?`,
      args: [TOKEN_SCAN_LIMIT],
    });

    const tokens = (result.rows as unknown as RawLaunchRow[]).map(mapLaunchRow);

    // Fallback: never let the feed render empty during a demo.
    if (tokens.length === 0) {
      const mockTokens = buildMockTokens();
      const body: SignalsResponse = {
        success: true,
        data: deriveSignals(mockTokens, SIGNAL_LIMIT),
        mock: true,
        generatedAt,
      };
      return NextResponse.json(body);
    }

    const body: SignalsResponse = {
      success: true,
      data: deriveSignals(tokens, SIGNAL_LIMIT),
      generatedAt,
    };
    return NextResponse.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database error';
    console.error('[api/signals] Turso query failed:', message);

    // Graceful degradation: return mock data with a 200 so the UI keeps
    // streaming instead of showing a broken terminal.
    const body: SignalsResponse = {
      success: true,
      data: deriveSignals(buildMockTokens(), SIGNAL_LIMIT),
      mock: true,
      error: message,
      generatedAt,
    };
    return NextResponse.json(body);
  }
}
