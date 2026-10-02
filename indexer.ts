import { createServer } from 'http';
import 'dotenv/config';
import { createPublicClient, http, defineChain, formatEther, parseAbiItem } from 'viem';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

const ERC20_ABI = [
    { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
    { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }
] as const;

const robinhoodTestnet = defineChain({
    id: 1,
    name: 'Robinhood Testnet',
    network: 'robinhood-testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
});

const publicClient = createPublicClient({ chain: robinhoodTestnet, transport: http() });

const FACTORY_ADDRESS = "0xe794217880011f9cA6961340eD5c16EC9559Fea0";
const ROUTER_ADDRESS = "0x89944BC9D3b20764BeA771CFAf9711a8Fb839e72";
const CREATION_TOPIC = "0xa7e8032bfd07a9fbcde50eabe91eb2901faee6dbddd9cced579491d9b07ef5c8";

// --- DB HELPER FUNCTION ---
async function updateMomentumInDatabase(tokenAddress: string, isBuy: boolean, ethVolume: number) {
    // 1. Fetch current momentum data for this token
    const { data: token } = await supabase
        .from('launches')
        .select('volume_eth, buy_count, sell_count')
        .eq('token_address', tokenAddress)
        .single();

    if (!token) return;

    // 2. Add the new trade to the rolling total
    const newBuyCount = isBuy ? (token.buy_count || 0) + 1 : (token.buy_count || 0);
    const newSellCount = !isBuy ? (token.sell_count || 0) + 1 : (token.sell_count || 0);
    const newVolume = (token.volume_eth || 0) + ethVolume;

    // 3. Calculate percentages
    const totalTrades = newBuyCount + newSellCount;
    const buyPct = totalTrades > 0 ? Math.round((newBuyCount / totalTrades) * 100) : 50;
    const sellPct = 100 - buyPct;

    // 4. Save it back to Supabase
    await supabase
        .from('launches')
        .update({
            volume_eth: newVolume,
            buy_count: newBuyCount,
            sell_count: newSellCount,
            buy_pct: buyPct,
            sell_pct: sellPct
        })
        .eq('token_address', tokenAddress);
}

async function runIndexer() {
    console.log("⚡ Vibe Signals Cloud Node Live...");

    // 1. THE LAUNCH CATCHER
    publicClient.watchEvent({
        address: FACTORY_ADDRESS,
        onLogs: async logs => {
            for (const log of logs) {
                if (log.topics[0] === CREATION_TOPIC && log.topics[1] && log.topics[2] && log.topics[3]) {
                    const launchId = parseInt(log.topics[1] as string, 16);
                    const devAddress = `0x${log.topics[2].slice(26)}`;
                    const tokenAddress = `0x${log.topics[3].slice(26)}`;
                    const ammAddress = `0x${log.data.slice(26, 66)}` as `0x${string}`;

                    const baseTokenHex = log.data.slice(282, 322);
                    const isNativeEth = baseTokenHex === "0000000000000000000000000000000000000000";

                    // Fetch real token name and ticker from the contract
                    let tokenName = `Token #${launchId}`;
                    let tokenSymbol = "TKN";
                    try {
                        tokenName = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "name" }) as string;
                        tokenSymbol = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "symbol" }) as string;
                    } catch (e) { console.log("⚠ Could not read token metadata"); }

                    console.log(`🚨 CLOUD SYNC: [#${launchId}] ${tokenName} ($${tokenSymbol})`);

                    await supabase.from('launches').upsert({
                        launch_id: launchId,
                        token_address: tokenAddress,
                        amm_address: ammAddress,
                        dev_address: devAddress,
                        pair_symbol: isNativeEth ? 'ETH' : 'STOCK',
                        liquidity_deposited: 0,
                        curve_progress: 0,
                        launch_block: Number(log.blockNumber),
                        name: tokenName,
                        symbol: tokenSymbol
                    }, { onConflict: 'token_address' });
                }
            }
        }
    });

    // 2. THE BUY MOMENTUM CATCHER
    const curveBuyEvent = parseAbiItem('event CurveBuy(address indexed token, address indexed buyer, uint256 bnbIn, uint256 tokensOut, uint256 fee, uint256 reserveAfter, uint256 soldAfter, uint256 timestamp)');

    publicClient.watchEvent({
        address: ROUTER_ADDRESS,
        event: curveBuyEvent,
        onLogs: async (logs) => {
            for (const log of logs) {
                const { token, bnbIn } = log.args;
                if (!token || !bnbIn) continue;

                const ethVolume = Number(formatEther(bnbIn as bigint));
                console.log(`🟢 BUY DETECTED: ${ethVolume.toFixed(4)} ETH on token ${token}`);

                await updateMomentumInDatabase(token, true, ethVolume);
            }
        }
    });

    // 3. THE LIVE BALANCE UPDATER (Runs every 10 seconds)
    setInterval(async () => {
        try {
            const { data: recentTokens } = await supabase.from('launches').select('*').order('launch_id', { ascending: false }).limit(20);
            if (!recentTokens) return;

            for (const token of recentTokens) {
                if (token.pair_symbol === 'ETH') {
                    const rawEth = await publicClient.getBalance({ address: token.amm_address as `0x${string}` });
                    const currentLiq = parseFloat(formatEther(rawEth));
                    const progress = Math.min(100, Math.max(0, (currentLiq / 4.0) * 100)); // Assuming 4 ETH target

                    // Only write to DB if the balance actually changed
                    if (currentLiq !== token.liquidity_deposited) {
                        await supabase.from('launches').update({
                            liquidity_deposited: Number(currentLiq.toFixed(4)),
                            curve_progress: Number(progress.toFixed(1))
                        }).eq('launch_id', token.launch_id);
                        console.log(`📈 CURVE UPDATE: $${token.symbol} is now at ${progress.toFixed(1)}%`);
                    }
                }
            }
        } catch (err) { }
    }, 10000);
}

runIndexer();

createServer((req: any, res: any) => res.end('Indexer is Live!')).listen(process.env.PORT || 3000);