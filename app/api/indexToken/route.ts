import { NextResponse } from 'next/server';
import { createPublicClient, http, formatEther, parseAbiItem, getAddress } from 'viem';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

const publicClient = createPublicClient({
    transport: http('https://rpc.testnet.chain.robinhood.com')
});

const FACTORY_ADDRESS = "0xe794217880011f9cA6961340eD5c16EC9559Fea0";
const ROUTER_ADDRESS = "0x89944BC9D3b20764BeA771CFAf9711a8Fb839e72";
const creationEvent = parseAbiItem('event Creation(uint256 indexed launchId, address indexed creator, address indexed token)');
const curveBuyEvent = parseAbiItem('event CurveBuy(address indexed token, address indexed buyer, uint256 tokensOut, uint256 bnbIn, uint256 fee, uint256 reserveAfter, uint256 soldAfter, uint256 timestamp)');

const ERC20_ABI = [
    { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }
] as const;

const FACTORY_ABI = [
    { name: "amm", type: "function", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "address" }] },
    { name: "pools", type: "function", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "address" }] },
    { name: "getAmm", type: "function", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "address" }] }
] as const;

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

        // 1. Fetch token details (name/symbol)
        const [name, symbol] = await Promise.all([
            publicClient.readContract({ address: checksummedToken, abi: ERC20_ABI, functionName: "name" }).catch(() => "Unknown"),
            publicClient.readContract({ address: checksummedToken, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "TKN")
        ]);

        let ammAddress: `0x${string}` | null = null;

        // 2. Try Direct Factory View Method
        for (const fn of ['amm', 'pools', 'getAmm'] as const) {
            try {
                const result = await publicClient.readContract({
                    address: FACTORY_ADDRESS as `0x${string}`,
                    abi: FACTORY_ABI,
                    functionName: fn,
                    args: [checksummedToken]
                }) as string;
                if (result && result !== '0x0000000000000000000000000000000000000000') {
                    ammAddress = result.toLowerCase() as `0x${string}`;
                    break;
                }
            } catch (e) {
                // Ignore and try next
            }
        }

        const currentBlock = await publicClient.getBlockNumber();
        let log: any = null;

        // 3. Comprehensive Log Scan (Backward Pagination)
        if (!ammAddress) {
            const CHUNK_SIZE = 45000n;
            let toBlock = currentBlock;
            let fromBlock = toBlock > CHUNK_SIZE ? toBlock - CHUNK_SIZE : 0n;

            while (toBlock >= 0n) {
                try {
                    const logs = await publicClient.getLogs({
                        address: FACTORY_ADDRESS as `0x${string}`,
                        event: creationEvent,
                        args: { token: checksummedToken },
                        fromBlock,
                        toBlock,
                        strict: false
                    });

                    if (logs.length > 0) {
                        log = logs[0];
                        ammAddress = `0x${log.data.slice(26, 66)}`.toLowerCase() as `0x${string}`;
                        break;
                    }
                } catch (err) {
                    console.warn(`RPC chunk error ${fromBlock}-${toBlock}:`, err);
                }

                if (fromBlock === 0n) break;
                toBlock = fromBlock - 1n;
                fromBlock = toBlock > CHUNK_SIZE ? toBlock - CHUNK_SIZE : 0n;
            }
        }

        if (!ammAddress) {
            return NextResponse.json({ 
                error: 'Token not found on vibevibe factory',
                partialToken: { name, symbol }
            }, { status: 404 });
        }

        const launchId = log ? Number(log.args.launchId) : 0;
        const devAddress = log ? (log.args.creator?.toLowerCase() || '') : tokenAddress;
        
        let isNativeEth = true;
        if (log) {
            const baseTokenHex = log.data.slice(282, 322);
            isNativeEth = baseTokenHex === "0000000000000000000000000000000000000000";
        }

        let launchBlock = currentBlock;
        let timestamp = new Date().toISOString();

        if (log) {
            launchBlock = log.blockNumber;
            const block = await publicClient.getBlock({ blockNumber: launchBlock });
            timestamp = new Date(Number(block.timestamp) * 1000).toISOString();
        }

        // 4. Get Current AMM Balance
        const rawEth = await publicClient.getBalance({ address: ammAddress });
        const currentLiq = parseFloat(formatEther(rawEth));
        const curveProgress = Math.min(100, Math.max(0, (currentLiq / 4.0) * 100));

        // 5. Query Router for CurveBuy events to calculate momentum
        const momentumFromBlock = log ? launchBlock : (currentBlock > 45000n ? currentBlock - 45000n : 0n);
        const buyLogs = await publicClient.getLogs({
            address: ROUTER_ADDRESS as `0x${string}`,
            event: curveBuyEvent,
            args: { token: checksummedToken },
            fromBlock: momentumFromBlock,
            toBlock: 'latest'
        }).catch(() => []); // graceful fallback

        let volumeEth = 0;
        let buyCount = buyLogs.length;
        
        for (const buyLog of buyLogs) {
            if (buyLog.args.bnbIn) {
                volumeEth += Number(formatEther(buyLog.args.bnbIn as bigint));
            }
        }
        
        // 6. Upsert into Supabase
        const dbPayload = {
            launch_id: launchId,
            token_address: tokenAddress,
            amm_address: ammAddress,
            dev_address: devAddress,
            pair_symbol: isNativeEth ? 'ETH' : 'STOCK',
            liquidity_deposited: Number(currentLiq.toFixed(4)),
            curve_progress: Number(curveProgress.toFixed(1)),
            launch_block: Number(launchBlock),
            name: name,
            symbol: symbol,
            created_at: timestamp,
            volume_eth: volumeEth,
            buy_count: buyCount,
            sell_count: 0,
            buy_pct: buyCount > 0 ? 100 : 50,
            sell_pct: buyCount > 0 ? 0 : 50
        };

        await supabase.from('launches').upsert(dbPayload, { onConflict: 'token_address' });

        return NextResponse.json({ 
            success: true,
            token: dbPayload
        });
    } catch (error) {
        console.error("JIT Indexing error:", error);
        return NextResponse.json({ error: 'Failed to index token' }, { status: 500 });
    }
}
