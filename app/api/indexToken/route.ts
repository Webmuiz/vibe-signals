import { NextResponse } from 'next/server';
import { createPublicClient, http, formatUnits, parseAbi, getAddress } from 'viem';
import { createClient } from '@libsql/client';

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL!;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN!;
const db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

const publicClient = createPublicClient({
    transport: http('https://rpc.testnet.chain.robinhood.com'),
});

// ---------------------------------------------------------------------------
// Verified V6 addresses (vibevibe.md §2). Do not invent addresses.
// ---------------------------------------------------------------------------
const FACTORY_ADDRESS = '0xe794217880011f9cA6961340eD5c16EC9559Fea0' as const;
const ZAP_ROUTER = '0x2784448c519D01d3aE257C0aac0b7cDAd8AccEB1' as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

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
    'function balanceOf(address account) view returns (uint256)',
]);

// The zap router is what the vibe/vibe website uses for non-ETH pairs and
// graduated tokens, so in CurveBuy/CurveSell the buyer/seller is often this
// address. The real wallet is then `recipient`. Never count the zap as a trader.
const ZAP_ROUTER_LOWER = ZAP_ROUTER.toLowerCase();

// Read logs in ranges of at most 5,000 blocks (vibevibe.md §1: block time is
// well under a second, so block numbers grow fast).
const LOG_CHUNK_SIZE = 5000n;

/**
 * Scans factory logs backwards in 5,000-block chunks to find the LaunchCreated
 * event for a token. Returns the decoded args (or null if not found).
 */
async function findLaunchEvent(token: `0x${string}`) {
    const currentBlock = await publicClient.getBlockNumber();
    let toBlock = currentBlock;
    let fromBlock = toBlock > LOG_CHUNK_SIZE ? toBlock - LOG_CHUNK_SIZE : 0n;

    while (toBlock >= 0n) {
        try {
            const logs = await publicClient.getContractEvents({
                address: FACTORY_ADDRESS,
                abi: FACTORY_ABI,
                eventName: 'LaunchCreated',
                args: { token },
                fromBlock,
                toBlock,
                strict: false,
            });
            if (logs.length > 0) return logs[0];
        } catch (err) {
            console.warn(`RPC chunk error ${fromBlock}-${toBlock}:`, err);
        }

        if (fromBlock === 0n) break;
        toBlock = fromBlock - 1n;
        fromBlock = toBlock > LOG_CHUNK_SIZE ? toBlock - LOG_CHUNK_SIZE : 0n;
    }
    return null;
}

/**
 * Identifies the UNIQUE block-0 snipers for a token and measures how many of
 * them still hold tokens (retention).
 *
 * A sniper is a wallet that bought on the curve in the exact launch block,
 * excluding the developer's pre-buy and the zap router. Retention is measured
 * by reading each sniper's CURRENT ERC-20 balance of the launched token:
 *   - balance > 0  → still holding (retained)
 *   - balance == 0 → fully dumped
 *
 * Returns `retentionPct` (0-100). When there are no snipers we return 100
 * (nothing was dumped) rather than NaN.
 */
