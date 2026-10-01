import 'dotenv/config';
import { createPublicClient, http, defineChain, formatEther } from 'viem';
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
const CREATION_TOPIC = "0xa7e8032bfd07a9fbcde50eabe91eb2901faee6dbddd9cced579491d9b07ef5c8";

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

    // 2. THE LIVE BALANCE UPDATER (Runs every 10 seconds)
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