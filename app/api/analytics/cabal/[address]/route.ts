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
import {
    createPublicClient,
    fallback,
    http,
    parseAbi,
    type Address,
} from 'viem';

import {
    getCabalAnalysis,
    scoreAndPersistCabal,
    unavailableCabalAnalysis,
    type CabalAnalysisResult,
    type HolderData,
} from '@/lib/analytics/cabalDetector';
import { robinhoodTestnet } from '@/lib/analytics/securitySimulator';
import { getDb } from '@/lib/db';

/**
 * Dedicated RPC client for holder discovery.
 *
 * The shared `publicClient` in `securitySimulator.ts` is tuned for background
 * indexing: `fallback` transport, `timeout: 20000`, `retryCount: 5`. Reusing it
 * here was the root cause of every "Holder discovery timed out after 7s"
 * response — a single stalled `eth_call` was silently retried for far longer
 * than the discovery budget, so the deadline always won and the route never
 * produced a single phase timing.
 *
 * Holder discovery is latency-bound and user-facing, so it needs the opposite
 * policy: fail fast, retry once, and let the route's own deadline decide.
 */
const CABAL_RPC_URL =
    process.env.PRIMARY_RPC_URL || 'https://rpc.testnet.chain.robinhood.com';
const CABAL_RPC_FALLBACK_URL = process.env.SECONDARY_RPC_URL;

/**
 * The public RPC rate-limits Cloudflare's shared egress IPs aggressively
 * (`429 Rate Limit Hit, limit will reset in 60 seconds`), which surfaced as an
 * instant "RPC Request failed" rather than a timeout.
 *
 * A `fallback` transport does NOT rescue this: viem treats a JSON-RPC error
 * object as a *successful* HTTP response, so the 429 never triggers failover.
 * The only reliable mitigation is to retry the call against the other endpoint,
 * which is what `withRpcRetry` below does.
 */
const cabalTransports = [
    http(CABAL_RPC_URL, { timeout: 8_000, retryCount: 1, retryDelay: 250 }),
    ...(CABAL_RPC_FALLBACK_URL
        ? [
              http(CABAL_RPC_FALLBACK_URL, {
                  timeout: 8_000,
                  retryCount: 1,
                  retryDelay: 250,
              }),
          ]
        : []),
];

const publicClient = createPublicClient({
    chain: robinhoodTestnet,
    transport:
        cabalTransports.length > 1
            ? fallback(cabalTransports, { rank: false, retryCount: 0 })
            : cabalTransports[0],
});

/**
 * Secondary client used to escape a rate-limited primary endpoint.
 *
 * Only constructed when a distinct secondary URL is configured; otherwise
 * `withRpcRetry` degrades to a plain backoff retry on the primary.
 */
const secondaryClient =
    CABAL_RPC_FALLBACK_URL && CABAL_RPC_FALLBACK_URL !== CABAL_RPC_URL
        ? createPublicClient({
              chain: robinhoodTestnet,
              transport: http(CABAL_RPC_FALLBACK_URL, {
                  timeout: 8_000,
                  retryCount: 0,
              }),
          })
        : null;

/** Detect the RPC's rate-limit / transient transport failures. */
function isRetryableRpcError(error: unknown): boolean {
    const message = errorMessage(error).toLowerCase();
    return (
        message.includes('rate limit') ||
        message.includes('429') ||
        message.includes('request failed') ||
        message.includes('timed out') ||
        message.includes('timeout') ||
        message.includes('fetch failed') ||
        message.includes('econnreset') ||
        message.includes('socket hang up')
    );
}

/**
 * Run an RPC read, retrying on rate-limit / transport errors.
 *
 * Attempt 1 hits the primary, attempt 2 the secondary (if configured), and any
 * further attempts alternate. Backoff is short because the whole discovery
 * phase shares a 10s wall-clock budget.
 */
