import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const [pairsRes, ethRes] = await Promise.all([
      fetch('https://testnet.vibevibe.fun/api/v1/chains/46630/v6/pair-prices', {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        cache: 'no-store'
      }),
      fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { cache: 'no-store' })
    ]);

    if (!pairsRes.ok) return NextResponse.json({ error: 'Failed to fetch pair prices' }, { status: pairsRes.status });
    const data = await pairsRes.json();
    
    let ethPriceUsd = 2600;
    if (ethRes.ok) {
      const cbData = await ethRes.json();
      if (cbData?.data?.amount) ethPriceUsd = Number(cbData.data.amount);
    }

    if (data && data.data) data.data.ethPriceUsd = ethPriceUsd;
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
