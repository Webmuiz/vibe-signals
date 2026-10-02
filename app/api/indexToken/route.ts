import { NextResponse } from 'next/server';
import { createPublicClient, http, formatEther, parseAbiItem } from 'viem';
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

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const tokenAddress = searchParams.get('address')?.toLowerCase();

    if (!tokenAddress || !tokenAddress.startsWith('0x') || tokenAddress.length !== 42) {
        return NextResponse.json({ error: 'Invalid address' }, { status: 400 });
    }

    try {
        // 1. Fetch token details (name/symbol)
        const [name, symbol] = await Promise.all([
            publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "name" }).catch(() => "Unknown"),
            publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "TKN")
        ]);

        // 2. Fetch creation event from Factory
        const creationLogs = await publicClient.getLogs({
            address: FACTORY_ADDRESS as `0x${string}`,
            event: creationEvent,
            args: { token: tokenAddress as `0x${string}` },
            fromBlock: 0n,
            toBlock: 'latest',
            strict: false
        });

        if (creationLogs.length === 0) {
            return NextResponse.json({ error: 'Token not created by this factory' }, { status: 404 });
        }

        const log = creationLogs[0];
        const launchId = Number(log.args.launchId);
        const devAddress = log.args.creator?.toLowerCase() || '';
        const ammAddress = `0x${log.data.slice(26, 66)}`.toLowerCase() as `0x${string}`;
        
        const baseTokenHex = log.data.slice(282, 322);
        const isNativeEth = baseTokenHex === "0000000000000000000000000000000000000000";

        // 3. Fetch block for timestamp
        const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
        const timestamp = new Date(Number(block.timestamp) * 1000).toISOString();

        // 4. Get Current AMM Balance
        const rawEth = await publicClient.getBalance({ address: ammAddress as `0x${string}` });
        const currentLiq = parseFloat(formatEther(rawEth));
        const curveProgress = Math.min(100, Math.max(0, (currentLiq / 4.0) * 100));

        // 5. Query Router for CurveBuy events to calculate momentum
        const buyLogs = await publicClient.getLogs({
            address: ROUTER_ADDRESS as `0x${string}`,
            event: curveBuyEvent,
            args: { token: tokenAddress as `0x${string}` },
            fromBlock: log.blockNumber,
            toBlock: 'latest'
        });

        let volumeEth = 0;
        let buyCount = buyLogs.length;
        
        for (const buyLog of buyLogs) {
            if (buyLog.args.bnbIn) {
                volumeEth += Number(formatEther(buyLog.args.bnbIn as bigint));
            }
        }
        
        // 6. Upsert into Supabase
        await supabase.from('launches').upsert({
            launch_id: launchId,
            token_address: tokenAddress,
            amm_address: ammAddress,
            dev_address: devAddress,
            pair_symbol: isNativeEth ? 'ETH' : 'STOCK',
            liquidity_deposited: Number(currentLiq.toFixed(4)),
            curve_progress: Number(curveProgress.toFixed(1)),
            launch_block: Number(log.blockNumber),
            name: name,
            symbol: symbol,
            created_at: timestamp,
            volume_eth: volumeEth,
            buy_count: buyCount,
            sell_count: 0,
            buy_pct: buyCount > 0 ? 100 : 50,
            sell_pct: buyCount > 0 ? 0 : 50
        }, { onConflict: 'token_address' });

        return NextResponse.json({ 
            success: true, 
            launchBlock: log.blockNumber.toString(),
            launchId: launchId.toString()
        });
    } catch (error) {
        console.error("JIT Indexing error:", error);
        return NextResponse.json({ error: 'Failed to index token' }, { status: 500 });
    }
}