async function withRpcRetry<T>(
    label: string,
    read: (client: typeof publicClient) => Promise<T>,
    attempts = 3
): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const client =
            attempt % 2 === 1 && secondaryClient ? secondaryClient : publicClient;

        try {
            return await read(client as typeof publicClient);
        } catch (error) {
            lastError = error;
            if (!isRetryableRpcError(error) || attempt === attempts - 1) break;

            const delay = 200 * (attempt + 1);
            console.warn(
                `[cabal] ${label} attempt ${attempt + 1} failed (${errorMessage(error)}); retrying in ${delay}ms`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}

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
/**
 * Hard cap on backward scan iterations, independent of the log budget.
 *
 * A single 10k-block window at the chain head is frequently EMPTY: launchpad
 * tokens mint and trade once, then go quiet, so their only `Transfer` logs sit
 * tens of thousands of blocks behind the head. Stopping after one window
 * therefore reported "No Transfer logs found" for every real token.
 *
 * We now walk backwards until logs are found or the iteration cap is hit. Each
 * window is one `eth_getLogs` round-trip (~400ms measured), so 8 windows cost
 * roughly 3s — still inside the 7s discovery budget, and the loop exits early
 * as soon as a window returns results.
 */
const MAX_SCAN_ITERATIONS = 8;
/**
 * Stop scanning once this many logs have been collected, even if the window
 * cap has not been reached. Prevents a very active token from burning the
 * whole budget on log retrieval.
 */
const SCAN_LOG_TARGET = 200;
/** Maximum number of `Transfer` logs to inspect. */
const MAX_TRANSFER_LOGS = 2_000;
/** Maximum number of `balanceOf` calls to issue. */
const MAX_HOLDER_CANDIDATES = 150;
/**
 * Total wall-clock budget for holder discovery before we give up.
 *
 * Kept BELOW the client-side analytics timeout (12s in app/page.tsx) so the
 * server always resolves with an explicit `unavailable` payload instead of the
 * browser aborting mid-flight and silently falling back to the static graph.
 *
 * 10s (not 7s) because the Worker's egress to the public RPC is measurably
 * slower than a local connection: a single `eth_call` that takes ~0.9s locally
 * can take several seconds from the edge. The transport timeout is 8s, so this
 * budget still leaves room for the route to serialise a response.
 */
const HOLDER_DISCOVERY_TIMEOUT_MS = 10_000;
/**
 * Concurrent `balanceOf` reads per chunk.
 *
 * Robinhood Chain Testnet has no Multicall3 deployment, so `publicClient.multicall`
 * throws `ChainDoesNotSupportContract` immediately. We therefore read balances
 * with plain `eth_call`s, but in bounded parallel chunks: 20 concurrent reads
 * per chunk keeps the RPC happy while still finishing 150 holders in ~8
 * round-trips instead of 150 sequential ones.
 */
const BALANCE_READ_CHUNK_SIZE = 10;
/**
 * How many holders to trace for gas funding.
 *
 * Each trace is one explorer round trip, so this is deliberately small: only
 * the top wallets can meaningfully change the concentration figure, and a wide
 * trace would blow the discovery budget.
 */
const MAX_FUNDER_TRACES = 12;
/** Concurrent explorer requests per funder-trace batch. */
const FUNDER_TRACE_BATCH_SIZE = 4;
/**
 * Wall-clock budget for the gas-funding trace, measured from the start of
 * holder discovery.
 *
 * This is deliberately separate from `HOLDER_DISCOVERY_TIMEOUT_MS`: supply and
 * holder reads routinely consume 7-8s of the 10s budget on the Worker's egress,
 * which previously left the trace with ~0ms and it always timed out. The trace
 * is an enrichment step, so it gets its own slice and is allowed to finish
 * slightly after the holder list is ready.
 */
const FUNDER_TRACE_BUDGET_MS = 6_000;
/**
 * Concurrent `eth_getCode` probes per chunk.
 *
 * Every candidate must be checked for bytecode before it can be treated as a
 * holder: AMM pairs, bonding curves, routers and the factory all appear as
 * `Transfer` participants and would otherwise be scored as insider whales.
 *
 * Kept small (5) because the public RPC rate-limits Cloudflare's egress IPs:
 * a burst of 20 `eth_getCode` calls is enough to trigger a 429 that then
 * poisons every subsequent call in the same request.
 */
const BYTECODE_CHECK_CHUNK_SIZE = 5;
/**
 * Maximum number of `eth_getCode` probes per request.
 *
 * The static exclusion list plus the per-token `amm_address` already remove
 * the protocol contracts we know about. Probing is a safety net for unknown
 * contracts, so a bounded sample is enough — and it keeps the request inside
 * the RPC's rate-limit budget.
 */
const MAX_BYTECODE_PROBES = 25;
/**
 * Wall-clock cap for the `eth_getCode` probe phase.
 *
 * Holder discovery has a 7s ceiling; reserving ~2.5s for bytecode checks
 * leaves the remainder for `balanceOf` reads, which are what actually produce
 * the percentages.
 */
const BYTECODE_CHECK_BUDGET_MS = 2_500;

/**
 * Addresses that can never be "insider wallets", regardless of balance.
 *
 * The AMM / bonding-curve address is resolved per-token from `launches` and
 * added at runtime; the rest are protocol-wide constants.
 */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';
/** VibeVibe launch factory (see securitySimulator.FACTORY_ADDRESS). */
const FACTORY_ADDRESS = '0xe794217880011f9cA6961340eD5c16EC9559Fea0';
/** Zap router used by the launchpad to seed liquidity. */
const ZAP_ROUTER_ADDRESS = '0x2784448c519D01d3aE257C0aac0b7cDAd8AccEB1';

/** Static protocol contracts excluded from every holder set. */
const STATIC_EXCLUSIONS: ReadonlySet<string> = new Set([
    ZERO_ADDRESS,
    DEAD_ADDRESS,
    FACTORY_ADDRESS.toLowerCase(),
    ZAP_ROUTER_ADDRESS.toLowerCase(),
]);

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
async function collectHolderCandidates(
    tokenAddress: Address,
    deadline: number
): Promise<Address[]> {
    const candidates = new Set<string>();
    let logsSeen = 0;

    try {
        const latestBlock = await withRpcRetry('getBlockNumber', (client) =>
            client.getBlockNumber()
        );
        let toBlock = latestBlock;
        let iterations = 0;

        while (
            toBlock > 0n &&
            candidates.size < MAX_HOLDER_CANDIDATES &&
            logsSeen < SCAN_LOG_TARGET &&
            iterations < MAX_SCAN_ITERATIONS &&
            Date.now() < deadline
        ) {
            iterations += 1;
            const fromBlock =
                toBlock > SCAN_BLOCK_WINDOW ? toBlock - SCAN_BLOCK_WINDOW : 0n;

            const logs = await withRpcRetry(`getLogs(${iterations})`, (client) =>
                client.getLogs({
                    address: tokenAddress,
                    event: ERC20_ABI[0],
                    fromBlock,
                    toBlock,
                })
            );

            logsSeen += logs.length;

            // Newest logs first so the cap keeps the most relevant wallets.
            for (let i = logs.length - 1; i >= 0; i -= 1) {
                const log = logs[i];
                const from = log.args.from;
                const to = log.args.to;
                if (from) candidates.add(from.toLowerCase());
                if (to) candidates.add(to.toLowerCase());
                if (candidates.size >= MAX_HOLDER_CANDIDATES) break;
            }

            // A window with results means we have reached the token's active
            // period; older windows only add stale participants.
            if (logs.length > 0) break;
            if (logsSeen >= MAX_TRANSFER_LOGS) break;
            if (fromBlock === 0n) break;
            toBlock = fromBlock - 1n;
        }

        console.log(
            `[cabal] ${tokenAddress} scanned ${iterations} window(s), ${logsSeen} log(s), ${candidates.size} candidate(s)`
        );
    } catch (error) {
        console.warn(
            `[cabal] Transfer log scan failed for ${tokenAddress}: ${errorMessage(error)}`
        );
    }

    return [...candidates] as Address[];
}

/**
 * Read `balanceOf` for every candidate using chunked parallel `eth_call`s.
 *
 * `publicClient.multicall` is NOT usable here: Robinhood Chain Testnet has no
 * Multicall3 deployment, so viem throws `ChainDoesNotSupportContract` before
 * any request is made. The old code caught that and fell back to a slow
 * sequential loop, which routinely blew the 10s discovery budget.
 *
 * Instead we split the candidates into chunks of `BALANCE_READ_CHUNK_SIZE`
 * (20) and process the chunks sequentially, issuing the reads *inside* each
 * chunk concurrently with `Promise.all`. Individual failures are caught and
 * treated as `0n` so one bad `eth_call` cannot sink the whole chunk.
 */
async function readBalances(
    tokenAddress: Address,
    candidates: Address[],
    errors?: string[]
): Promise<Map<string, bigint>> {
    const balances = new Map<string, bigint>();
    if (candidates.length === 0) return balances;

    for (let i = 0; i < candidates.length; i += BALANCE_READ_CHUNK_SIZE) {
        const chunk = candidates.slice(i, i + BALANCE_READ_CHUNK_SIZE);

        const results = await Promise.all(
            chunk.map(async (owner) => {
                try {
                    const value = (await withRpcRetry(
                        `balanceOf(${owner})`,
                        (client) =>
                            client.readContract({
                                address: tokenAddress,
                                abi: ERC20_ABI,
                                functionName: 'balanceOf',
                                args: [owner],
                            }),
                        2
                    )) as bigint;
                    return value;
                } catch (error) {
                    // A single revert / RPC hiccup must not kill the chunk.
                    const message = errorMessage(error);
                    console.warn(
                        `[cabal] balanceOf failed for ${owner} on ${tokenAddress}: ${message}`
                    );
                    if (errors) errors.push(`${owner}: ${message}`);
                    return 0n;
                }
            })
        );

        results.forEach((value, index) => {
            balances.set(chunk[index].toLowerCase(), value);
        });
    }

    return balances;
}

/**
 * Resolve the token's AMM / bonding-curve address from the `launches` table.
 *
 * Returns `null` when the token is not indexed yet or Turso is unreachable —
 * the caller then relies on the static exclusion list plus the bytecode check.
 */
async function fetchAmmAddress(tokenAddress: string): Promise<string | null> {
    try {
        const res = await getDb().execute({
            sql: `SELECT amm_address FROM launches WHERE token_address = ? LIMIT 1`,
            args: [tokenAddress.toLowerCase()],
        });
        const raw = res.rows[0]?.amm_address;
        if (typeof raw !== 'string') return null;
        const normalized = raw.trim().toLowerCase();
        if (!ADDRESS_PATTERN.test(normalized)) return null;
        if (normalized === ZERO_ADDRESS) return null;
        return normalized;
    } catch (error) {
        console.warn(
            `[cabal] amm_address lookup failed for ${tokenAddress}: ${errorMessage(error)}`
        );
        return null;
    }
}

/**
 * Build the per-token exclusion set: static protocol contracts + the AMM.
 */
function buildExclusionSet(ammAddress: string | null): Set<string> {
    const excluded = new Set<string>(STATIC_EXCLUSIONS);
    if (ammAddress) excluded.add(ammAddress.toLowerCase());
    return excluded;
}

/**
 * Return the subset of `candidates` that are NOT smart contracts.
 *
 * A wallet that holds token supply but has deployed bytecode is a pool,
 * curve, router or vault — never an insider. Probes run in bounded parallel
 * chunks; a failed `eth_getCode` is treated as "has code" (conservative: we
 * would rather drop a real holder than inflate the cabal percentage).
 *
 * `deadline` caps the total time spent probing. Once it passes, the remaining
 * candidates are kept as-is: the static exclusion list has already removed the
 * known protocol addresses, so an unprobed wallet is a far smaller risk than
 * starving the `balanceOf` phase and returning nothing at all.
 */
async function filterContracts(
    candidates: Address[],
    deadline: number
): Promise<Address[]> {
    const externallyOwned: Address[] = [];
    let probes = 0;

    for (let i = 0; i < candidates.length; i += BYTECODE_CHECK_CHUNK_SIZE) {
        if (Date.now() >= deadline) {
            console.warn(
                `[cabal] getBytecode budget exhausted; keeping ${candidates.length - i} unprobed candidate(s)`
            );
            externallyOwned.push(...candidates.slice(i));
            break;
        }

        // Each probe is a separate `eth_getCode` round trip. Cap the total so a
        // wide candidate set cannot monopolise the discovery budget; anything
        // past the cap is kept (the static exclusion list already removed the
        // known protocol addresses).
        if (probes >= MAX_BYTECODE_PROBES) {
            console.warn(
                `[cabal] getBytecode probe cap (${MAX_BYTECODE_PROBES}) reached; keeping ${candidates.length - i} unprobed candidate(s)`
            );
            externallyOwned.push(...candidates.slice(i));
            break;
        }
        probes += Math.min(BYTECODE_CHECK_CHUNK_SIZE, candidates.length - i);

        const chunk = candidates.slice(i, i + BYTECODE_CHECK_CHUNK_SIZE);

        const results = await Promise.all(
            chunk.map(async (address) => {
                try {
                    const code = await withRpcRetry(
                        `getBytecode(${address})`,
                        (client) => client.getBytecode({ address }),
                        2
                    );
                    // `undefined` means "no account" — treat as an EOA.
                    const hasCode =
                        typeof code === 'string' &&
                        code.length > 2 &&
                        code !== '0x';
                    return { address, hasCode };
                } catch (error) {
                    console.warn(
                        `[cabal] getBytecode failed for ${address}: ${errorMessage(error)}`
                    );
                    return { address, hasCode: true };
                }
            })
        );

        for (const { address, hasCode } of results) {
            if (!hasCode) externallyOwned.push(address);
        }
    }

    return externallyOwned;
}

/** Outcome of holder discovery — distinguishes "no holders" from "unreadable". */
interface HolderDiscovery {
    holders: HolderData[];
    /** Non-empty when the token could not be read at all. */
    warnings: string[];
    /** Phase timings, only populated when `debug` is requested. */
    timings?: Record<string, number>;
}

/** Base URL of the chain explorer's REST API. */
const EXPLORER_API_BASE = 'https://explorer.testnet.chain.robinhood.com/api/v2';

/** One entry of `GET /api/v2/tokens/:address/holders`. */
interface ExplorerHolder {
    address?: {
        hash?: string;
        is_contract?: boolean;
        is_smart_contract?: boolean;
    };
    value?: string;
}

interface ExplorerHoldersResponse {
    items?: ExplorerHolder[];
    next_page_params?: Record<string, unknown> | null;
}

/**
 * Read `totalSupply` from the explorer's token index.
 *
 * Same rationale as `fetchHoldersFromExplorer`: the RPC is rate-limited for
 * Cloudflare's shared egress IPs, and supply is the gate for the entire
 * percentage calculation, so it must not be the single point of failure.
 *
 * Returns `null` when the explorer is unreachable or reports no supply.
 */
async function fetchSupplyFromExplorer(
    tokenAddress: string
): Promise<bigint | null> {
    try {
        const res = await fetch(`${EXPLORER_API_BASE}/tokens/${tokenAddress}`, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(6_000),
        });
        if (!res.ok) return null;

        const payload = (await res.json()) as { total_supply?: string | null };
        if (typeof payload.total_supply !== 'string') return null;

        const supply = BigInt(payload.total_supply);
        return supply > 0n ? supply : null;
    } catch (error) {
        console.warn(
            `[cabal] explorer supply failed for ${tokenAddress}: ${errorMessage(error)}`
        );
        return null;
    }
}

