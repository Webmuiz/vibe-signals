import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const [pairsRes, binanceRes] = await Promise.all([
      fetch('https://testnet.vibevibe.fun/api/v1/chains/46630/v6/pair-prices', {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        cache: 'no-store'
      }),
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', { cache: 'no-store' })
    ]);

    if (!pairsRes.ok) return NextResponse.json({ error: 'Failed to fetch pair prices' }, { status: pairsRes.status });

    const data = await pairsRes.json();

    // Fetch real ETH price or safe fallback
    let ethPriceUsd = 2600;
    if (binanceRes.ok) {
      const binanceData = await binanceRes.json();
      if (binanceData.price) ethPriceUsd = Number(binanceData.price);
    }

    // Inject into the response so page.tsx can read json.data.ethPriceUsd
    if (data && data.data) {
      data.data.ethPriceUsd = ethPriceUsd;
    }

    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
