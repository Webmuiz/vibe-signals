import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address) return NextResponse.json({ error: 'Missing address' }, { status: 400 });

  try {
    const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };

    // Fetch both the legacy creator list and the new v6 wallet list
    const [legacyRes, v6Res] = await Promise.allSettled([
      fetch(`https://testnet.vibevibe.fun/api/v1/chains/46630/launches?creatorAddress=${address}&limit=100`, { headers, cache: 'no-store' }),
      fetch(`https://testnet.vibevibe.fun/api/v1/chains/46630/v6/wallets/${address}/launches?limit=50`, { headers, cache: 'no-store' })
    ]);

    let combinedItems: any[] = [];

    // Parse Legacy Items
    if (legacyRes.status === 'fulfilled' && legacyRes.value.ok) {
      const legacyData = await legacyRes.value.json();
      if (legacyData?.data?.items) {
        combinedItems = [...combinedItems, ...legacyData.data.items];
      }
    } else if (legacyRes.status === 'fulfilled' && !legacyRes.value.ok) {
      console.error('Legacy fetch failed with status:', legacyRes.value.status);
    }

    // Parse v6 Items
    if (v6Res.status === 'fulfilled' && v6Res.value.ok) {
      const v6Data = await v6Res.value.json();
      if (v6Data?.data?.items) {
        combinedItems = [...combinedItems, ...v6Data.data.items];
      }
    } else if (v6Res.status === 'fulfilled' && !v6Res.value.ok) {
      console.error('v6 fetch failed with status:', v6Res.value.status);
    }

    // Deduplicate by tokenAddress just in case VibeVibe returns overlap
    const uniqueItems = Array.from(
      new Map(combinedItems.map((item) => [item.tokenAddress.toLowerCase(), item])).values()
    );

    return NextResponse.json({
      data: {
        items: uniqueItems,
        page: { totalCount: uniqueItems.length }
      }
    });

  } catch (err) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