/**
 * Discover holders from the chain explorer instead of the JSON-RPC endpoint.
 *
 * This is the primary source because the public RPC rate-limits Cloudflare's
 * shared egress IPs (`429 Rate Limit Hit, limit will reset in 60 seconds`) and
 * `SECONDARY_RPC_URL` points at the *same* host, so there is no failover to
 * escape to. The explorer is a different origin, is not rate-limited for the
 * Worker, and — critically — already reports `is_contract` per holder, which
 * removes the need for the `eth_getCode` probe entirely.
 *
 * Returns `null` when the explorer is unreachable so the caller can fall back
 * to the on-chain path.
 */
async function fetchHoldersFromExplorer(
    tokenAddress: string,
    totalSupply: bigint,
    ammAddress: string | null
): Promise<HolderData[] | null> {
    const url = `${EXPLORER_API_BASE}/tokens/${tokenAddress}/holders`;

    let payload: ExplorerHoldersResponse;
    try {
        const res = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(6_000),
        });
        if (!res.ok) {
            console.warn(
                `[cabal] explorer holders ${res.status} for ${tokenAddress}`
            );
            return null;
        }
        payload = (await res.json()) as ExplorerHoldersResponse;
    } catch (error) {
        console.warn(
            `[cabal] explorer holders failed for ${tokenAddress}: ${errorMessage(error)}`
        );
        return null;
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    if (items.length === 0) return null;

    const exclusions = buildExclusionSet(ammAddress);
    const holders: HolderData[] = [];

    for (const item of items) {
        const raw = item.address?.hash;
        if (typeof raw !== 'string') continue;

        const owner = raw.toLowerCase();
        if (!ADDRESS_PATTERN.test(owner)) continue;
        if (exclusions.has(owner)) continue;

        // The explorer flags both AMM pools and any other deployed contract.
        // Excluding them is the whole point of this audit: a pool holding the
        // unsold curve supply must never be counted as insider concentration.
        if (item.address?.is_contract === true) continue;
        if (item.address?.is_smart_contract === true) continue;

        let balance: bigint;
        try {
            balance = BigInt(item.value ?? '0');
        } catch {
            continue;
        }
        if (balance <= 0n) continue;

        // Integer ratio first, then a single float division: avoids the
        // precision loss of `Number(balance) / Number(totalSupply)` on
        // 18-decimal supplies.
        const balancePct = Number((balance * 10_000n) / totalSupply) / 100;

        holders.push({ address: owner, balancePct });
    }

    // Largest first so the whale rule and the graph both see the top wallets.
    holders.sort((a, b) => b.balancePct - a.balancePct);
    return holders;
}

