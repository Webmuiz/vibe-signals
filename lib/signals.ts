/**
 * Shared types + pure helpers for the Vibe Signals data layer.
 *
 * The indexer persists one row per launched token in the `launches` table and
 * mutates it as trades arrive (volume, buy/sell counts, curve progress). There
 * is no dedicated event-log table, so the API derives a chronological signal
 * stream from the indexed rows: a liquidity SYNC per token plus BUY events
 * proportional to the recorded buy count.
 */

export type SignalKind = 'SYNC' | 'BUY';

export interface Signal {
  /** Stable id for React keys / dedupe across polls. */
  id: string;
  kind: SignalKind;
  /** Token ticker without the `$` prefix. */
  symbol: string;
  tokenAddress: string;
  /** Liquidity in pair units (ETH) for SYNC events. */
  liquidity: number;
  /** Curve progress percentage (0-100) for SYNC events. */
  progress: number;
  /** Pair amount in ETH for BUY events. */
  amount: number;
  /** Pair label, e.g. "ETH". */
  pairSymbol: string;
  /** Buyer wallet for BUY events. */
  buyer?: string;
  /** ISO timestamp used for ordering + display. */
  timestamp: string;
}

export interface LeaderboardToken {
  launchId: number;
  symbol: string;
  name: string;
  tokenAddress: string;
  ammAddress: string | null;
  devAddress: string | null;
  pairSymbol: string;
  liquidity: number;
  progress: number;
  vibeScore: number;
  volumeEth: number;
  buyCount: number;
  sellCount: number;
  buyPct: number;
  hasSocials: boolean;
  blockZeroBuyers: number;
  marketCap: string | null;
  createdAt: string | null;
}

export interface SignalsResponse {
  success: boolean;
  data: Signal[];
  /** True when the payload is generated mock data (DB empty/unreachable). */
  mock?: boolean;
  error?: string;
  generatedAt: string;
}

export interface LeaderboardResponse {
  success: boolean;
  data: LeaderboardToken[];
  mock?: boolean;
  error?: string;
  generatedAt: string;
}

/**
 * Vibe Score (0-100): a weighted blend of bonding-curve progress, liquidity,
 * trading activity and social proof. Designed to be stable and monotonic so
 * the leaderboard ordering feels meaningful during a demo.
 */
export function computeVibeScore(input: {
  progress: number;
  liquidity: number;
  volumeEth: number;
  buyCount: number;
  sellCount: number;
  hasSocials: boolean;
}): number {
  const progressScore = Math.min(Math.max(input.progress, 0), 100) * 0.45;
  const liquidityScore = Math.min(input.liquidity / 10, 1) * 25;
  const volumeScore = Math.min(input.volumeEth / 5, 1) * 15;
  const trades = input.buyCount + input.sellCount;
  const activityScore = Math.min(trades / 50, 1) * 10;
  const socialScore = input.hasSocials ? 5 : 0;

  return Math.round(
    Math.min(progressScore + liquidityScore + volumeScore + activityScore + socialScore, 100)
  );
}

/** Deterministic pseudo-random in [0,1) from a string seed. */
function seededUnit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Short deterministic pseudo-address derived from a seed. */
function seededAddress(seed: string): string {
  let out = '0x';
  let h = 2166136261;
  for (let i = 0; i < 40; i += 1) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619);
    out += ((h >>> 0) % 16).toString(16);
  }
  return out;
}

export interface RawLaunchRow {
  launch_id: number | bigint | null;
  token_address: string | null;
  amm_address: string | null;
  dev_address: string | null;
  pair_symbol: string | null;
  liquidity_deposited: number | null;
  curve_progress: number | null;
  name: string | null;
  symbol: string | null;
  has_socials: number | null;
  cachedMarketCapFormatted: string | null;
  volume_eth: number | null;
  buy_count: number | null;
  sell_count: number | null;
  buy_pct: number | null;
  block_zero_buyers: number | null;
  created_at: string | null;
}

/** Maps a raw DB row to the typed leaderboard shape. */
export function mapLaunchRow(row: RawLaunchRow): LeaderboardToken {
  const liquidity = Number(row.liquidity_deposited ?? 0);
  const progress = Number(row.curve_progress ?? 0);
  const volumeEth = Number(row.volume_eth ?? 0);
  const buyCount = Number(row.buy_count ?? 0);
  const sellCount = Number(row.sell_count ?? 0);
  const hasSocials = Number(row.has_socials ?? 0) === 1;

  return {
    launchId: Number(row.launch_id ?? 0),
    symbol: row.symbol || 'TKN',
    name: row.name || `Token #${row.launch_id ?? '?'}`,
    tokenAddress: (row.token_address || '').toLowerCase(),
    ammAddress: row.amm_address ? row.amm_address.toLowerCase() : null,
    devAddress: row.dev_address ? row.dev_address.toLowerCase() : null,
    pairSymbol: row.pair_symbol || 'ETH',
    liquidity,
    progress,
    vibeScore: computeVibeScore({
      progress,
      liquidity,
      volumeEth,
      buyCount,
      sellCount,
      hasSocials,
    }),
    volumeEth,
    buyCount,
    sellCount,
    buyPct: Number(row.buy_pct ?? (buyCount + sellCount > 0 ? 50 : 0)),
    hasSocials,
    blockZeroBuyers: Number(row.block_zero_buyers ?? 0),
    marketCap: row.cachedMarketCapFormatted ?? null,
    createdAt: row.created_at ?? null,
  };
}

