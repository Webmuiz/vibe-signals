/**
 * Organic Mindshare Scoring Engine
 * ================================
 *
 * Turns raw Telegram chatter into a 0-100 "mindshare" score for a token and
 * persists the result to Turso (`mindshare_telemetry`, created by
 * scripts/migrations/002_analytics_tables.sql).
 *
 * The score blends three independent signals:
 *
 *   O — Organic Ratio      how widely the chatter is spread across distinct
 *                          channels relative to total mention volume. A token
 *                          spammed by one channel scores low; genuine interest
 *                          spread over many channels scores high.
 *
 *   V — Velocity Accel.    mentions in the last hour vs. the 24h hourly
 *                          average. >1 means the conversation is accelerating.
 *
 *   S — Sentiment          bullish vs. warning keyword balance across the raw
 *                          sample text, normalised to [-1, 1].
 *
 *   score = round( clamp( V*40 + (S+1)*15 + O*30, 0, 100 ) )
 *
 * Note the weights sum to 100 only when S = 0 (neutral): V*40 + 15 + O*30.
 * A fully bullish sample (S = 1) can reach 100; a fully bearish one (S = -1)
 * loses the entire 30-point sentiment block.
 *
 * All database access is best-effort: write failures are logged and swallowed
 * so a Turso outage can never break a caller's request path.
 */
import { createClient, type Client as LibsqlClient } from '@libsql/client';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface MindshareInput {
    tokenAddress: string;
    /** Total Telegram mentions observed in the trailing 24 hours. */
    telegramMentions24h: number;
    /** Number of distinct channels those mentions came from. */
    uniqueChannels: number;
    /** Mentions observed in the last hour. */
    velocity1h: number;
    /** Sample posts / messages used for sentiment analysis. */
    rawTextData: string[];
}

export interface MindshareBreakdown {
    /** Organic ratio, 0-1. */
    organicRatio: number;
    /** Velocity acceleration, 0-1. */
    velocityAcceleration: number;
    /** Sentiment, -1 to 1. */
    sentimentScore: number;
    /** Final composite score, 0-100. */
    computedMindshareScore: number;
    /** Number of bullish keyword hits across the sample. */
    bullishHits: number;
    /** Number of warning keyword hits across the sample. */
    warningHits: number;
}

export interface MindshareTelemetry extends MindshareBreakdown {
    tokenAddress: string;
    telegramMentions24h: number;
    uniqueChannels: number;
    updatedAt: string | null;
    /** True when no row existed and the zeroed default was returned. */
    isDefault: boolean;
}

// ---------------------------------------------------------------------------
// Sentiment dictionary
// ---------------------------------------------------------------------------

/** Positive signals. Matched case-insensitively as substrings. */
const BULLISH_SIGNALS = [
    'gem',
    'alpha',
    'moon',
    'bullish',
    '100x',
    'dev cooking',
] as const;

/** Negative / warning signals. Matched case-insensitively as substrings. */
const WARNING_SIGNALS = [
    'rug',
    'scam',
    'dump',
    'jeode',
    'cabals',
] as const;

/**
 * Count keyword occurrences across the sample.
 *
 * Matching is substring-based on lowercased text, which catches inflections
 * ("gems", "mooning", "rugged") without a stemmer. Each keyword is counted at
 * most once per message so a single rant cannot dominate the score.
 */
function countSignals(
    texts: string[],
    signals: readonly string[]
): number {
    let hits = 0;
    for (const text of texts) {
        if (typeof text !== 'string' || text.length === 0) continue;
        const haystack = text.toLowerCase();
        for (const signal of signals) {
            if (haystack.includes(signal)) hits += 1;
        }
    }
    return hits;
}

/**
 * Sentiment in [-1, 1].
 *
 *   S = (bullish - warning) / (bullish + warning)
 *
 * With no signal words at all the sample is neutral (0). A sample that is
 * entirely bullish returns 1, entirely bearish returns -1.
 */
