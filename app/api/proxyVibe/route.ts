import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const address = searchParams.get('address');

    if (!address) {
        return NextResponse.json({ error: 'Address is required' }, { status: 400 });
    }

    try {
        const targetUrl = `https://testnet.vibevibe.fun/api/v1/chains/46630/v6/launches/${address}`;
        const res = await fetch(targetUrl, {
            cache: 'no-store',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        });

        if (!res.ok) {
            return NextResponse.json({ error: 'Failed to fetch token from VibeVibe API' }, { status: res.status });
        }

        const data = await res.json();
        
        const marketRes = await fetch(`https://testnet.vibevibe.fun/api/v1/chains/46630/v6/launches/${address}/market?limit=2`, {
            cache: 'no-store',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        });
        
        const marketData = marketRes.ok ? await marketRes.json() : null;
        if (data && data.data) {
            data.data.marketStats = marketData?.data?.stats || null;
            data.data.marketTrades = marketData?.data?.trades || [];
        }

        return NextResponse.json(data);
    } catch (error) {
        console.error("Proxy VibeVibe API error:", error);
        return NextResponse.json({ error: 'Failed to fetch from VibeVibe API' }, { status: 500 });
    }
}