/**
 * Derives a chronological signal feed from indexed token rows.
 *
 * For each token we emit:
 *   - one SYNC event (current liquidity + curve progress)
 *   - up to `maxBuysPerToken` BUY events, sized from the token's volume and
 *     attributed to a deterministic pseudo-buyer (the indexer does not persist
 *     individual trade rows).
 *
 * Events are ordered newest-first and capped at `limit`.
 */
export function deriveSignals(
  tokens: LeaderboardToken[],
  limit = 50,
  maxBuysPerToken = 3
): Signal[] {
  const signals: Signal[] = [];
  const now = Date.now();

  tokens.forEach((token, tokenIndex) => {
    const seed = token.tokenAddress || `token-${token.launchId}`;
    // Newer tokens (lower index in a launch_id DESC list) get fresher stamps.
    const baseAgeMs = tokenIndex * 45_000;

    signals.push({
      id: `sync-${seed}`,
      kind: 'SYNC',
      symbol: token.symbol,
      tokenAddress: token.tokenAddress,
      liquidity: token.liquidity,
      progress: token.progress,
      amount: token.liquidity,
      pairSymbol: token.pairSymbol,
      timestamp: new Date(now - baseAgeMs).toISOString(),
    });

    const buyEvents = Math.min(token.buyCount, maxBuysPerToken);
    for (let i = 0; i < buyEvents; i += 1) {
      const unit = seededUnit(`${seed}-buy-${i}`);
      // Spread the token's volume across its emitted buy events.
      const amount = token.volumeEth > 0
        ? (token.volumeEth / Math.max(buyEvents, 1)) * (0.6 + unit * 0.8)
        : 0.001 + unit * 0.05;

      signals.push({
        id: `buy-${seed}-${i}`,
        kind: 'BUY',
        symbol: token.symbol,
        tokenAddress: token.tokenAddress,
        liquidity: token.liquidity,
        progress: token.progress,
        amount: Number(amount.toFixed(4)),
        pairSymbol: token.pairSymbol,
        buyer: seededAddress(`${seed}-buyer-${i}`),
        timestamp: new Date(now - baseAgeMs - (i + 1) * 12_000).toISOString(),
      });
    }
  });

  return signals
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);
}

/** Deterministic mock tokens so the UI is never empty during testing. */
export function buildMockTokens(): LeaderboardToken[] {
  const fixtures: Array<{
    symbol: string;
    name: string;
    liquidity: number;
    progress: number;
    volume: number;
    buys: number;
    sells: number;
    socials: boolean;
  }> = [
    { symbol: 'STORY', name: 'No Risk no STORY', liquidity: 1.1682, progress: 29.2, volume: 0.42, buys: 18, sells: 4, socials: true },
    { symbol: 'VIBE', name: 'Vibe Protocol', liquidity: 4.821, progress: 71.5, volume: 2.31, buys: 64, sells: 21, socials: true },
    { symbol: 'MOON', name: 'Moon Runner', liquidity: 0.6421, progress: 12.8, volume: 0.18, buys: 9, sells: 2, socials: false },
    { symbol: 'PEPE2', name: 'Pepe Reborn', liquidity: 2.104, progress: 48.3, volume: 1.02, buys: 37, sells: 15, socials: true },
    { symbol: 'ZAP', name: 'Zap Router Token', liquidity: 0.0912, progress: 3.4, volume: 0.04, buys: 3, sells: 1, socials: false },
    { symbol: 'DEGEN', name: 'Degen Casino', liquidity: 6.55, progress: 88.9, volume: 3.87, buys: 112, sells: 44, socials: true },
    { symbol: 'HOOD', name: 'Robinhood Meme', liquidity: 1.77, progress: 35.6, volume: 0.66, buys: 24, sells: 8, socials: true },
    { symbol: 'TURBO', name: 'Turbo Snail', liquidity: 0.331, progress: 8.1, volume: 0.09, buys: 6, sells: 2, socials: false },
  ];

  return fixtures.map((f, i) => {
    const tokenAddress = seededAddress(`mock-token-${f.symbol}`);
    return {
      launchId: 9000 + i,
      symbol: f.symbol,
      name: f.name,
      tokenAddress,
      ammAddress: seededAddress(`mock-amm-${f.symbol}`),
      devAddress: seededAddress(`mock-dev-${f.symbol}`),
      pairSymbol: 'ETH',
      liquidity: f.liquidity,
      progress: f.progress,
      vibeScore: computeVibeScore({
        progress: f.progress,
        liquidity: f.liquidity,
        volumeEth: f.volume,
        buyCount: f.buys,
        sellCount: f.sells,
        hasSocials: f.socials,
      }),
      volumeEth: f.volume,
      buyCount: f.buys,
      sellCount: f.sells,
      buyPct: Math.round((f.buys / (f.buys + f.sells)) * 100),
      hasSocials: f.socials,
      blockZeroBuyers: i % 3,
      marketCap: null,
      createdAt: new Date(Date.now() - i * 3_600_000).toISOString(),
    };
  });
}
