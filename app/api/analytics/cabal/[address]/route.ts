/**
 * Insider Cluster Mapping API
 * ===========================
 *
 * GET /api/analytics/cabal/:address
 *
 * Returns the persisted cabal analysis for a token, recomputing it when the
 * cached row is missing or older than one hour.
 *
 * Holder discovery
 * ----------------
 * The VibeVibe upstream (`/api/proxyVibe`) exposes launch metadata but no
 * holder list, so holders are reconstructed on-chain:
 *
 *   1. `Transfer` logs for the token are pulled from the RPC in bounded block
 *      windows (newest first) until the log budget is exhausted.
 *   2. Every address that appears as a sender or receiver becomes a candidate.
 *   3. `balanceOf` is read for each candidate and converted to a percentage of
 *      `totalSupply`.
 *
 * Funding origins are not recoverable from ERC-20 logs alone, so the detector
 * falls back to its whale-membership rule (any wallet above 1% of supply is a
 * cluster member). The graph is still meaningful — it captures supply
 * concentration — and the shape is ready for a funder source to be plugged in
 * later without touching this route.
 *
 * Every step is best-effort: an RPC failure yields an empty holder set, which
 * the detector scores as LOW risk rather than surfacing a 500.
 */
import { NextResponse } from 'next/server';
import { parseAbi, type Address } from 'viem';

import {
    getCabalAnalysis,
    scoreAndPersistCabal,
    unavailableCabalAnalysis,
    type CabalAnalysisResult,
    type HolderData,
} from '@/lib/analytics/cabalDetector';
import { publicClient } from '@/lib/analytics/securitySimulator';

// Route handlers are never cached; the analysis is refreshed on demand.
export const dynamic = 'force-dynamic';

/** Recompute when the persisted row is older than one hour. */
const STALE_AFTER_MS = 60 * 60 * 1000;

const ERROR_RESPONSE = {
    success: false as const,
    error: 'Failed to fetch cabal analysis',
};

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * How many blocks to scan backwards from the head, per window.
 *
 * Reduced from 50_000: on a busy testnet a 50k-block `eth_getLogs` routinely
 * exceeded the RPC's response budget and stalled the whole request. 10k keeps
 * each call cheap while still covering recent trading activity.
 */
const SCAN_BLOCK_WINDOW = 10_000n;
/** Hard cap on backward scan iterations, independent of the log budget. */
const MAX_SCAN_ITERATIONS = 3;
/** Maximum number of `Transfer` logs to inspect. */
const MAX_TRANSFER_LOGS = 2_000;
/** Maximum number of `balanceOf` calls to issue. */
const MAX_HOLDER_CANDIDATES = 150;
/** Total wall-clock budget for holder discovery before we give up. */
const HOLDER_DISCOVERY_TIMEOUT_MS = 10_000;
/** Concurrent `balanceOf` reads (only used if multicall is unavailable). */
const BALANCE_READ_CONCURRENCY = 10;

const ERC20_ABI = parseAbi([
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)',
]);

function isAddressLike(value: string): boolean {
    return ADDRESS_PATTERN.test(value);
}

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
 * Parse a timestamp coming from Turso.
 *
 * SQLite `CURRENT_TIMESTAMP` yields `"YYYY-MM-DD HH:MM:SS"` in UTC with no
 * timezone suffix, which `Date.parse` would otherwise read as local time.
 */
function parseSqliteTimestamp(value: unknown): number | null {
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== 'string' || value.trim().length === 0) return null;

    const raw = value.trim();
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
        ? `${raw.replace(' ', 'T')}Z`
        : raw;

    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
}

/** True when the cached row should be recomputed. */
function needsRefresh(result: CabalAnalysisResult): boolean {
    if (result.isDefault) return true;
    const analyzedAtMs = parseSqliteTimestamp(result.analyzedAt);
    if (analyzedAtMs === null) return true;
    return Date.now() - analyzedAtMs >= STALE_AFTER_MS;
}

