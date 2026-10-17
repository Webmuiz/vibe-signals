/**
 * Predictive Slippage Visualizer
 * ==============================
 *
 * Simulates what a buy of a given USD size would actually cost on a VibeVibe
 * bonding curve, so the UI can warn users before they trade.
 *
 * Why quotes instead of a hand-rolled formula
 * -------------------------------------------
 * The curve applies a live tax (`currentRateBps`) that is split between tokens
 * and the pair currency, and the price itself moves along the curve as supply
 * is bought. Re-deriving that arithmetic off-chain would drift from the
 * contract. `curve.quoteBuyExactIn(pairIn)` returns the exact
 * `(gross, net, cost, pairFee, refund)` tuple the contract would produce, so
 * every tier is simulated with the same code path a real trade takes.
 *
 * Spot price is likewise taken from a tiny probe quote (1e15 pair units) rather
 * than from reserves, which keeps it consistent with the tier quotes.
 *
 * Price impact is then:
 *
 *     impact = (1 - effectiveExecutionPrice / spotPrice) * 100
 *
 * where `effectiveExecutionPrice = cost / net` (pair units per token, tax and
 * curve movement included). A tier that would complete the curve reports the
 * impact of the portion that actually fills, since `refund` is returned unused.
 *
 * All RPC access is best-effort: an unreachable node or a token without a
 * curve yields an empty tier list rather than throwing.
 */
import { parseAbi, type Address } from 'viem';

import { FACTORY_ADDRESS, publicClient } from './securitySimulator';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SlippageTier {
    /** Trade size in USD. */
    usdAmount: number;
    /** Tokens the buyer would actually receive. */
    tokenAmount: number;
    /** Percentage worse than spot, including tax and curve movement. */
    priceImpactPct: number;
    /** Effective USD price paid per token for this size. */
    executionPriceUsd: number;
}

