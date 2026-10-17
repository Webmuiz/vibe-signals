/**
 * /api/analytics/mindshare/[address]
 * ==================================
 *
 * GET  — read the latest persisted mindshare telemetry for a token.
 * POST — recompute the score from a caller-supplied sample and persist it.
 *
 * GET response:
 *   { success: true, data: MindshareTelemetry }
 *
 * POST body (all fields optional; missing values are treated as 0 / []):
 *   { telegramMentions24h?, uniqueChannels?, velocity1h?, rawTextData? }
 *
 * POST response:
 *   { success: true, data: MindshareBreakdown }
 *
 * Cloudflare / OpenNext notes:
 *   - `runtime = 'edge'` is deprecated in Next.js 16 and is intentionally NOT
 *     exported. OpenNext targets the Workers runtime automatically.
 *   - `dynamic = 'force-dynamic'` keeps both handlers out of static optimisation.
 *   - The Turso client lives inside lib/analytics/mindshareEngine.ts and is
 *     created lazily on first use, so no env access happens at build time.
 */
import { NextResponse } from 'next/server';
import {
    getMindshareTelemetry,
    scoreAndPersistMindshare,
    type MindshareInput,
} from '@/lib/analytics/mindshareEngine';

export const dynamic = 'force-dynamic';

/** Upper bound on the sample we are willing to score in one request. */
const MAX_SAMPLE_MESSAGES = 500;
/** Upper bound on a single message length, to keep payloads bounded. */
const MAX_MESSAGE_LENGTH = 2000;

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

/** Coerce an arbitrary JSON value into a non-negative finite number. */
function toCount(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
}

/**
 * Normalise `rawTextData` from untrusted JSON: keep only strings, drop empties,
 * truncate over-long messages, and cap the total number of samples.
 */
function toTextSample(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (trimmed.length === 0) continue;
        out.push(trimmed.slice(0, MAX_MESSAGE_LENGTH));
        if (out.length >= MAX_SAMPLE_MESSAGES) break;
    }
    return out;
}

// ---------------------------------------------------------------------------
// GET — read latest telemetry
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

        // Never throws: returns a zeroed default when no row exists.
        const telemetry = await getMindshareTelemetry(address.toLowerCase());

        return NextResponse.json({
            success: true,
            data: telemetry,
        });
    } catch (error) {
        console.error(
            `[analytics/mindshare] Failed to read telemetry: ${errorMessage(error)}`
        );
        return NextResponse.json(
            { success: false, error: 'Failed to fetch mindshare telemetry' },
            { status: 500 }
        );
    }
}

// ---------------------------------------------------------------------------
// POST — recompute + persist
// ---------------------------------------------------------------------------

export async function POST(
    request: Request,
    { params }: { params: Promise<{ address: string }> }
) {
    try {
        const { address } = await params;

        if (!address || !isAddressLike(address)) {
            return NextResponse.json(
                { success: false, error: 'Invalid token address' },
                { status: 400 }
            );
        }

        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json(
                { success: false, error: 'Invalid JSON body' },
                { status: 400 }
            );
        }

        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return NextResponse.json(
                { success: false, error: 'Request body must be a JSON object' },
                { status: 400 }
            );
        }

        const payload = body as Record<string, unknown>;

        // The route parameter is authoritative — a `tokenAddress` in the body is
        // ignored so a caller cannot write telemetry under a different token.
        const input: MindshareInput = {
            tokenAddress: address.toLowerCase(),
            telegramMentions24h: toCount(payload.telegramMentions24h),
            uniqueChannels: toCount(payload.uniqueChannels),
            velocity1h: toCount(payload.velocity1h),
            rawTextData: toTextSample(payload.rawTextData),
        };

        // Persistence failures are swallowed inside the engine; this resolves
        // with the computed breakdown either way.
        const result = await scoreAndPersistMindshare(input);

        return NextResponse.json({
            success: true,
            data: result,
        });
    } catch (error) {
        console.error(
            `[analytics/mindshare] Failed to compute mindshare: ${errorMessage(error)}`
        );
        return NextResponse.json(
            { success: false, error: 'Failed to compute mindshare score' },
            { status: 500 }
        );
    }
}