/** One entry of `GET /api/v2/addresses/:address/transactions`. */
interface ExplorerTransaction {
    from?: { hash?: string; is_contract?: boolean };
    to?: { hash?: string };
    value?: string;
    timestamp?: string;
    transaction_types?: string[];
}

interface ExplorerTransactionsResponse {
    items?: ExplorerTransaction[];
}

/**
 * Addresses that fund thousands of wallets and therefore say nothing about
 * common ownership. A wallet whose gas came from one of these is treated as
 * unfunded rather than clustered with every other user of the same service.
 */
const FUNDER_IGNORE_LIST = new Set<string>([
    ZERO_ADDRESS,
    DEAD_ADDRESS,
    FACTORY_ADDRESS.toLowerCase(),
    ZAP_ROUTER_ADDRESS.toLowerCase(),
]);

/**
 * Resolve the wallet that paid a holder's gas.
 *
 * The first native transfer *into* a fresh wallet is the canonical funding
 * signal: whoever sent it had to know the address before it existed, which is
 * the strongest cheap proxy for common control available without a full
 * transaction-graph crawl.
 *
 * Returns `null` when the wallet has no incoming native transfer, when the
 * sender is a contract (faucet, bridge, dispenser) or on the ignore list, or
 * when the explorer call fails. A `null` funder simply means "not clustered by
 * funding" — the whale rule still applies.
 */