async function calculateSniperRetention(
    token: `0x${string}`,
    curve: `0x${string}`,
    launchBlock: number,
    devAddress: string
): Promise<{ totalSnipers: number; holdingSnipers: number; retentionPct: number; sniperWallets: string[] }> {
    const sniperWallets = new Set<string>();

    // Only the launch block itself matters for block-0 sniping, so we scan a
    // single, tight range instead of the whole history (keeps RPC usage low).
    try {
        const buys = await publicClient.getContractEvents({
            address: curve,
            abi: CURVE_ABI,
            eventName: 'CurveBuy',
            fromBlock: BigInt(launchBlock),
            toBlock: BigInt(launchBlock),
        });

        for (const b of buys) {
            const { recipient, buyer } = b.args as { recipient?: string; buyer?: string };
            // The real wallet is `recipient`; `buyer` is often the zap router.
            const trader = (recipient || buyer || '').toLowerCase();
            if (!trader) continue;
            if (trader === ZAP_ROUTER_LOWER) continue;
            if (trader === devAddress.toLowerCase()) continue;
            sniperWallets.add(trader);
        }
    } catch (err) {
        console.warn(`Could not scan block-0 buys for ${token}:`, err);
    }

    const wallets = Array.from(sniperWallets);
    const totalSnipers = wallets.length;

    // Edge case: no snipers → nothing dumped → 100% retained.
    if (totalSnipers === 0) {
        return { totalSnipers: 0, holdingSnipers: 0, retentionPct: 100, sniperWallets: [] };
    }

    // Read current balances in parallel. A failed read is treated as "dumped"
    // only if it definitively returns 0; on error we conservatively assume the
    // wallet still holds (so a transient RPC hiccup doesn't fake a dump).
    const balances = await Promise.all(
        wallets.map(async (wallet) => {
            try {
                const bal = (await publicClient.readContract({
                    address: token,
                    abi: TOKEN_ABI,
                    functionName: 'balanceOf',
                    args: [wallet as `0x${string}`],
                })) as bigint;
                return bal > 0n;
            } catch {
                return true; // assume holding on read failure
            }
        })
    );

    const holdingSnipers = balances.filter(Boolean).length;
    const retentionPct = Math.round((holdingSnipers / totalSnipers) * 100);

    return { totalSnipers, holdingSnipers, retentionPct, sniperWallets: wallets };
}

/**
 * Sums real curve trades for a token. Buys use `pairCost`, sells use
 * `pairProceeds` (both in the pair currency, 18 decimals). The zap router is
 * never counted as a trader — the real wallet is `recipient`.
 */