export interface SlippageAnalysis {
    tokenAddress: string;
    /** Current USD price per token, from a probe quote. */
    spotPriceUsd: number;
    tiers: SlippageTier[];
    /** True once the curve has graduated (curve trading is closed). */
    curveComplete: boolean;
    /** Resolved curve address, or null when the token has no curve. */
    curveAddress: Address | null;
    /** True when the pair currency is native ETH (price is USD-convertible). */
    pairIsEth: boolean;
    /** Non-fatal problems encountered while reading the curve. */
    warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Trade sizes the visualizer charts, in USD. */
export const SLIPPAGE_TIER_USD = [100, 1_000, 5_000, 10_000] as const;

/** Probe size used to derive spot price (0.001 pair units). */
const SPOT_PROBE_PAIR_UNITS = 10n ** 15n;

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

const FACTORY_ABI = parseAbi([
    'function curveOf(address token) view returns (address)',
]);

const CURVE_ABI = parseAbi([
    'function pairCurrency() view returns (address)',
    'function complete() view returns (bool)',
    'function sold() view returns (uint120)',
    'function targetPairUnits() view returns (uint256)',
    'function pairPrincipal() view returns (uint128)',
    'function currentRateBps() view returns (uint256)',
    'function quoteBuyExactIn(uint256 pairIn) view returns (uint256 gross, uint256 net, uint256 cost, uint256 pairFee, uint256 refund)',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const round2 = (value: number) => Math.round(value * 100) / 100;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** viem errors carry richer text in `shortMessage` / `details`. */
interface ViemLikeError extends Error {
    shortMessage?: string;
    details?: string;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        const rich = error as ViemLikeError;
        return (rich.shortMessage || rich.details || error.message)
            .toString()
            .slice(0, 200);
    }
    return String(error).slice(0, 200);
}

/**
 * Best-effort `readContract`. Returns `null` instead of throwing when the
 * method is unsupported or the RPC call fails, recording a warning.
 */
async function safeRead<T>(
    params: Parameters<typeof publicClient.readContract>[0],
    warnings: string[],
    label: string
): Promise<T | null> {
    try {
        return (await publicClient.readContract(params)) as T;
    } catch (error) {
        warnings.push(`${label}: ${errorMessage(error)}`);
        return null;
    }
}

/** Convert a USD amount to pair-currency wei using the ETH/USD rate. */
function usdToPairUnits(usdAmount: number, ethPriceUsd: number): bigint {
    if (!Number.isFinite(usdAmount) || usdAmount <= 0) return 0n;
    if (!Number.isFinite(ethPriceUsd) || ethPriceUsd <= 0) return 0n;
    const pairUnits = usdAmount / ethPriceUsd;
    if (!Number.isFinite(pairUnits) || pairUnits <= 0) return 0n;
    // 18-decimal fixed point, truncated to avoid overstating the trade size.
    return BigInt(Math.floor(pairUnits * 1e18));
}

/** `cost / net` in pair units per token (both 18-decimal). */
function executionPricePair(cost: bigint, net: bigint): number {
    if (net <= 0n) return 0;
    return Number(cost) / Number(net);
}

// ---------------------------------------------------------------------------
// Curve state
// ---------------------------------------------------------------------------

export interface CurveState {
    curveAddress: Address | null;
    pairCurrency: Address | null;
    pairIsEth: boolean;
    complete: boolean;
    sold: bigint | null;
    targetPairUnits: bigint | null;
    pairPrincipal: bigint | null;
    currentRateBps: bigint | null;
    warnings: string[];
}

/**
 * Read the bonding-curve parameters for a token.
 *
 * Returns `curveAddress: null` when the factory has no curve for the token
 * (legacy or non-launchpad token) — callers treat that as "not simulatable".
 */
export async function readCurveState(tokenAddress: string): Promise<CurveState> {
    const token = tokenAddress as Address;
    const warnings: string[] = [];

    const state: CurveState = {
        curveAddress: null,
        pairCurrency: null,
        pairIsEth: false,
        complete: false,
        sold: null,
        targetPairUnits: null,
        pairPrincipal: null,
        currentRateBps: null,
        warnings,
    };

    const resolvedCurve = await safeRead<Address>(
        {
            address: FACTORY_ADDRESS,
            abi: FACTORY_ABI,
            functionName: 'curveOf',
            args: [token],
        },
        warnings,
        'curveOf'
    );

    if (!resolvedCurve || resolvedCurve === ZERO_ADDRESS) {
        warnings.push('No bonding curve registered for this token');
        return state;
    }

    state.curveAddress = resolvedCurve;

    const [pairCurrency, complete, sold, target, principal, rateBps] =
        await Promise.all([
            safeRead<Address>(
                { address: resolvedCurve, abi: CURVE_ABI, functionName: 'pairCurrency' },
                warnings,
                'pairCurrency'
            ),
            safeRead<boolean>(
                { address: resolvedCurve, abi: CURVE_ABI, functionName: 'complete' },
                warnings,
                'complete'
            ),
            safeRead<bigint>(
                { address: resolvedCurve, abi: CURVE_ABI, functionName: 'sold' },
                warnings,
                'sold'
            ),
            safeRead<bigint>(
                { address: resolvedCurve, abi: CURVE_ABI, functionName: 'targetPairUnits' },
                warnings,
                'targetPairUnits'
            ),
            safeRead<bigint>(
                { address: resolvedCurve, abi: CURVE_ABI, functionName: 'pairPrincipal' },
                warnings,
                'pairPrincipal'
            ),
            safeRead<bigint>(
                { address: resolvedCurve, abi: CURVE_ABI, functionName: 'currentRateBps' },
                warnings,
                'currentRateBps'
            ),
        ]);

    state.pairCurrency = pairCurrency ?? null;
    state.pairIsEth = pairCurrency === ZERO_ADDRESS;
    state.complete = complete === true;
    state.sold = sold ?? null;
    state.targetPairUnits = target ?? null;
    state.pairPrincipal = principal ?? null;
    state.currentRateBps = rateBps ?? null;

    return state;
}

// ---------------------------------------------------------------------------
// Spot price
// ---------------------------------------------------------------------------

/**
 * Derive the current spot price in pair units per token from a probe quote.
 *
 * A 1e15 pair-unit probe is small enough not to move the curve measurably, so
 * `cost / net` is the marginal price the next buyer pays.
 */
export async function readSpotPricePair(
    curveAddress: Address,
    warnings: string[]
): Promise<number> {
    try {
        const quote = (await publicClient.readContract({
            address: curveAddress,
            abi: CURVE_ABI,
            functionName: 'quoteBuyExactIn',
            args: [SPOT_PROBE_PAIR_UNITS],
        })) as readonly [bigint, bigint, bigint, bigint, bigint];

        const [, net, cost] = quote;
        const price = executionPricePair(cost, net);
        if (price > 0) return price;
        warnings.push('Spot probe returned no tokens');
        return 0;
    } catch (error) {
        warnings.push(`spot quote: ${errorMessage(error)}`);
        return 0;
    }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Simulate buys of $100 / $1k / $5k / $10k against the token's bonding curve.
 *
 * @param tokenAddress ERC-20 token address on Robinhood Chain testnet.
 * @param ethPriceUsd  ETH spot price in USD, used to size the trades.
 */
export async function calculateSlippageTiers(
    tokenAddress: string,
    ethPriceUsd: number
): Promise<SlippageAnalysis> {
    const token = tokenAddress.toLowerCase();
    const state = await readCurveState(token);

    const base: SlippageAnalysis = {
        tokenAddress: token,
        spotPriceUsd: 0,
        tiers: [],
        curveComplete: state.complete,
        curveAddress: state.curveAddress,
        pairIsEth: state.pairIsEth,
        warnings: state.warnings,
    };

    if (!state.curveAddress) return base;

    // A graduated curve no longer trades; there is nothing to simulate.
    if (state.complete) {
        state.warnings.push('Curve is complete — token trades on the v4 pool');
        return base;
    }

    // Non-ETH pairs are priced in another token, so a USD conversion would
    // require that token's own USD price. Report the curve but no tiers.
    if (!state.pairIsEth) {
        state.warnings.push('Pair currency is not ETH — USD tiers unavailable');
        return base;
    }

    const spotPricePair = await readSpotPricePair(state.curveAddress, state.warnings);
    if (spotPricePair <= 0) return base;

    const spotPriceUsd = spotPricePair * ethPriceUsd;
    if (!Number.isFinite(spotPriceUsd) || spotPriceUsd <= 0) return base;

    const tiers: SlippageTier[] = [];

    for (const usdAmount of SLIPPAGE_TIER_USD) {
        const pairIn = usdToPairUnits(usdAmount, ethPriceUsd);
        if (pairIn <= 0n) continue;

        let quote: readonly [bigint, bigint, bigint, bigint, bigint];
        try {
            quote = (await publicClient.readContract({
                address: state.curveAddress,
                abi: CURVE_ABI,
                functionName: 'quoteBuyExactIn',
                args: [pairIn],
            })) as readonly [bigint, bigint, bigint, bigint, bigint];
        } catch (error) {
            state.warnings.push(`quote $${usdAmount}: ${errorMessage(error)}`);
            continue;
        }

        const [, net, cost] = quote;
        if (net <= 0n || cost <= 0n) continue;

        const effectivePricePair = executionPricePair(cost, net);
        const executionPriceUsd = effectivePricePair * ethPriceUsd;
        const tokenAmount = Number(net) / 1e18;

        // Impact is measured against spot; clamp at 0 so a rounding artefact
        // can never surface as a negative (favourable) impact.
        const rawImpact = (1 - effectivePricePair / spotPricePair) * 100;
        const priceImpactPct = Math.max(0, rawImpact);

        if (!Number.isFinite(executionPriceUsd) || !Number.isFinite(tokenAmount)) {
            continue;
        }

        tiers.push({
            usdAmount,
            tokenAmount: round6(tokenAmount),
            priceImpactPct: round2(priceImpactPct),
            executionPriceUsd: round6(executionPriceUsd),
        });
    }

    return {
        ...base,
        spotPriceUsd: round6(spotPriceUsd),
        tiers,
    };
}