export function computeSentiment(rawTextData: string[]): {
    sentimentScore: number;
    bullishHits: number;
    warningHits: number;
} {
    const texts = Array.isArray(rawTextData) ? rawTextData : [];
    const bullishHits = countSignals(texts, BULLISH_SIGNALS);
    const warningHits = countSignals(texts, WARNING_SIGNALS);
    const total = bullishHits + warningHits;

    const sentimentScore = total === 0 ? 0 : (bullishHits - warningHits) / total;

    return {
        sentimentScore: Math.max(-1, Math.min(1, sentimentScore)),
        bullishHits,
        warningHits,
    };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Pure scoring function — no I/O, safe to call in a render or test.
 *
 * Guards against NaN / negative / missing inputs by coercing to 0, so a
 * partially-populated upstream payload still yields a usable score.
 */
export function computeMindshareScore(input: MindshareInput): MindshareBreakdown {
    const mentions = Number.isFinite(input.telegramMentions24h)
        ? Math.max(0, input.telegramMentions24h)
        : 0;
    const channels = Number.isFinite(input.uniqueChannels)
        ? Math.max(0, input.uniqueChannels)
        : 0;
    const velocity = Number.isFinite(input.velocity1h)
        ? Math.max(0, input.velocity1h)
        : 0;

    // Organic Ratio: channel diversity vs. 30% of total mention volume.
    const organicRatio = clamp01(
        channels / Math.max(1, mentions * 0.3)
    );

    // Velocity Acceleration: last hour vs. the 24h hourly average.
    const velocityAcceleration = clamp01(
        velocity / Math.max(1, mentions / 24)
    );

    const { sentimentScore, bullishHits, warningHits } = computeSentiment(
        input.rawTextData
    );

    const composite =
        velocityAcceleration * 40 +
        (sentimentScore + 1) * 15 +
        organicRatio * 30;

    const computedMindshareScore = Math.round(
        Math.min(100, Math.max(0, composite))
    );

    return {
        organicRatio,
        velocityAcceleration,
        sentimentScore,
        computedMindshareScore,
        bullishHits,
        warningHits,
    };
}

// ---------------------------------------------------------------------------
// Turso client (lazy — env vars are only available at request time in Next.js)
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

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        const anyErr = error as any;
        return (anyErr.shortMessage || anyErr.details || error.message)
            .toString()
            .slice(0, 200);
    }
    return String(error).slice(0, 200);
}

/** Zeroed telemetry returned when a token has no row yet. */
export function defaultTelemetry(tokenAddress: string): MindshareTelemetry {
    return {
        tokenAddress,
        telegramMentions24h: 0,
        uniqueChannels: 0,
        organicRatio: 0,
        velocityAcceleration: 0,
        sentimentScore: 0,
        computedMindshareScore: 0,
        bullishHits: 0,
        warningHits: 0,
        updatedAt: null,
        isDefault: true,
    };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Compute the score for `input` and upsert it into `mindshare_telemetry`.
 *
 * Returns the computed breakdown regardless of whether the write succeeded.
 * Database failures are logged and swallowed — the caller never sees a throw.
 */
export async function scoreAndPersistMindshare(
    input: MindshareInput
): Promise<MindshareBreakdown> {
    const breakdown = computeMindshareScore(input);

    try {
        await getDb().execute({
            sql: `INSERT INTO mindshare_telemetry (
                    token_address,
                    telegram_mentions_24h,
                    unique_channels,
                    sentiment_score,
                    organic_ratio,
                    computed_mindshare_score,
                    updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                  ON CONFLICT(token_address) DO UPDATE SET
                    telegram_mentions_24h = excluded.telegram_mentions_24h,
                    unique_channels = excluded.unique_channels,
                    sentiment_score = excluded.sentiment_score,
                    organic_ratio = excluded.organic_ratio,
                    computed_mindshare_score = excluded.computed_mindshare_score,
                    updated_at = CURRENT_TIMESTAMP`,
            args: [
                input.tokenAddress.toLowerCase(),
                Math.max(0, Math.round(input.telegramMentions24h || 0)),
                Math.max(0, Math.round(input.uniqueChannels || 0)),
                breakdown.sentimentScore,
                breakdown.organicRatio,
                breakdown.computedMindshareScore,
            ],
        });
    } catch (error) {
        // Never let a DB outage break the caller.
        console.warn(
            `[mindshareEngine] Failed to persist telemetry for ${input.tokenAddress}: ${errorMessage(error)}`
        );
    }

    return breakdown;
}

/**
 * Read the latest telemetry row for a token.
 *
 * Returns a zeroed default (with `isDefault: true`) when the token has no row
 * yet, or when the query fails — this helper never throws.
 */
export async function getMindshareTelemetry(
    tokenAddress: string
): Promise<MindshareTelemetry> {
    try {
        const res = await getDb().execute({
            sql: `SELECT
                    token_address,
                    telegram_mentions_24h,
                    unique_channels,
                    sentiment_score,
                    organic_ratio,
                    computed_mindshare_score,
                    updated_at
                  FROM mindshare_telemetry
                  WHERE token_address = ?
                  LIMIT 1`,
            args: [tokenAddress.toLowerCase()],
        });

        const row = res.rows[0];
        if (!row) return defaultTelemetry(tokenAddress);

        const sentimentScore = Number(row.sentiment_score ?? 0);
        const organicRatio = Number(row.organic_ratio ?? 0);
        const computedMindshareScore = Number(row.computed_mindshare_score ?? 0);

        return {
            tokenAddress: String(row.token_address ?? tokenAddress),
            telegramMentions24h: Number(row.telegram_mentions_24h ?? 0),
            uniqueChannels: Number(row.unique_channels ?? 0),
            organicRatio,
            // Velocity is not persisted (the schema has no column for it), so
            // it is reconstructed from the stored score components as 0.
            velocityAcceleration: 0,
            sentimentScore,
            computedMindshareScore,
            bullishHits: 0,
            warningHits: 0,
            updatedAt: row.updated_at ? String(row.updated_at) : null,
            isDefault: false,
        };
    } catch (error) {
        console.warn(
            `[mindshareEngine] Failed to read telemetry for ${tokenAddress}: ${errorMessage(error)}`
        );
        return defaultTelemetry(tokenAddress);
    }
}
