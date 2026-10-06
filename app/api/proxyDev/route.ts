import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address) return NextResponse.json({ error: 'Missing address' }, { status: 400 });

  try {
    const res = await fetch(
      `https://testnet.vibevibe.fun/api/v1/chains/46630/v6/wallets/${address}/launches?limit=50`,
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        },
        cache: 'no-store'
      }
    );
    if (!res.ok) return NextResponse.json({ error: 'Failed upstream fetch' }, { status: res.status });

    const data = await res.json();

    const marketRes = await fetch(`https://testnet.vibevibe.fun/api/v1/chains/46630/v6/launches/${address}/market?limit=2`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      cache: 'no-store'
    });
    const marketData = marketRes.ok ? await marketRes.json() : null;

    if (data && data.data) {
      data.data.marketStats = marketData?.data?.stats || null;
      data.data.marketTrades = marketData?.data?.trades || [];
    }
   
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
