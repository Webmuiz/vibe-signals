import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address) {
    return NextResponse.json({ error: 'Address is required' }, { status: 400 });
  }

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    };

    let data = null;
    let marketData = null;
    const paths = ['v6/launches', 'v5/launches', 'launches'];

    for (const path of paths) {
      const [launchRes, marketRes, ethRes] = await Promise.all([
        fetch(`https://testnet.vibevibe.fun/api/v1/chains/46630/${path}/${address}`, { headers, cache: 'no-store' }),
        fetch(`https://testnet.vibevibe.fun/api/v1/chains/46630/${path}/${address}/market?limit=2`, { headers, cache: 'no-store' }),
        fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { cache: 'no-store' })
      ]);

      if (launchRes.ok) {
        data = await launchRes.json();
        marketData = marketRes.ok ? await marketRes.json() : null;

        let ethPriceUsd = 2600;
        if (ethRes.ok) {
          const cbData = await ethRes.json();
          if (cbData?.data?.amount) ethPriceUsd = Number(cbData.data.amount);
        }

        if (data && data.data) {
          data.data.marketStats = marketData?.data?.stats || null;
          data.data.marketTrades = marketData?.data?.trades || [];
          data.data.ethPriceUsd = ethPriceUsd;
          data.data.apiVersion = path; // Optional: track which version succeeded
        }

        break; // Found the token, exit the loop
      }
    }

    if (!data) {
      return NextResponse.json({ error: 'Token not found across any API version' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Proxy VibeVibe API error:", error);
    return NextResponse.json({ error: 'Failed to fetch from VibeVibe API' }, { status: 500 });
  }
}
