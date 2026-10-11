import { createServer } from 'http';
import 'dotenv/config';
import { createPublicClient, http, defineChain, formatEther, parseAbiItem } from 'viem';
import { createClient } from '@supabase/supabase-js';

process.on('uncaughtException', (err) => {
  console.error('Unhandled Exception trapped:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection trapped:', reason);
});

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
    id: 46630,
    name: 'Robinhood Testnet',
    network: 'robinhood-testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
});

const publicClient = createPublicClient({ chain: robinhoodTestnet, transport: http() });

const FACTORY_ADDRESS = "0xe794217880011f9cA6961340eD5c16EC9559Fea0";
const ROUTER_ADDRESS = "0x89944BC9D3b20764BeA771CFAf9711a8Fb839e72";
const CREATION_TOPIC = "0xa7e8032bfd07a9fbcde50eabe91eb2901faee6dbddd9cced579491d9b07ef5c8";

// Base URL for our own proxy route. Overridable via env so the indexer can
// point at localhost during development or the deployed app in production.
const PROXY_BASE_URL = process.env.PROXY_BASE_URL || 'https://vibe-signals.vercel.app';

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
        console.log(`⚠ Could not fetch live API metrics for ${tokenAddress}`);
        return null;
    }
}

// --- DB HELPER FUNCTION ---
async function updateMomentumInDatabase(tokenAddress: string, isBuy: boolean, ethVolume: number, txBlockNumber: number, buyerAddress: string) {
    // 1. Fetch current momentum data for this token
    const { data: token } = await supabase
        .from('launches')
        .select('volume_eth, buy_count, sell_count, launch_block, block_zero_buyers, dev_address')
        .eq('token_address', tokenAddress.toLowerCase())
        .single();

    if (!token) return;

    let newBlockZeroBuyers = token.block_zero_buyers || 0;
    if (isBuy && token.launch_block && txBlockNumber === token.launch_block) {
        // Filter out the developer's pre-buy
        if (buyerAddress.toLowerCase() !== (token.dev_address || "").toLowerCase()) {
            newBlockZeroBuyers += 1;
            console.log(`🎯 SNIPER DETECTED: Block 0 buy by ${buyerAddress} on ${tokenAddress}`);
        }
    }

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
            sell_pct: sellPct,
            block_zero_buyers: newBlockZeroBuyers
        })
        .eq('token_address', tokenAddress.toLowerCase());
}