async function sumCurveTrades(curve: `0x${string}`, startBlock: bigint) {
    const currentBlock = await publicClient.getBlockNumber();
    let volumePairUnits = 0;
    let buyCount = 0;
    let sellCount = 0;

    let toBlock = currentBlock;
    let fromBlock = toBlock > LOG_CHUNK_SIZE ? toBlock - LOG_CHUNK_SIZE : 0n;
    // Never scan earlier than the launch block.
    if (fromBlock < startBlock) fromBlock = startBlock;

    while (toBlock >= startBlock) {
        const chunkFrom = fromBlock;
        try {
            const [buys, sells] = await Promise.all([
                publicClient.getContractEvents({
                    address: curve,
                    abi: CURVE_ABI,
                    eventName: 'CurveBuy',
                    fromBlock: chunkFrom,
                    toBlock,
                }),
                publicClient.getContractEvents({
                    address: curve,
                    abi: CURVE_ABI,
                    eventName: 'CurveSell',
                    fromBlock: chunkFrom,
                    toBlock,
                }),
            ]);

            for (const b of buys) {
                const { pairCost, recipient, buyer } = b.args as {
                    pairCost?: bigint;
                    recipient?: string;
                    buyer?: string;
                };
                if (pairCost == null) continue;
                // The real wallet is `recipient`; `buyer` is often the zap.
                const trader = (recipient || buyer || '').toLowerCase();
                if (trader === ZAP_ROUTER_LOWER && !recipient) continue;
                volumePairUnits += Number(formatUnits(pairCost, 18));
                buyCount += 1;
            }

            for (const s of sells) {
                const { pairProceeds, recipient, seller } = s.args as {
                    pairProceeds?: bigint;
                    recipient?: string;
                    seller?: string;
                };
                if (pairProceeds == null) continue;
                const trader = (recipient || seller || '').toLowerCase();
                if (trader === ZAP_ROUTER_LOWER && !recipient) continue;
                volumePairUnits += Number(formatUnits(pairProceeds, 18));
                sellCount += 1;
            }
        } catch (err) {
            console.warn(`Curve trade chunk error ${chunkFrom}-${toBlock}:`, err);
        }

        if (chunkFrom <= startBlock) break;
        toBlock = chunkFrom - 1n;
        fromBlock = toBlock > LOG_CHUNK_SIZE ? toBlock - LOG_CHUNK_SIZE : 0n;
        if (fromBlock < startBlock) fromBlock = startBlock;
    }

    return { volumePairUnits, buyCount, sellCount };
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const tokenAddress = searchParams.get('address')?.toLowerCase();

    if (!tokenAddress || !tokenAddress.startsWith('0x') || tokenAddress.length !== 42) {
        return NextResponse.json({ error: 'Invalid address' }, { status: 400 });
    }

    try {
        let checksummedToken: `0x${string}`;
        try {
            checksummedToken = getAddress(tokenAddress);
        } catch {
            return NextResponse.json({ error: 'Invalid checksum address' }, { status: 400 });
        }

        // 1. Token metadata (name/symbol) straight from the ERC-20.
        const [name, symbol] = await Promise.all([
            publicClient
                .readContract({ address: checksummedToken, abi: TOKEN_ABI, functionName: 'name' })
                .catch(() => 'Unknown'),
            publicClient
                .readContract({ address: checksummedToken, abi: TOKEN_ABI, functionName: 'symbol' })
                .catch(() => 'TKN'),
        ]);

        // 2. Curve address from the V6 factory (the authoritative mapping).
        let curveAddress: `0x${string}` | null = null;
        try {
            const curve = (await publicClient.readContract({
                address: FACTORY_ADDRESS,
                abi: FACTORY_ABI,
                functionName: 'curveOf',
                args: [checksummedToken],
            })) as string;
            if (curve && curve !== ZERO_ADDRESS) {
                curveAddress = curve.toLowerCase() as `0x${string}`;
            }
        } catch (e) {
            // Fall through to the log scan below.
        }

        // 3. Fall back to the LaunchCreated event if curveOf returned nothing.
        const launchLog = await findLaunchEvent(checksummedToken);
        if (!curveAddress && launchLog) {
            const args = launchLog.args as { curve?: string };
            if (args.curve) curveAddress = args.curve.toLowerCase() as `0x${string}`;
        }

        if (!curveAddress) {
            return NextResponse.json(
                {
                    error: 'Token not found on vibevibe V6 factory',
                    partialToken: { name, symbol },
                },
                { status: 404 }
            );
        }

        // 4. Decode launch metadata from the event (name/symbol/pair/tax).
        const launchArgs = (launchLog?.args || {}) as {
            launchId?: bigint;
            launcher?: string;
            name?: string;
            symbol?: string;
            pairCurrency?: string;
            taxBps?: number;
        };
        const launchId = Number(launchArgs.launchId ?? 0);
        const devAddress = (launchArgs.launcher || tokenAddress).toLowerCase();
        const isNativeEth = (launchArgs.pairCurrency || '').toLowerCase() === ZERO_ADDRESS;
        const finalName = launchArgs.name || (name as string);
        const finalSymbol = launchArgs.symbol || (symbol as string);

        // 5. Live curve state (real graduation progress, not a balance guess).
        let currentLiq = 0;
        let curveProgress = 0;
        let graduated = false;
        try {
            const [principal, target, complete] = await Promise.all([
                publicClient.readContract({
                    address: curveAddress,
                    abi: CURVE_ABI,
                    functionName: 'pairPrincipal',
                }),
                publicClient.readContract({
                    address: curveAddress,
                    abi: CURVE_ABI,
                    functionName: 'targetPairUnits',
                }),
                publicClient.readContract({
                    address: curveAddress,
                    abi: CURVE_ABI,
                    functionName: 'complete',
                }),
            ]);
            currentLiq = Number(formatUnits(principal as bigint, 18));
            graduated = complete as boolean;
            const targetUnits = Number(formatUnits(target as bigint, 18)) || 4;
            curveProgress = graduated ? 100 : Math.min(100, Math.max(0, (currentLiq / targetUnits) * 100));
        } catch (curveErr) {
            console.warn('Could not read curve state, falling back to balance:', curveErr);
            const rawEth = await publicClient.getBalance({ address: curveAddress });
            currentLiq = Number(formatUnits(rawEth, 18));
            curveProgress = Math.min(100, Math.max(0, (currentLiq / 4.0) * 100));
        }

        // 6. Real momentum from CurveBuy/CurveSell (pairCost / pairProceeds).
        const launchBlock = launchLog ? Number(launchLog.blockNumber) : Number(await publicClient.getBlockNumber());
        const { volumePairUnits, buyCount, sellCount } = await sumCurveTrades(
            curveAddress,
            BigInt(launchBlock)
        );

        // 6b. Real sniper retention: unique block-0 buyers still holding.
        const retention = await calculateSniperRetention(
            checksummedToken,
            curveAddress,
            launchBlock,
            devAddress
        );

        const totalTrades = buyCount + sellCount;
        const buyPct = totalTrades > 0 ? Math.round((buyCount / totalTrades) * 100) : 50;
        const sellPct = 100 - buyPct;

        let timestamp = new Date().toISOString();
        if (launchLog) {
            try {
                const block = await publicClient.getBlock({ blockNumber: launchLog.blockNumber });
                timestamp = new Date(Number(block.timestamp) * 1000).toISOString();
            } catch {
                /* keep current time */
            }
        }

        // 7. Upsert into Turso (libSQL).
        const dbPayload = {
            launch_id: launchId,
            token_address: tokenAddress,
            amm_address: curveAddress,
            dev_address: devAddress,
            pair_symbol: isNativeEth ? 'ETH' : 'STOCK',
            liquidity_deposited: Number(currentLiq.toFixed(4)),
            curve_progress: Number(curveProgress.toFixed(1)),
            launch_block: launchBlock,
            name: finalName,
            symbol: finalSymbol,
            created_at: timestamp,
            volume_eth: Number(volumePairUnits.toFixed(4)),
            buy_count: buyCount,
            sell_count: sellCount,
            buy_pct: buyPct,
            sell_pct: sellPct,
            block_zero_buyers: retention.totalSnipers,
            sniper_wallets: JSON.stringify(retention.sniperWallets),
            sniper_retention_pct: retention.retentionPct,
        };

        await db.execute({
            sql: `INSERT INTO launches (
                    launch_id, token_address, amm_address, dev_address, pair_symbol,
                    liquidity_deposited, curve_progress, launch_block, name, symbol,
                    created_at, volume_eth, buy_count, sell_count, buy_pct, sell_pct,
                    block_zero_buyers, sniper_wallets, sniper_retention_pct
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    created_at = excluded.created_at,
                    volume_eth = excluded.volume_eth,
                    buy_count = excluded.buy_count,
                    sell_count = excluded.sell_count,
                    buy_pct = excluded.buy_pct,
                    sell_pct = excluded.sell_pct,
                    block_zero_buyers = excluded.block_zero_buyers,
                    sniper_wallets = excluded.sniper_wallets,
                    sniper_retention_pct = excluded.sniper_retention_pct`,
            args: [
                dbPayload.launch_id,
                dbPayload.token_address,
                dbPayload.amm_address,
                dbPayload.dev_address,
                dbPayload.pair_symbol,
                dbPayload.liquidity_deposited,
                dbPayload.curve_progress,
                dbPayload.launch_block,
                dbPayload.name,
                dbPayload.symbol,
                dbPayload.created_at,
                dbPayload.volume_eth,
                dbPayload.buy_count,
                dbPayload.sell_count,
                dbPayload.buy_pct,
                dbPayload.sell_pct,
                dbPayload.block_zero_buyers,
                dbPayload.sniper_wallets,
                dbPayload.sniper_retention_pct,
            ],
        });

        return NextResponse.json({
            success: true,
            token: dbPayload,
            sniperRetention: {
                totalSnipers: retention.totalSnipers,
                holdingSnipers: retention.holdingSnipers,
                retentionPct: retention.retentionPct,
            },
        });
    } catch (error) {
        console.error('JIT Indexing error:', error);
        return NextResponse.json({ error: 'Failed to index token' }, { status: 500 });
    }
}
