import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cached } from '@/lib/responseCache';
import {
  buildMockTokens,
  mapLaunchRow,
  type LeaderboardResponse,
  type RawLaunchRow,
} from '@/lib/signals';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const LEADERBOARD_LIMIT = 100;

// One Turso query per 15s window no matter how many clients are polling.
const LEADERBOARD_CACHE_TTL_MS = 15_000;

export async function GET() {
  const generatedAt = new Date().toISOString();

  try {
    const body = await cached<LeaderboardResponse>(
      'leaderboard',
      LEADERBOARD_CACHE_TTL_MS,
      async () => {
        const db = getDb();

        const result = await db.execute({
          sql: `SELECT launch_id, token_address, amm_address, dev_address, pair_symbol,
                       liquidity_deposited, curve_progress, name, symbol, has_socials,
                       cachedMarketCapFormatted, volume_eth, buy_count, sell_count,
                       buy_pct, block_zero_buyers, created_at
                FROM launches
                ORDER BY launch_id DESC
                LIMIT ?`,
          args: [LEADERBOARD_LIMIT],
        });

        const tokens = (result.rows as unknown as RawLaunchRow[]).map(mapLaunchRow);

        if (tokens.length === 0) {
          return {
            success: true,
            data: buildMockTokens(),
            mock: true,
            generatedAt,
          } as LeaderboardResponse;
        }

        // Rank by Vibe Score, then liquidity as a tiebreaker.
        const ranked = tokens.sort(
          (a, b) => b.vibeScore - a.vibeScore || b.liquidity - a.liquidity
        );

        return {
          success: true,
          data: ranked,
          generatedAt,
        } as LeaderboardResponse;
      }
    );

    return NextResponse.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database error';
    console.error('[api/leaderboard] Turso query failed:', message);

    const body: LeaderboardResponse = {
      success: true,
      data: buildMockTokens(),
      mock: true,
      error: message,
      generatedAt,
    };
    return NextResponse.json(body);
  }
}