/**
 * Collect candidate holder addresses from recent `Transfer` logs.
 *
 * Scans backwards in windows so a token with a long history still returns the
 * most recent activity first. Returns an empty array on any RPC failure.
 */
async function collectHolderCandidates(tokenAddress: Address): Promise<Address[]> {
    const candidates = new Set<string>();

    try {
        const latestBlock = await publicClient.getBlockNumber();
        let toBlock = latestBlock;
        let iterations = 0;

        while (
            toBlock > 0n &&
            candidates.size < MAX_HOLDER_CANDIDATES &&
            iterations < MAX_SCAN_ITERATIONS
        ) {
            iterations += 1;
            const fromBlock =
                toBlock > SCAN_BLOCK_WINDOW ? toBlock - SCAN_BLOCK_WINDOW : 0n;

            const logs = await publicClient.getLogs({
                address: tokenAddress,
                event: ERC20_ABI[0],
                fromBlock,
                toBlock,
            });

            // Newest logs first so the cap keeps the most relevant wallets.
            for (let i = logs.length - 1; i >= 0; i -= 1) {
                const log = logs[i];
                const from = log.args.from;
                const to = log.args.to;
                if (from) candidates.add(from.toLowerCase());
                if (to) candidates.add(to.toLowerCase());
                if (candidates.size >= MAX_HOLDER_CANDIDATES) break;
            }

            if (logs.length >= MAX_TRANSFER_LOGS) break;
            if (fromBlock === 0n) break;
            toBlock = fromBlock - 1n;
        }
    } catch (error) {
        console.warn(
            `[cabal] Transfer log scan failed for ${tokenAddress}: ${errorMessage(error)}`
        );
    }

    return [...candidates] as Address[];
}

/**
 * Read `balanceOf` for every candidate in ONE `eth_call` batch.
 *
 * The previous implementation issued up to 150 sequential `readContract`
 * calls (10 at a time), each with its own retry budget — easily minutes of
 * wall clock on a degraded RPC. `multicall` collapses that into a single
 * round-trip and `allowFailure` keeps individual reverts from sinking the
 * whole batch.
 */
async function readBalances(
    tokenAddress: Address,
    candidates: Address[]
): Promise<Map<string, bigint>> {
    const balances = new Map<string, bigint>();
    if (candidates.length === 0) return balances;

    try {
        const results = await publicClient.multicall({
            contracts: candidates.map((owner) => ({
                address: tokenAddress,
                abi: ERC20_ABI,
                functionName: 'balanceOf' as const,
                args: [owner] as const,
            })),
            allowFailure: true,
        });

        results.forEach((outcome, index) => {
            if (outcome.status === 'success') {
                balances.set(
                    candidates[index].toLowerCase(),
                    outcome.result as bigint
                );
            }
        });

        return balances;
    } catch (error) {
        console.warn(
            `[cabal] multicall balanceOf failed for ${tokenAddress}: ${errorMessage(error)}`
        );
    }

    // Fallback: bounded concurrent reads, only if the batch call itself failed
    // (e.g. the RPC does not expose `eth_call` batching).
    for (let i = 0; i < candidates.length; i += BALANCE_READ_CONCURRENCY) {
        const batch = candidates.slice(i, i + BALANCE_READ_CONCURRENCY);
        const settled = await Promise.allSettled(
            batch.map((owner) =>
                publicClient.readContract({
                    address: tokenAddress,
                    abi: ERC20_ABI,
                    functionName: 'balanceOf',
                    args: [owner],
                })
            )
        );

        settled.forEach((outcome, index) => {
            if (outcome.status === 'fulfilled') {
                balances.set(batch[index].toLowerCase(), outcome.value as bigint);
            }
        });
    }

    return balances;
}

/**
 * Run a single contract read, converting any revert / RPC failure into a
 * `null` result instead of a thrown error.
 */
async function safeRead<T>(
    label: string,
    read: () => Promise<T>
): Promise<T | null> {
    try {
        return await read();
    } catch (error) {
        console.warn(`[cabal] ${label} failed: ${errorMessage(error)}`);
        return null;
    }
}