async function fetchFunderAddress(
    wallet: string,
    ammAddress: string | null
): Promise<string | null> {
    const normalized = wallet.toLowerCase();
    if (FUNDER_IGNORE_LIST.has(normalized)) return null;
    if (ammAddress && normalized === ammAddress) return null;

    try {
        const res = await fetch(
            `${EXPLORER_API_BASE}/addresses/${wallet}/transactions?filter=to`,
            {
                headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(5_000),
            }
        );
        if (!res.ok) return null;

        const payload = (await res.json()) as ExplorerTransactionsResponse;
        const items = Array.isArray(payload.items) ? payload.items : [];

        // The API returns newest-first; the funding transaction is the oldest
        // incoming native transfer, so walk backwards and keep the last match.
        let funder: string | null = null;
        for (const tx of items) {
            const from = tx.from?.hash;
            if (typeof from !== 'string') continue;
            if (!ADDRESS_PATTERN.test(from)) continue;

            // Only native-value transfers count as gas funding; token moves
            // are trading activity, not wallet creation.
            let value = 0n;
            try {
                value = BigInt(tx.value ?? '0');
            } catch {
                continue;
            }
            if (value <= 0n) continue;

            // A contract sender is a faucet / bridge / dispenser, not an
            // operator-controlled wallet.
            if (tx.from?.is_contract === true) continue;

            const candidate = from.toLowerCase();
            if (FUNDER_IGNORE_LIST.has(candidate)) continue;
            if (ammAddress && candidate === ammAddress) continue;
            if (candidate === normalized) continue;

            funder = candidate;
        }

        return funder;
    } catch (error) {
        console.warn(
            `[cabal] funder trace failed for ${wallet}: ${errorMessage(error)}`
        );
        return null;
    }
}