async function runIndexer() {
    console.log("⚡ Vibe Signals Cloud Node Live...");

    // 1. THE LAUNCH CATCHER
    publicClient.watchEvent({
        address: FACTORY_ADDRESS,
        onLogs: async logs => {
            for (const log of logs) {
                try {
                    if (log.topics[0] === CREATION_TOPIC && log.topics[1] && log.topics[2] && log.topics[3]) {
                        const launchId = parseInt(log.topics[1] as string, 16);
                        const devAddress = `0x${log.topics[2].slice(26)}`.toLowerCase();
                        const tokenAddress = `0x${log.topics[3].slice(26)}`.toLowerCase();
                        const ammAddress = `0x${log.data.slice(26, 66)}`.toLowerCase() as `0x${string}`;

                        const baseTokenHex = log.data.slice(282, 322);
                        const isNativeEth = baseTokenHex === "0000000000000000000000000000000000000000";

                        // Fetch real token name and ticker from the contract
                        let tokenName = `Token #${launchId}`;
                        let tokenSymbol = "TKN";
                        try {
                            tokenName = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "name" }) as string;
                            tokenSymbol = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "symbol" }) as string;
                        } catch (e) { console.log("⚠ Could not read token metadata"); }

                        // 2-second delay to let VibeVibe's off-chain DB catch up,
                        // then pull REAL market data (socials, market cap, volume).
                        await new Promise(r => setTimeout(r, 2000));
                        const live = await fetchLiveApiMetrics(tokenAddress);

                        const hasSocials = live?.hasSocials ?? false;
                        if (hasSocials) console.log(`🔗 Socials verified for ${tokenSymbol}`);

                        console.log(`🚨 CLOUD SYNC: [#${launchId}] ${tokenName} ($${tokenSymbol})`);

                        await supabase.from('launches').upsert({
                            launch_id: launchId,
                            token_address: tokenAddress,
                            amm_address: ammAddress,
                            dev_address: devAddress,
                            pair_symbol: live?.pairSymbol || (isNativeEth ? 'ETH' : 'STOCK'),
                            liquidity_deposited: live?.liquidityDeposited ?? 0,
                            curve_progress: live?.curveProgress ?? 0,
                            launch_block: Number(log.blockNumber),
                            name: tokenName,
                            symbol: tokenSymbol,
                            has_socials: hasSocials,
                            // Backfill real market data so Supabase converges with the API.
                            cachedMarketCapFormatted: live?.marketCapFormatted ?? null,
                            volume_eth: live?.volumeEth ?? 0,
                        }, { onConflict: 'token_address' });
                    }
                } catch (logErr) {
                    console.error('Error processing log event:', logErr);
                }
            }
        },
        onError: (error) => {
            console.error('Factory watchEvent error (RPC hiccup):', error);
        }
    });

    // 2. THE BUY MOMENTUM CATCHER
    const curveBuyEvent = parseAbiItem('event CurveBuy(address indexed token, address indexed buyer, uint256 tokensOut, uint256 bnbIn, uint256 fee, uint256 reserveAfter, uint256 soldAfter, uint256 timestamp)');

    publicClient.watchEvent({
        event: curveBuyEvent,
        onLogs: async (logs) => {
            for (const log of logs) {
                try {
                    const { token, bnbIn, buyer } = log.args;
                    if (!token || !bnbIn || !buyer) continue;
                    
                    const txBlockNumber = Number(log.blockNumber);
                    const ethVolume = Number(formatEther(bnbIn as bigint));
                    console.log(`🟢 BUY DETECTED: ${ethVolume.toFixed(4)} ETH on token ${token}`);
                    
                    await updateMomentumInDatabase(token.toLowerCase(), true, ethVolume, txBlockNumber, buyer as string);
                } catch (logErr) {
                    console.error('Error processing log event:', logErr);
                }
            }
        },
        onError: (error) => {
            console.error('Router watchEvent error (RPC hiccup):', error);
        }
    });

    // 3. THE LIVE BALANCE UPDATER (Runs every 10 seconds)
    setInterval(async () => {
        try {
            const { data: recentTokens } = await supabase.from('launches').select('*').order('launch_id', { ascending: false }).limit(20);
            if (!recentTokens) return;

            for (const token of recentTokens) {
                // Backfill REAL market data from the API for every recent token,
                // regardless of pair type, so Supabase converges with the live API.
                const live = await fetchLiveApiMetrics(token.token_address);
                const apiPayload: Record<string, any> = {};
                if (live) {
                    if (live.marketCapFormatted) apiPayload.cachedMarketCapFormatted = live.marketCapFormatted;
                    if (live.volumeEth != null) apiPayload.volume_eth = live.volumeEth;
                    if (live.hasSocials) apiPayload.has_socials = true;
                }

                if (token.pair_symbol === 'ETH') {
                    // 1. If already marked as graduated (>= 100%), still persist API data then skip.
                    if (Number(token.curve_progress) >= 100) {
                        if (Object.keys(apiPayload).length > 0) {
                            await supabase.from('launches').update(apiPayload).eq('launch_id', token.launch_id);
                        }
                        continue;
                    }

                    const rawEth = await publicClient.getBalance({ address: token.amm_address as `0x${string}` });
                    const currentLiq = parseFloat(formatEther(rawEth));
                    
                    // 2. If balance drops to 0 or was drained after accumulating liquidity, it graduated! Lock to 100%
                    if (currentLiq === 0 && Number(token.liquidity_deposited) >= 2.0) {
                        await supabase.from('launches').update({
                            ...apiPayload,
                            curve_progress: 100,
                            liquidity_deposited: 4.0
                        }).eq('launch_id', token.launch_id);
                        continue;
                    }

                    const progress = Math.min(100, Math.max(0, (currentLiq / 4.0) * 100));

                    // Only update if progress actually moved forward OR we have fresh API data
                    if (progress > Number(token.curve_progress || 0) || (token.volume_eth || 0) < currentLiq || Object.keys(apiPayload).length > 0) {
                        const updatePayload: any = {
                            ...apiPayload,
                            liquidity_deposited: Number(currentLiq.toFixed(4)),
                            curve_progress: Number(progress.toFixed(1))
                        };

                        // Only fall back to the balance heuristic when the API gave us no volume.
                        if (apiPayload.volume_eth == null && (!token.volume_eth || token.volume_eth < currentLiq)) {
                            updatePayload.volume_eth = Number(currentLiq.toFixed(4));
                            updatePayload.buy_pct = 100;
                            updatePayload.sell_pct = 0;
                        }

                        await supabase.from('launches').update(updatePayload).eq('launch_id', token.launch_id);
                        console.log(`📈 SYNC: $${token.symbol} liq: ${currentLiq.toFixed(4)} ETH (${progress.toFixed(1)}%)`);
                    }
                } else if (Object.keys(apiPayload).length > 0) {
                    // Non-ETH pairs: persist the API-derived market data.
                    await supabase.from('launches').update(apiPayload).eq('launch_id', token.launch_id);
                }
            }
        } catch (err) { }
    }, 10000);
}

runIndexer();

const PORT = Number(process.env.PORT) || 3000;
createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Vibe Signals Indexer is Live and Healthy!');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Health check listening on 0.0.0.0:${PORT}`);
});