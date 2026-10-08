import { NextResponse } from 'next/server';
import { createPublicClient, http } from 'viem';

const robinhoodTestnet = {
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
} as const;

const publicClient = createPublicClient({
  chain: robinhoodTestnet,
  transport: http()
});

let cachedResponse: any = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 15000;

export async function GET() {
  try {
    const now = Date.now();
    if (cachedResponse && (now - lastCacheTime) < CACHE_TTL_MS) {
      return NextResponse.json(cachedResponse);
    }

    const [pairsRes, ethRes] = await Promise.all([
      fetch('https://testnet.vibevibe.fun/api/v1/chains/46630/v6/pair-prices', {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        cache: 'no-store'
      }),
      fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { cache: 'no-store' })
    ]);

    if (!pairsRes.ok) return NextResponse.json({ error: 'Failed to fetch pair prices' }, { status: pairsRes.status });
    const data = await pairsRes.json();

    let ethPriceUsd = 2416;
    if (ethRes.ok) {
      const cbData = await ethRes.json();
      if (cbData?.data?.amount) ethPriceUsd = Number(cbData.data.amount);
    }

    const items = data?.data?.items || [];
    
    // Resolve on-chain symbols for all pairs in one RPC multicall
    const symbolCalls = items.map((item: any) => ({
      address: item.pairAddress as `0x${string}`,
      abi: [{ name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const,
      functionName: 'symbol',
    }));

    let symbols: readonly any[] = [];
    try {
      symbols = await publicClient.multicall({ contracts: symbolCalls, allowFailure: true });
    } catch (e) {
      console.error('Multicall symbol resolution failed:', e);
    }

    const rates: Record<string, number> = {
      ETH: ethPriceUsd,
      WETH: ethPriceUsd,
      '0x0000000000000000000000000000000000000000': ethPriceUsd
    };

    items.forEach((item: any, i: number) => {
      const resolvedSym = symbols[i]?.status === 'success' ? (symbols[i].result as string).toUpperCase() : null;
      if (resolvedSym) item.symbol = resolvedSym;

      const priceEth = Number(item.priceEthWad || 0) / 1e18;
      const priceUsd = priceEth * ethPriceUsd;
      item.priceUsd = priceUsd;

      if (item.pairAddress) {
        rates[item.pairAddress.toLowerCase()] = priceUsd;
      }
      if (resolvedSym) {
        rates[resolvedSym] = priceUsd;
      }
    });

    if (data && data.data) {
      data.data.ethPriceUsd = ethPriceUsd;
      data.data.rates = rates;
    }

    cachedResponse = data;
    lastCacheTime = now;

    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
