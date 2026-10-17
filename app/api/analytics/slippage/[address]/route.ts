/**
 * Predictive Slippage API
 * =======================
 *
 * GET /api/analytics/slippage/:address
 *
 * Returns the current spot price plus simulated buy tiers ($100 / $1k / $5k /
 * $10k) for a VibeVibe bonding-curve token.
 *
 * The ETH/USD rate is fetched from Coinbase with a short timeout and falls back
 * to `FALLBACK_ETH_USD`, matching the policy used by `/api/proxyVibe` and
 * `/api/proxyPortfolio` — a slow oracle must never block the response.
 */
import { NextResponse } from 'next/server';

import { calculateSlippageTiers } from '@/lib/analytics/slippageCalculator';

// Route handlers are never cached; curve state changes with every trade.
export const dynamic = 'force-dynamic';

const FALLBACK_ETH_USD = 2600;
const ORACLE_TIMEOUT_MS = Number(process.env.VIBE_ORACLE_TIMEOUT_MS) || 2500;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const ERROR_RESPONSE = {
    success: false as const,
    error: 'Failed to calculate slippage',
};

/** Coinbase spot-price envelope: `{ data: { amount: "2416.12", ... } }`. */
interface CoinbaseSpotPayload {
    data?: { amount?: string };
}

function isAddressLike(value: string): boolean {
    return ADDRESS_PATTERN.test(value);
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message.toString().slice(0, 200);
    }
    return String(error).slice(0, 200);
}

/**
 * Resolve ETH/USD, degrading to the fallback on timeout, non-2xx, or a
 * malformed payload. Never throws.
 */
async function fetchEthPriceUsd(): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ORACLE_TIMEOUT_MS);

    try {
        const res = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', {
            cache: 'no-store',
            signal: controller.signal,
        });

        if (!res.ok) {
            console.warn(
                `[slippage] ETH oracle returned ${res.status} — using fallback $${FALLBACK_ETH_USD}`
            );
            return FALLBACK_ETH_USD;
        }

        const payload = (await res.json()) as CoinbaseSpotPayload;
        const amount = Number(payload?.data?.amount);

        if (Number.isFinite(amount) && amount > 0) return amount;

        console.warn(
            `[slippage] ETH oracle payload invalid — using fallback $${FALLBACK_ETH_USD}`
        );
        return FALLBACK_ETH_USD;
    } catch (error) {
        console.warn(
            `[slippage] ETH oracle unavailable (${errorMessage(error)}) — using fallback $${FALLBACK_ETH_USD}`
        );
        return FALLBACK_ETH_USD;
    } finally {
        clearTimeout(timer);
    }
}

export async function GET(
    _request: Request,
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

        const tokenAddress = address.toLowerCase();
        const ethPriceUsd = await fetchEthPriceUsd();

        const analysis = await calculateSlippageTiers(tokenAddress, ethPriceUsd);

        return NextResponse.json({
            success: true,
            data: {
                spotPriceUsd: analysis.spotPriceUsd,
                tiers: analysis.tiers,
                curveComplete: analysis.curveComplete,
            },
        });
    } catch (error) {
        console.error(`[slippage] GET failed: ${errorMessage(error)}`);
        return NextResponse.json(ERROR_RESPONSE, { status: 500 });
    }
}
