import { createServer } from 'http';
import { config as loadEnv } from 'dotenv';
// Next.js keeps secrets in `.env.local`; the indexer runs outside Next, so load
// that first and fall back to `.env`. Without this the Supabase client gets no
// URL/key and the process dies on boot.
loadEnv({ path: '.env.local' });
loadEnv();
import {
    createPublicClient,
    http,
    fallback,
    defineChain,
    formatUnits,
    parseAbi,
    parseAbiItem,
    decodeEventLog,
    getAddress,
} from 'viem';
import { createClient } from '@libsql/client';

process.on('uncaughtException', (err) => {
    console.error('Unhandled Exception trapped:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection trapped:', reason);
});

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL!;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN!;

const db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

// ---------------------------------------------------------------------------
// Chain + contract addresses (verified against vibevibe.md, Robinhood Chain
// testnet, chain id 46630). Do not invent addresses.
// ---------------------------------------------------------------------------
const robinhoodTestnet = defineChain({
    id: 46630,
    name: 'Robinhood Chain Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
    blockExplorers: {
        default: { name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com' },
    },
    testnet: true,
});

// ---------------------------------------------------------------------------
// RPC TRANSPORT — resilient by design.
//
// The primary Robinhood testnet RPC intermittently throws
// `TimeoutError: The request took too long to respond` during eth_getLogs /
// watchEvent polling. We wrap it in an `http()` transport with an explicit
// timeout and retry budget, then layer a `fallback()` on top so viem
// automatically switches to a secondary RPC if the primary keeps failing.
//
// Set SECONDARY_RPC_URL (e.g. a Tatum/Alchemy endpoint) in `.env.local` to
// enable the backup. When unset, the fallback array simply contains the
// primary transport, which still benefits from the retry configuration.
// ---------------------------------------------------------------------------
const PRIMARY_RPC_URL =
    process.env.PRIMARY_RPC_URL || 'https://rpc.testnet.chain.robinhood.com';
const SECONDARY_RPC_URL = process.env.SECONDARY_RPC_URL;

const primaryTransport = http(PRIMARY_RPC_URL, {
    timeout: 20000, // 20 seconds
    retryCount: 5,
    retryDelay: 1000,
});

const rpcTransports = [
    primaryTransport,
    ...(SECONDARY_RPC_URL
        ? [
              http(SECONDARY_RPC_URL, {
                  timeout: 20000,
                  retryCount: 5,
                  retryDelay: 1000,
              }),
          ]
        : []),
];

const publicClient = createPublicClient({
    chain: robinhoodTestnet,
    transport: fallback(rpcTransports, {
        // Give the primary a fair shot before failing over, and rank by
        // latency so the fastest healthy RPC is preferred.
        rank: false,
        retryCount: 2,
    }),
});

const FACTORY_ADDRESS = '0xe794217880011f9cA6961340eD5c16EC9559Fea0' as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// Base URL for our own proxy route. Overridable via env so the indexer can
// point at localhost during development or the deployed app in production.
const PROXY_BASE_URL = process.env.PROXY_BASE_URL || 'https://vibe-signals.vercel.app';

// ---------------------------------------------------------------------------
// ABIs — taken verbatim from the verified contract spec (vibevibe.md §5).
// ---------------------------------------------------------------------------
const FACTORY_ABI = parseAbi([
    'function curveOf(address token) view returns (address)',
    'function isV6Token(address) view returns (bool)',
    'function launchCount() view returns (uint256)',
    'event LaunchCreated(uint256 indexed launchId, address indexed launcher, address indexed token, address curve, string name, string symbol, string metadataURI, address pairCurrency, uint16 taxBps, uint64 packedWeights, address projectTreasury, uint256 targetPairUnits, uint256 netPersonal, uint256 giftNetTotal, bytes32 giftRoot, uint256 giftCount)',
]);

const CURVE_ABI = parseAbi([
    'function token() view returns (address)',
    'function pairCurrency() view returns (address)',
    'function complete() view returns (bool)',
    'function sold() view returns (uint120)',
    'function targetPairUnits() view returns (uint256)',
    'function pairPrincipal() view returns (uint128)',
    'function currentRateBps() view returns (uint256)',
    'event CurveBuy(address indexed buyer, address indexed recipient, uint256 grossTokens, uint256 netTokens, uint256 tokenFee, uint256 pairCost, uint256 pairFee, uint256 rateBps)',
    'event CurveSell(address indexed seller, address indexed recipient, uint256 grossTokens, uint256 netTokens, uint256 tokenFee, uint256 pairProceeds, uint256 pairFee)',
]);

const TOKEN_ABI = parseAbi([
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function transfersUnlocked() view returns (bool)',
    'function baseTaxBps() view returns (uint256)',
]);

// Event topic hashes (keccak256 of the canonical signatures above). Used to
// filter raw logs before decoding.
const LAUNCH_CREATED_TOPIC = '0xa7e8032bfd07a9fbcde50eabe91eb2901faee6dbddd9cced579491d9b07ef5c8';
const CURVE_BUY_TOPIC = '0x55867fe9a84ea30ad247ef1bb703eba47fd9af476149002512a2814b1e3d8fb5';
const CURVE_SELL_TOPIC = '0x3899b2b9ba4dfe77b54ff5e6f921672b2a7563ade468f2a106b25a4b808d60de';

// The zap router is what the vibe/vibe website uses for non-ETH pairs and
// graduated tokens, so CurveBuy/CurveSell `buyer`/`seller` is often this
// address. The real wallet is then `recipient`. Never show the zap as a trader.
const ZAP_ROUTER = '0x2784448c519D01d3aE257C0aac0b7cDAd8AccEB1'.toLowerCase();

interface LiveApiMetrics {
    marketCapFormatted: string | null;
    volumeEth: number | null;
    hasSocials: boolean;
    pairSymbol: string | null;
    curveProgress: number | null;
    liquidityDeposited: number | null;
}

/**
 * Fetches REAL market data for a token from our `/api/proxyVibe` route and
 * extracts the values we persist back into Supabase. This is what makes the
 * database converge with the live API over time.
 *
 * Returns nulls for any field the API did not provide, so callers can avoid
 * clobbering existing values with undefined.
 */
async function fetchLiveApiMetrics(tokenAddress: string): Promise<LiveApiMetrics | null> {
    try {
        const res = await fetch(`${PROXY_BASE_URL}/api/proxyVibe?address=${tokenAddress}`, { cache: 'no-store' });
        if (!res.ok) return null;
        const json = await res.json();
        const launch = json?.data?.launch || (json?.data?.tokenAddress ? json.data : null);
        if (!launch) return null;

        const stats = json?.data?.marketStats;
        const ethPriceUsd = Number(json?.data?.ethPriceUsd) || 0;

        // --- Pair symbol ---
        const pairSymbol: string | null = launch.pairSymbol || null;

        // --- Decimals for synthetic pairs (e.g. USDG = 6) ---
        const targetRaw = Number(launch.targetPairUnits || launch.curve?.netTargetWei || 4e18);
        const currentRaw = Number(launch.curve?.pairReserveUnits || launch.curve?.netRaisedWei || 0);
        const pDecimals = targetRaw > 0 && targetRaw < 1e14 ? 6 : 18;
        const pDivisor = Math.pow(10, pDecimals);

        // --- Curve progress + liquidity ---
        const isGraduated =
            launch.lifecycle === 'GRADUATED' ||
            launch.graduated === true ||
            launch.curve?.lifecycle === 'GRADUATED' ||
            !!launch.graduation ||
            !!launch.poolAddress ||
            !!launch.graduationPoolAddress ||
            !!launch.pool?.address;

        const currentPairUnits = currentRaw / pDivisor;
        const targetPairUnits = targetRaw / pDivisor;
        let curveProgress: number | null = isGraduated
            ? 100
            : launch.curve?.progressBps != null
                ? launch.curve.progressBps / 100
                : Math.min(100, Math.max(0, (currentPairUnits / targetPairUnits) * 100));
        if (!isGraduated && curveProgress > 0 && curveProgress < 0.1) curveProgress = 0.1;

        const liquidityDeposited = isGraduated ? 4.0 : Number(currentPairUnits.toFixed(4));

        // --- Market cap (real price first) ---
        const directPriceUsd =
            launch.priceUsd || launch.analytics?.priceUsd || launch.curve?.priceUsd || stats?.priceUsd;
        let lastPriceWei =
            stats?.priceWeiPerToken || stats?.lastPriceWeiPerToken || launch.analytics?.lastPriceWeiPerToken || 0;
        if ((!lastPriceWei || Number(lastPriceWei) === 0) && json?.data?.marketTrades?.[0]) {
            lastPriceWei = json.data.marketTrades[0].executionPricePairUnitsPerToken;
        }

        let marketCapRaw = 0;
        if (directPriceUsd && Number(directPriceUsd) > 0) {
            marketCapRaw = Number(directPriceUsd) * 1_000_000_000;
        } else if (Number(lastPriceWei) > 0 && ethPriceUsd > 0) {
            const pricePairUnits = Number(lastPriceWei) / pDivisor;
            marketCapRaw = pricePairUnits * 1_000_000_000 * ethPriceUsd;
        }

        const marketCapFormatted =
            marketCapRaw > 0
                ? marketCapRaw.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
                : null;

        // --- 24h volume (real) ---
        let volumeEth: number | null = null;
        if (stats) {
            const buyVol = Number(stats.buyVolume24hPairUnits || 0) / pDivisor;
            const sellVol = Number(stats.sellVolume24hPairUnits || 0) / pDivisor;
            const totalVol = buyVol + sellVol;
            if (totalVol > 0) volumeEth = Number(totalVol.toFixed(4));
        } else if (launch.analytics?.volume24hWei) {
            const volWei = Number(launch.analytics.volume24hWei);
            if (volWei > 0) volumeEth = Number((volWei / pDivisor).toFixed(4));
        }

        // --- Socials ---
        const socials = launch.content?.socials || {};
        const hasSocials = !!(socials.x || socials.telegram || socials.website);

        return {
            marketCapFormatted,
            volumeEth,
            hasSocials,
            pairSymbol,
            curveProgress,
            liquidityDeposited,
        };
    } catch (err) {
        // Network-level failures (UND_ERR_SOCKET, "fetch failed", DNS/socket
        // resets) are expected on flaky hosts. Swallow them so a single bad
        // request can never crash the node process; the caller treats a null
        // result as "no fresh data" and keeps the last known-good values.
        const msg = err instanceof Error ? err.message : String(err);
        if (
            msg.includes('UND_ERR_SOCKET') ||
            msg.includes('fetch failed') ||
            msg.includes('ECONNRESET') ||
            msg.includes('socket hang up')
        ) {
            console.warn(`⚠ Transient network error fetching metrics for ${tokenAddress}: ${msg}`);
        } else {
            console.log(`⚠ Could not fetch live API metrics for ${tokenAddress}`);
        }
        return null;
    }
}

// ---------------------------------------------------------------------------
// DB HELPER — momentum from a real curve trade.
//
// `pairAmount` is the pair-currency amount in base units (18 decimals for ETH
// and most pairs). `trader` is the REAL wallet (recipient), never the zap.
// ---------------------------------------------------------------------------
async function updateMomentumInDatabase(
    tokenAddress: string,
    isBuy: boolean,
    pairAmount: bigint,
    txBlockNumber: number,
    trader: string
) {
    const tokenResult = await db.execute({
        sql: `SELECT volume_eth, buy_count, sell_count, launch_block, block_zero_buyers, dev_address, sniper_wallets
              FROM launches WHERE token_address = ? LIMIT 1`,
        args: [tokenAddress.toLowerCase()],
    });
    const token = tokenResult.rows[0] as unknown as
        | {
              volume_eth: number | null;
              buy_count: number | null;
              sell_count: number | null;
              launch_block: number | null;
              block_zero_buyers: number | null;
              dev_address: string | null;
              sniper_wallets: string | null;
          }
        | undefined;

    if (!token) return;

    const pairVolume = Number(formatUnits(pairAmount, 18));

    // Parse the persisted set of unique sniper wallets. Stored as a JSON array
    // string so we can dedupe without a second table.
    let sniperWallets: string[] = [];
    if (token.sniper_wallets) {
        try {
            const parsed = JSON.parse(token.sniper_wallets);
            if (Array.isArray(parsed)) sniperWallets = parsed.map((w) => String(w).toLowerCase());
        } catch {
            sniperWallets = [];
        }
    }

    const traderLower = trader.toLowerCase();
    const devLower = (token.dev_address || '').toLowerCase();

    // A block-0 sniper is a BUY in the exact launch block by a wallet that is
    // neither the developer's pre-buy nor the zap router (which is a routing
    // contract, never a real trader). We only count each wallet ONCE.
    const isBlockZeroBuy =
        isBuy &&
        token.launch_block != null &&
        txBlockNumber === token.launch_block &&
        traderLower !== '' &&
        traderLower !== devLower &&
        traderLower !== ZAP_ROUTER;

    let newBlockZeroBuyers = token.block_zero_buyers || 0;
    if (isBlockZeroBuy) {
        if (!sniperWallets.includes(traderLower)) {
            sniperWallets.push(traderLower);
            newBlockZeroBuyers = sniperWallets.length;
            console.log(
                `🎯 SNIPER DETECTED: Block 0 buy by ${traderLower} on ${tokenAddress} (unique snipers: ${newBlockZeroBuyers})`
            );
        }
    }

    const newBuyCount = isBuy ? (token.buy_count || 0) + 1 : (token.buy_count || 0);
    const newSellCount = !isBuy ? (token.sell_count || 0) + 1 : (token.sell_count || 0);
    const newVolume = (token.volume_eth || 0) + pairVolume;

    const totalTrades = newBuyCount + newSellCount;
    const buyPct = totalTrades > 0 ? Math.round((newBuyCount / totalTrades) * 100) : 50;
    const sellPct = 100 - buyPct;

    await db.execute({
        sql: `UPDATE launches SET
                volume_eth = ?, buy_count = ?, sell_count = ?,
                buy_pct = ?, sell_pct = ?, block_zero_buyers = ?, sniper_wallets = ?
              WHERE token_address = ?`,
        args: [
            newVolume,
            newBuyCount,
            newSellCount,
            buyPct,
            sellPct,
            newBlockZeroBuyers,
            JSON.stringify(sniperWallets),
            tokenAddress.toLowerCase(),
        ],
    });
}

// ---------------------------------------------------------------------------
// Per-curve trade watchers. Each launched token has its own curve contract, so
// we attach a watcher to every curve we discover and keep a map so we never
// double-subscribe.
// ---------------------------------------------------------------------------
const watchedCurves = new Map<string, () => void>();

/**
 * Classifies an RPC error so transient network hiccups (timeouts, aborted
 * requests, rate limits) are logged as warnings rather than fatal errors.
 * Returns true when the error is a recoverable transport-level failure.
 */
function isTransientRpcError(error: unknown): boolean {
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return (
        msg.includes('timeout') ||
        msg.includes('took too long') ||
        msg.includes('timed out') ||
        msg.includes('fetch failed') ||
        msg.includes('econnreset') ||
        msg.includes('econnrefused') ||
        msg.includes('socket hang up') ||
        msg.includes('network') ||
        msg.includes('429') ||
        msg.includes('rate limit') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504')
    );
}

function watchCurve(curveAddress: string, tokenAddress: string) {
    const curve = curveAddress.toLowerCase();
    if (watchedCurves.has(curve)) return;

    let unwatch: () => void;
    try {
        unwatch = publicClient.watchContractEvent({
        address: curve as `0x${string}`,
        abi: CURVE_ABI,
        onLogs: async (logs) => {
            for (const log of logs) {
                try {
                    if (log.eventName === 'CurveBuy') {
                        const { recipient, buyer, pairCost } = log.args as {
                            recipient?: string;
                            buyer?: string;
                            pairCost?: bigint;
                        };
                        if (pairCost == null) continue;
                        // The real wallet is the recipient; `buyer` is often the zap.
                        const trader = (recipient || buyer || '').toLowerCase();
                        console.log(
                            `🟢 BUY: ${formatUnits(pairCost, 18)} pair on ${tokenAddress} by ${trader}`
                        );
                        await updateMomentumInDatabase(
                            tokenAddress,
                            true,
                            pairCost,
                            Number(log.blockNumber),
                            trader
                        );
                    } else if (log.eventName === 'CurveSell') {
                        const { recipient, seller, pairProceeds } = log.args as {
                            recipient?: string;
                            seller?: string;
                            pairProceeds?: bigint;
                        };
                        if (pairProceeds == null) continue;
                        const trader = (recipient || seller || '').toLowerCase();
                        console.log(
                            `🔴 SELL: ${formatUnits(pairProceeds, 18)} pair on ${tokenAddress} by ${trader}`
                        );
                        await updateMomentumInDatabase(
                            tokenAddress,
                            false,
                            pairProceeds,
                            Number(log.blockNumber),
                            trader
                        );
                    }
                } catch (logErr) {
                    console.error('Error processing curve trade log:', logErr);
                }
            }
        },
        onError: (error) => {
            if (isTransientRpcError(error)) {
                console.warn(
                    `⚠ Curve watchEvent transient RPC error for ${curve} (will retry):`,
                    error instanceof Error ? error.message : error
                );
            } else {
                console.error(`Curve watchEvent error for ${curve}:`, error);
            }
        },
        });

        watchedCurves.set(curve, unwatch);
        console.log(`👀 Watching curve ${curve} for ${tokenAddress}`);
    } catch (err) {
        // A synchronous failure while subscribing (e.g. transport setup) must
        // never crash the indexer. Log and move on; rehydration will retry.
        console.error(`Failed to attach curve watcher for ${curve}:`, err);
    }
}

/**
 * Re-attaches curve watchers for tokens already in the DB. Called once on boot
 * so a restart does not lose real-time momentum for existing launches.
 */
async function rehydrateCurveWatchers() {
    try {
        const tokensResult = await db.execute({
            sql: `SELECT token_address, amm_address FROM launches
                  ORDER BY launch_id DESC LIMIT 200`,
            args: [],
        });
        const tokens = tokensResult.rows as unknown as Array<{
            token_address: string | null;
            amm_address: string | null;
        }>;
        if (!tokens.length) return;
        for (const t of tokens) {
            if (t.amm_address && t.token_address) {
                watchCurve(t.amm_address, t.token_address);
            }
        }
        console.log(`♻ Rehydrated ${watchedCurves.size} curve watchers`);
    } catch (err) {
        console.error('Failed to rehydrate curve watchers:', err);
    }
}

/**
 * Builds and runs a parameterized `UPDATE launches SET ... WHERE launch_id = ?`
 * from a partial column map. Only the provided columns are touched, mirroring
 * the old Supabase `.update(payload).eq('launch_id', id)` behaviour.
 */
async function updateLaunchById(launchId: number | bigint, payload: Record<string, any>) {
    const entries = Object.entries(payload).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const setClause = entries.map(([col]) => `${col} = ?`).join(', ');
    const args = entries.map(([, v]) => v);
    await db.execute({
        sql: `UPDATE launches SET ${setClause} WHERE launch_id = ?`,
        args: [...args, launchId],
    });
}

async function runIndexer() {
    console.log('⚡ Vibe Signals Cloud Node Live...');

    // 1. THE LAUNCH CATCHER — decode the real LaunchCreated event.
    try {
        publicClient.watchContractEvent({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI,
        onLogs: async (logs) => {
            for (const log of logs) {
                try {
                    if (log.eventName !== 'LaunchCreated') continue;
                    const args = log.args as {
                        launchId?: bigint;
                        launcher?: string;
                        token?: string;
                        curve?: string;
                        name?: string;
                        symbol?: string;
                        pairCurrency?: string;
                        taxBps?: number;
                        packedWeights?: bigint;
                        projectTreasury?: string;
                        targetPairUnits?: bigint;
                    };

                    const launchId = Number(args.launchId ?? 0);
                    const devAddress = (args.launcher || '').toLowerCase();
                    const tokenAddress = (args.token || '').toLowerCase();
                    const curveAddress = (args.curve || '').toLowerCase();
                    if (!tokenAddress || !curveAddress) continue;

                    const isNativeEth =
                        (args.pairCurrency || '').toLowerCase() === ZERO_ADDRESS;

                    // Prefer the event's own name/symbol; fall back to the contract.
                    let tokenName = args.name || `Token #${launchId}`;
                    let tokenSymbol = args.symbol || 'TKN';
                    if (!args.name || !args.symbol) {
                        try {
                            const [n, s] = await Promise.all([
                                publicClient.readContract({
                                    address: tokenAddress as `0x${string}`,
                                    abi: TOKEN_ABI,
                                    functionName: 'name',
                                }),
                                publicClient.readContract({
                                    address: tokenAddress as `0x${string}`,
                                    abi: TOKEN_ABI,
                                    functionName: 'symbol',
                                }),
                            ]);
                            tokenName = n as string;
                            tokenSymbol = s as string;
                        } catch {
                            console.log('⚠ Could not read token metadata');
                        }
                    }

                    // 2-second delay to let VibeVibe's off-chain DB catch up,
                    // then pull REAL market data (socials, market cap, volume).
                    await new Promise((r) => setTimeout(r, 2000));
                    const live = await fetchLiveApiMetrics(tokenAddress);

                    const hasSocials = live?.hasSocials ?? false;
                    if (hasSocials) console.log(`🔗 Socials verified for ${tokenSymbol}`);

                    console.log(`🚨 CLOUD SYNC: [#${launchId}] ${tokenName} ($${tokenSymbol})`);

                    await db.execute({
                        sql: `INSERT INTO launches (
                                launch_id, token_address, amm_address, dev_address, pair_symbol,
                                liquidity_deposited, curve_progress, launch_block, name, symbol,
                                has_socials, cachedMarketCapFormatted, volume_eth
                              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                              ON CONFLICT(token_address) DO UPDATE SET
                                launch_id = excluded.launch_id,
                                amm_address = excluded.amm_address,
                                dev_address = excluded.dev_address,
                                pair_symbol = excluded.pair_symbol,
                                liquidity_deposited = excluded.liquidity_deposited,
                                curve_progress = excluded.curve_progress,
                                launch_block = excluded.launch_block,
                                name = excluded.name,
                                symbol = excluded.symbol,
                                has_socials = excluded.has_socials,
                                cachedMarketCapFormatted = excluded.cachedMarketCapFormatted,
                                volume_eth = excluded.volume_eth`,
                        args: [
                            launchId,
                            tokenAddress,
                            curveAddress,
                            devAddress,
                            live?.pairSymbol || (isNativeEth ? 'ETH' : 'STOCK'),
                            live?.liquidityDeposited ?? 0,
                            live?.curveProgress ?? 0,
                            Number(log.blockNumber),
                            tokenName,
                            tokenSymbol,
                            hasSocials ? 1 : 0,
                            live?.marketCapFormatted ?? null,
                            live?.volumeEth ?? 0,
                        ],
                    });

                    // Start streaming this token's trades immediately.
                    watchCurve(curveAddress, tokenAddress);
                } catch (logErr) {
                    console.error('Error processing launch log event:', logErr);
                }
            }
        },
        onError: (error) => {
            if (isTransientRpcError(error)) {
                console.warn(
                    '⚠ Factory watchEvent transient RPC error (will retry):',
                    error instanceof Error ? error.message : error
                );
            } else {
                console.error('Factory watchEvent error:', error);
            }
        },
        });
    } catch (err) {
        // Never let a failed subscription crash the process; the health server
        // and the polling loop below keep running regardless.
        console.error('Failed to attach factory watcher:', err);
    }

    // Re-attach watchers for tokens already indexed before this boot.
    await rehydrateCurveWatchers();

    // 3. THE LIVE BALANCE UPDATER (Runs every 10 seconds)
    setInterval(async () => {
        try {
            const recentResult = await db.execute({
                sql: `SELECT * FROM launches ORDER BY launch_id DESC LIMIT 20`,
                args: [],
            });
            const recentTokens = recentResult.rows as unknown as Array<Record<string, any>>;
            if (!recentTokens.length) return;

            for (const token of recentTokens) {
                // Backfill REAL market data from the API for every recent token,
                // regardless of pair type, so Supabase converges with the live API.
                const live = await fetchLiveApiMetrics(token.token_address);
                const apiPayload: Record<string, any> = {};
                if (live) {
                    // NEVER regress a previously-known-good value to a transient
                    // falsy/zero. A failed/partial API response must not erase
                    // real data (e.g. socials flipping true -> false, or a
                    // market cap dropping to null).
                    if (live.marketCapFormatted) {
                        apiPayload.cachedMarketCapFormatted = live.marketCapFormatted;
                    }
                    if (live.volumeEth != null && live.volumeEth > 0) {
                        apiPayload.volume_eth = live.volumeEth;
                    }
                    // Socials are sticky: once true, a failed fetch can never
                    // set them back to false.
                    if (live.hasSocials || token.has_socials) {
                        apiPayload.has_socials = true;
                    }
                }

                if (token.pair_symbol === 'ETH') {
                    // 1. If already marked as graduated (>= 100%), still persist API data then skip.
                    if (Number(token.curve_progress) >= 100) {
                        if (Object.keys(apiPayload).length > 0) {
                            await updateLaunchById(token.launch_id, apiPayload);
                        }
                        continue;
                    }

                    // Read the real curve state instead of guessing from balance.
                    let currentLiq = 0;
                    let graduated = false;
                    try {
                        const curve = token.amm_address as `0x${string}`;
                        const [principal, target, complete] = await Promise.all([
                            publicClient.readContract({
                                address: curve,
                                abi: CURVE_ABI,
                                functionName: 'pairPrincipal',
                            }),
                            publicClient.readContract({
                                address: curve,
                                abi: CURVE_ABI,
                                functionName: 'targetPairUnits',
                            }),
                            publicClient.readContract({
                                address: curve,
                                abi: CURVE_ABI,
                                functionName: 'complete',
                            }),
                        ]);
                        currentLiq = Number(formatUnits(principal as bigint, 18));
                        graduated = complete as boolean;
                        const targetUnits = Number(formatUnits(target as bigint, 18)) || 4;
                        const progress = graduated
                            ? 100
                            : Math.min(100, Math.max(0, (currentLiq / targetUnits) * 100));

                        // Non-regression guards: a transient RPC read that returns
                        // 0 must never overwrite a previously high curve progress
                        // or liquidity. We only ever move these values UP.
                        const prevProgress = Number(token.curve_progress || 0);
                        const prevLiq = Number(token.liquidity_deposited || 0);
                        const safeProgress = Math.max(progress, prevProgress);
                        const safeLiq = Math.max(currentLiq, prevLiq);

                        if (safeProgress > prevProgress || Object.keys(apiPayload).length > 0) {
                            const updatePayload: any = {
                                ...apiPayload,
                                liquidity_deposited: Number(safeLiq.toFixed(4)),
                                curve_progress: Number(safeProgress.toFixed(1)),
                            };
                            await updateLaunchById(token.launch_id, updatePayload);
                            console.log(
                                `📈 SYNC: $${token.symbol} liq: ${safeLiq.toFixed(4)} (${safeProgress.toFixed(1)}%)`
                            );
                        }
                    } catch (curveErr) {
                        // Fall back to the balance heuristic if the curve read fails.
                        // Same non-regression rule: never let a failed read drop
                        // liquidity/progress below what we already know.
                        const rawEth = await publicClient.getBalance({
                            address: token.amm_address as `0x${string}`,
                        });
                        currentLiq = parseFloat(formatUnits(rawEth, 18));
                        const progress = Math.min(100, Math.max(0, (currentLiq / 4.0) * 100));

                        const prevProgress = Number(token.curve_progress || 0);
                        const prevLiq = Number(token.liquidity_deposited || 0);
                        const safeProgress = Math.max(progress, prevProgress);
                        const safeLiq = Math.max(currentLiq, prevLiq);

                        if (safeProgress > prevProgress || Object.keys(apiPayload).length > 0) {
                            await updateLaunchById(token.launch_id, {
                                ...apiPayload,
                                liquidity_deposited: Number(safeLiq.toFixed(4)),
                                curve_progress: Number(safeProgress.toFixed(1)),
                            });
                        }
                    }
                } else if (Object.keys(apiPayload).length > 0) {
                    // Non-ETH pairs: persist the API-derived market data.
                    await updateLaunchById(token.launch_id, apiPayload);
                }
            }
        } catch (err) {
            /* swallow — transient DB/RPC hiccups must not kill the loop */
        }
    }, 10000);
}

runIndexer();

// ---------------------------------------------------------------------------
// HEARTBEAT / HEALTH SERVER
//
// Hugging Face Spaces requires the container to bind to port 7860 and answer
// health checks with HTTP 200. We honour an injected PORT (HF sets it) but
// default to 7860 so the Space passes its readiness probe out of the box.
// The blockchain polling/listening logic above starts independently of this
// server, so a slow RPC never blocks the health check.
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 7860;
createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'alive' }));
        return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'not_found' }));
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Health check listening on 0.0.0.0:${PORT}`);
});