/** Outcome of holder discovery — distinguishes "no holders" from "unreadable". */
interface HolderDiscovery {
    holders: HolderData[];
    /** Non-empty when the token could not be read at all. */
    warnings: string[];
}

/**
 * Reconstruct the holder set for a token from on-chain data.
 *
 * `totalSupply()` is the gate for the whole calculation: without it no balance
 * can be expressed as a percentage. It is therefore read through `safeRead`
 * and a failure is reported as an explicit warning rather than being folded
 * into an empty holder list (which would masquerade as a clean LOW verdict).
 */
async function fetchTopHolders(tokenAddress: string): Promise<HolderDiscovery> {
    const address = tokenAddress as Address;

    const totalSupply = await safeRead('totalSupply', () =>
        publicClient.readContract({
            address,
            abi: ERC20_ABI,
            functionName: 'totalSupply',
        })
    );

    if (totalSupply === null) {
        return {
            holders: [],
            warnings: [
                'totalSupply() reverted or was unreadable; the token may not be a standard ERC-20.',
            ],
        };
    }

    if (totalSupply <= 0n) {
        return {
            holders: [],
            warnings: ['totalSupply() returned 0; supply-based analysis is impossible.'],
        };
    }

    const candidates = await collectHolderCandidates(address);
    if (candidates.length === 0) {
        return {
            holders: [],
            warnings: ['No Transfer logs found in the scanned block window.'],
        };
    }

    const balances = await readBalances(address, candidates);

    const holders: HolderData[] = [];
    for (const [holder, balance] of balances) {
        if (balance <= 0n) continue;
        // basis points of supply, then to percent with 4 decimals.
        const balancePct = (Number(balance) / Number(totalSupply)) * 100;
        if (!Number.isFinite(balancePct) || balancePct <= 0) continue;
        holders.push({ address: holder, balancePct });
    }

    holders.sort((a, b) => b.balancePct - a.balancePct);

    if (holders.length === 0) {
        return {
            holders: [],
            warnings: ['All candidate balances read as zero.'],
        };
    }

    return { holders, warnings: [] };
}

/**
 * Races `promise` against a wall-clock deadline. Resolves to `null` when the
 * deadline wins, so callers can substitute fallback data instead of hanging.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(null);
            }
        );
    });
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

        // Cached read is best-effort: a Turso outage degrades to the default.
        let result = await getCabalAnalysis(tokenAddress);

        if (needsRefresh(result)) {
            // Hard 10s ceiling on the entire on-chain discovery phase. Without
            // it a slow RPC kept the request open indefinitely and the Cabal
            // panel never left "Syncing...".
            const discovery = await withDeadline(
                fetchTopHolders(tokenAddress),
                HOLDER_DISCOVERY_TIMEOUT_MS
            );

            if (discovery === null) {
                console.warn(
                    `[cabal] Holder discovery exceeded ${HOLDER_DISCOVERY_TIMEOUT_MS}ms for ${tokenAddress}`
                );
                // Return immediately with an explicit unavailable payload. Not
                // persisted, so the next request retries cleanly.
                return NextResponse.json({
                    success: true,
                    data: unavailableCabalAnalysis(tokenAddress, [
                        `Holder discovery timed out after ${HOLDER_DISCOVERY_TIMEOUT_MS / 1000}s.`,
                    ]),
                });
            }

            if (discovery.warnings.length > 0) {
                // Unreadable token: return an explicit unavailable state. Do
                // NOT persist it — a transient RPC failure must not poison the
                // cache with a permanent "no holders" row.
                console.warn(
                    `[cabal] Analysis unavailable for ${tokenAddress}: ${discovery.warnings.join(' ')}`
                );
                result = unavailableCabalAnalysis(tokenAddress, discovery.warnings);
            } else {
                result = await scoreAndPersistCabal(tokenAddress, discovery.holders);
            }
        }

        return NextResponse.json({ success: true, data: result });
    } catch (error) {
        console.error(`[cabal] GET failed: ${errorMessage(error)}`);
        return NextResponse.json(ERROR_RESPONSE, { status: 500 });
    }
}