/**
 * Find funding links *between* the analysed holders.
 *
 * This is the strongest signal available: if holder A sent native value to
 * holder B, the two are directly connected and no inference is needed. It also
 * catches the case the oldest-incoming heuristic misses — two wallets that
 * funded each other, where each one's "first funder" is the other and the
 * self-reference guard would otherwise discard both.
 *
 * Returns a map of funded wallet -> funder wallet, restricted to pairs where
 * both ends are holders of this token.
 */
async function findInternalFundingLinks(
    holders: HolderData[],
    ammAddress: string | null,
    deadline: number
): Promise<Map<string, string>> {
    const links = new Map<string, string>();
    const holderSet = new Set(holders.map((h) => h.address.toLowerCase()));
    const targets = holders.slice(0, MAX_FUNDER_TRACES);

    for (let i = 0; i < targets.length; i += FUNDER_TRACE_BATCH_SIZE) {
        if (Date.now() >= deadline) break;

        const batch = targets.slice(i, i + FUNDER_TRACE_BATCH_SIZE);
        const results = await Promise.all(
            batch.map(async (holder) => ({
                address: holder.address.toLowerCase(),
                senders: await fetchIncomingSenders(holder.address, ammAddress),
            }))
        );

        for (const { address, senders } of results) {
            for (const sender of senders) {
                // Only a link between two holders of this token is evidence of
                // a coordinated position; an outside funder is handled by the
                // shared-funder grouping instead.
                if (sender === address) continue;
                if (!holderSet.has(sender)) continue;
                links.set(address, sender);
                break;
            }
        }
    }

    return links;
}

/**
 * Every distinct externally-owned address that sent native value to `wallet`.
 *
 * Used by the internal-link pass, which needs the full sender set rather than
 * just the oldest one.
 *
 * NOTE: this explorer rejects the `page` query parameter outright — adding it
 * returns an empty `items` array even for wallets with hundreds of transfers.
 * The endpoint must therefore be called unpaginated; it returns a bounded
 * recent window, which is sufficient because a funding link between two
 * holders is almost always within that window.
 */
async function fetchIncomingSenders(
    wallet: string,
    ammAddress: string | null
): Promise<string[]> {
    const normalized = wallet.toLowerCase();
    if (FUNDER_IGNORE_LIST.has(normalized)) return [];

    const senders = new Set<string>();

    try {
        const res = await fetch(
            `${EXPLORER_API_BASE}/addresses/${wallet}/transactions?filter=to`,
            {
                headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(5_000),
            }
        );
        if (!res.ok) return [];

        const payload = (await res.json()) as ExplorerTransactionsResponse;
        const items = Array.isArray(payload.items) ? payload.items : [];

        for (const tx of items) {
            const from = tx.from?.hash;
            if (typeof from !== 'string') continue;
            if (!ADDRESS_PATTERN.test(from)) continue;
            if (tx.from?.is_contract === true) continue;

            let value = 0n;
            try {
                value = BigInt(tx.value ?? '0');
            } catch {
                continue;
            }
            if (value <= 0n) continue;

            const candidate = from.toLowerCase();
            if (FUNDER_IGNORE_LIST.has(candidate)) continue;
            if (ammAddress && candidate === ammAddress) continue;

            senders.add(candidate);
        }

        return [...senders];
    } catch (error) {
        console.warn(
            `[cabal] sender scan failed for ${wallet}: ${errorMessage(error)}`
        );
        return senders.size > 0 ? [...senders] : [];
    }
}

/**
 * Attach `funderAddress` to each holder by tracing its gas funding.
 *
 * Runs concurrently but bounded: only the top `MAX_FUNDER_TRACES` holders are
 * traced (the ones that can actually move the concentration number), in
 * batches, and the whole phase is capped by `deadline`. Untraced holders keep
 * `funderAddress` undefined, which the detector treats as "no funding link".
 *
 * Two passes, in priority order:
 *   1. Funding links between holders — a direct A -> B transfer.
 *   2. The oldest external funder — a shared operator wallet.
 * Pass 1 wins because it is observed rather than inferred.
 */
async function attachFunderAddresses(
    holders: HolderData[],
    ammAddress: string | null,
    deadline: number
): Promise<HolderData[]> {
    const targets = holders.slice(0, MAX_FUNDER_TRACES);
    if (targets.length === 0) return holders;

    const funderByWallet = new Map<string, string>();

    // --- Pass 1: holder-to-holder funding ---------------------------------
    const internalLinks = await findInternalFundingLinks(
        holders,
        ammAddress,
        deadline
    );
    for (const [funded, funder] of internalLinks) {
        funderByWallet.set(funded, funder);
    }

    // --- Pass 2: oldest external funder -----------------------------------
    for (let i = 0; i < targets.length; i += FUNDER_TRACE_BATCH_SIZE) {
        if (Date.now() >= deadline) {
            console.warn(
                `[cabal] funder trace budget exhausted; ${targets.length - i} wallet(s) left untraced`
            );
            break;
        }

        const batch = targets.slice(i, i + FUNDER_TRACE_BATCH_SIZE);
        const results = await Promise.all(
            batch.map(async (holder) => ({
                address: holder.address,
                funder: await fetchFunderAddress(holder.address, ammAddress),
            }))
        );

        for (const { address, funder } of results) {
            const key = address.toLowerCase();
            // A direct holder-to-holder link is stronger evidence than an
            // external funder, so never overwrite pass 1.
            if (funder && !funderByWallet.has(key)) {
                funderByWallet.set(key, funder);
            }
        }
    }

    return holders.map((holder) => {
        const funder = funderByWallet.get(holder.address.toLowerCase());
        return funder ? { ...holder, funderAddress: funder } : holder;
    });
}

