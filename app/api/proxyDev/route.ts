import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address) return NextResponse.json({ error: 'Missing address' }, { status: 400 });

  try {
    const paths = ['v6/wallets', 'wallets'];
    let data: any = null;

    for (const p of paths) {
      const res = await fetch(`https://testnet.vibevibe.fun/api/v1/chains/46630/${p}/${address}/launches?limit=50`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        cache: 'no-store'
      });
      if (res.ok) {
        const json = await res.json();
        if (json?.data?.items && json.data.items.length > 0) {
          data = json;
          break;
        } else if (!data) {
          data = json; // Keep if empty, but keep checking
        }
      }
    }

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

    return NextResponse.json(data || { data: { items: [] } });
  } catch (err) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