/**
 * Reconstruct the holder set for a token from on-chain data.
 *
 * `totalSupply()` is the gate for the whole calculation: without it no balance
 * can be expressed as a percentage. It is therefore read through `safeRead`
 * and a failure is reported as an explicit warning rather than being folded
 * into an empty holder list (which would masquerade as a clean LOW verdict).
 */
async function fetchTopHolders(
    tokenAddress: string,
    debug = false
): Promise<HolderDiscovery> {
    const address = tokenAddress as Address;
    const t0 = Date.now();
    const timings: Record<string, number> = {};
    const mark = (phase: string) => {
        const elapsed = Date.now() - t0;
        timings[phase] = elapsed;
        console.log(`[cabal] ${tokenAddress} ${phase} @${elapsed}ms`);
    };

    // Every phase below is bounded by this absolute deadline. The route also
    // races the whole call against `HOLDER_DISCOVERY_TIMEOUT_MS`, but an inner
    // deadline lets us return *partial* results (and timings) instead of
    // nothing at all when one phase is slow.
    const deadline = t0 + HOLDER_DISCOVERY_TIMEOUT_MS - 500;

    // Supply is read from the explorer first: it is a different origin, so it
    // is unaffected by the RPC's shared-egress rate limit. The on-chain read is
    // kept as a fallback for tokens the explorer has not indexed yet.
    let totalSupplyError: string | null = null;
    const totalSupply = await withDeadline(
        (async () => {
            const fromExplorer = await fetchSupplyFromExplorer(tokenAddress);
            if (fromExplorer !== null) return fromExplorer;

            try {
                return (await withRpcRetry('totalSupply', (client) =>
                    client.readContract({
                        address,
                        abi: ERC20_ABI,
                        functionName: 'totalSupply',
                    })
                )) as bigint;
            } catch (error) {
                totalSupplyError = errorMessage(error);
                console.warn(
                    `[cabal] totalSupply failed for ${tokenAddress}: ${totalSupplyError}`
                );
                return null;
            }
        })(),
        Math.max(deadline - Date.now(), 500)
    );
    mark('totalSupply');

    if (totalSupply === null) {
        return {
            holders: [],
            warnings: [
                totalSupplyError
                    ? `totalSupply() failed: ${totalSupplyError}`
                    : 'totalSupply() timed out; the token may not be a standard ERC-20.',
            ],
            ...(debug ? { timings } : {}),
        };
    }

    if (totalSupply <= 0n) {
        return {
            holders: [],
            warnings: ['totalSupply() returned 0; supply-based analysis is impossible.'],
            ...(debug ? { timings } : {}),
        };
    }

    // --- Primary path: the explorer's holder index -------------------------
    // Preferred over on-chain reconstruction because it is a different origin
    // (immune to the RPC's shared-egress rate limit) and reports `is_contract`
    // per holder, so protocol pools are excluded without any `eth_getCode`.
    const ammForExplorer = await withDeadline(
        fetchAmmAddress(address),
        Math.max(deadline - Date.now(), 500)
    );
    mark(`ammLookup(${ammForExplorer ?? 'none'})`);

    const explorerHolders = await withDeadline(
        fetchHoldersFromExplorer(address, totalSupply, ammForExplorer),
        Math.max(deadline - Date.now(), 500)
    );
    mark(`explorer(${explorerHolders?.length ?? 'timeout'})`);

    if (explorerHolders && explorerHolders.length > 0) {
        // Trace gas funding so the detector can group wallets that share an
        // operator. This is what turns "several large holders" into a proven
        // cluster with FUNDED_BY edges.
        //
        // The trace gets its own budget anchored at `t0` rather than the shared
        // `deadline`: supply + holder reads already consume most of the
        // discovery window, so reusing `deadline` left the trace with no time
        // and it timed out on every request.
        const funded = await withDeadline(
            attachFunderAddresses(
                explorerHolders,
                ammForExplorer,
                t0 + FUNDER_TRACE_BUDGET_MS
            ),
            FUNDER_TRACE_BUDGET_MS
        );
        mark(`funders(${funded?.filter((h) => h.funderAddress).length ?? 'timeout'})`);

        return {
            holders: funded ?? explorerHolders,
            warnings: [],
            ...(debug ? { timings } : {}),
        };
    }

    // --- Fallback: reconstruct holders from Transfer logs -------------------
    const rawCandidates = await withDeadline(
        collectHolderCandidates(address, deadline),
        Math.max(deadline - Date.now(), 500)
    );
    mark(`logScan(${rawCandidates?.length ?? 'timeout'})`);
    if (rawCandidates === null) {
        return {
            holders: [],
            warnings: ['Transfer log scan timed out.'],
            ...(debug ? { timings } : {}),
        };
    }
    if (rawCandidates.length === 0) {
        return {
            holders: [],
            warnings: ['No Transfer logs found in the scanned block window.'],
            ...(debug ? { timings } : {}),
        };
    }

    // --- Exclude protocol liquidity before any balance is scored -----------
    // 1. Static list (zero / dEaD / factory / router) + the token's AMM pair.
    const ammAddress = await withDeadline(
        fetchAmmAddress(address),
        Math.max(deadline - Date.now(), 500)
    );
    mark(`ammLookup(${ammAddress ?? 'none'})`);
    const excluded = buildExclusionSet(ammAddress);
    const nonProtocol = rawCandidates.filter(
        (candidate) => !excluded.has(candidate.toLowerCase())
    );

    // 2. Anything with deployed bytecode is a contract, not an insider wallet.
    //    Capped so the probe phase cannot consume the whole discovery budget.
    const bytecodeDeadline = Math.min(
        Date.now() + BYTECODE_CHECK_BUDGET_MS,
        deadline
    );
    const candidates = await filterContracts(nonProtocol, bytecodeDeadline);
    mark(`bytecode(${nonProtocol.length}->${candidates.length})`);

    if (candidates.length === 0) {
        return {
            holders: [],
            warnings: [
                'All Transfer participants were protocol contracts (AMM, curve, router or burn address).',
            ],
            ...(debug ? { timings } : {}),
        };
    }

    const balanceErrors: string[] = [];
    const balances = await withDeadline(
        readBalances(address, candidates, balanceErrors),
        Math.max(deadline - Date.now(), 500)
    );
    mark(`balances(${balances?.size ?? 'timeout'})`);

    if (balances === null) {
        return {
            holders: [],
            warnings: ['balanceOf reads timed out.'],
            ...(debug ? { timings } : {}),
        };
    }

    const holders: HolderData[] = [];
    for (const [holder, balance] of balances) {
        if (balance <= 0n) continue;
        // Bigint ratio first: `Number(balance) / Number(totalSupply)` loses
        // precision once an 18-decimal supply exceeds 2^53. Scaling by 10_000
        // keeps 2 decimal places of percent accuracy for any uint256 supply.
        const balancePct = Number((balance * 10_000n) / totalSupply) / 100;
        if (!Number.isFinite(balancePct) || balancePct <= 0) continue;
        holders.push({ address: holder, balancePct });
    }

    holders.sort((a, b) => b.balancePct - a.balancePct);

    if (holders.length === 0) {
        return {
            holders: [],
            warnings: [
                balanceErrors.length > 0
                    ? `All candidate balances read as zero (${balanceErrors.length} balanceOf call(s) failed: ${balanceErrors[0]}).`
                    : 'All candidate balances read as zero.',
            ],
            ...(debug ? { timings } : {}),
        };
    }

    return { holders, warnings: [], ...(debug ? { timings } : {}) };
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
    request: Request,
    { params }: { params: Promise<{ address: string }> }
) {
    try {
        const { address } = await params;
        const debug = new URL(request.url).searchParams.get('debug') === '1';

        if (!address || !isAddressLike(address)) {
            return NextResponse.json(
                { success: false, error: 'Invalid token address' },
                { status: 400 }
            );
        }

        const tokenAddress = address.toLowerCase();

        // Cached read is best-effort: a Turso outage degrades to the default.
        let result = await getCabalAnalysis(tokenAddress);
        let discoveryTimings: Record<string, number> | undefined;

        if (needsRefresh(result)) {
            // Hard ceiling on the entire on-chain discovery phase. Without it a
            // slow RPC kept the request open indefinitely and the Cabal panel
            // never left "Syncing...".
            //
            // `fetchTopHolders` enforces its own inner deadline and returns
            // partial phase timings, so reaching this branch means the RPC is
            // genuinely unreachable rather than merely slow.
            // The ceiling covers holder discovery plus the gas-funding trace,
            // which runs after the holder list is ready and has its own budget.
            const discoveryCeiling = HOLDER_DISCOVERY_TIMEOUT_MS + FUNDER_TRACE_BUDGET_MS;
            const discovery = await withDeadline(
                fetchTopHolders(tokenAddress, debug),
                discoveryCeiling
            );

            if (discovery === null) {
                console.warn(
                    `[cabal] Holder discovery exceeded ${discoveryCeiling}ms for ${tokenAddress}`
                );
                // Return immediately with an explicit unavailable payload. Not
                // persisted, so the next request retries cleanly.
                return NextResponse.json({
                    success: true,
                    data: unavailableCabalAnalysis(tokenAddress, [
                        `Holder discovery timed out after ${HOLDER_DISCOVERY_TIMEOUT_MS / 1000}s.`,
                    ]),
                    ...(debug ? { debug: { timedOut: true } } : {}),
                });
            }

            discoveryTimings = discovery.timings;

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

        return NextResponse.json({
            success: true,
            data: result,
            ...(debug ? { debug: { timings: discoveryTimings } } : {}),
        });
    } catch (error) {
        console.error(`[cabal] GET failed: ${errorMessage(error)}`);
        return NextResponse.json(ERROR_RESPONSE, { status: 500 });
    }
}
