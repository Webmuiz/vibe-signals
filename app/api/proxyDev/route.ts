import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address) return NextResponse.json({ error: 'Missing address' }, { status: 400 });

  try {
    const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };
    const targetDev = address.toLowerCase();

    // 1. Fetch both legacy and v6 lists
    const [legacyRes, v6Res] = await Promise.allSettled([
      fetch(`https://testnet.vibevibe.fun/api/v1/chains/46630/launches?creatorAddress=${address}&limit=50`, { headers, cache: 'no-store' }),
      fetch(`https://testnet.vibevibe.fun/api/v1/chains/46630/v6/wallets/${address}/launches?limit=50`, { headers, cache: 'no-store' })
    ]);

    let combinedItems: any[] = [];
    if (legacyRes.status === 'fulfilled' && legacyRes.value.ok) {
      const legacyData = await legacyRes.value.json();
      if (legacyData?.data?.items) combinedItems = [...combinedItems, ...legacyData.data.items];
    }
    if (v6Res.status === 'fulfilled' && v6Res.value.ok) {
      const v6Data = await v6Res.value.json();
      if (v6Data?.data?.items) combinedItems = [...combinedItems, ...v6Data.data.items];
    }

    // Deduplicate by tokenAddress
    const deduplicated = Array.from(new Map(combinedItems.map((item) => [item.tokenAddress.toLowerCase(), item])).values());

    // Filter strictly to tokens this wallet actually CREATED
    const createdTokens = deduplicated.filter((item: any) => {
      const launcher = (item.launcherAddress || item.creatorAddress || "").toLowerCase();
      return launcher === targetDev;
    });

    // 2. DEEP-SCAN ENGINE: Scan orderbooks of created tokens
    const recentLaunches = createdTokens.slice(0, 15);
    const deepScanPromises = recentLaunches.map(async (item) => {
       try {
         // Attempt v6 first
         let marketRes = await fetch(`https://testnet.vibevibe.fun/api/v1/chains/46630/v6/launches/${item.tokenAddress}/market?limit=100`, { headers, cache: 'no-store' });
         
         // If not found in v6, fall back to legacy (for tokens like $TYSON)
         if (!marketRes.ok) {
            marketRes = await fetch(`https://testnet.vibevibe.fun/api/v1/chains/46630/launches/${item.tokenAddress}/market?limit=100`, { headers, cache: 'no-store' });
         }
         
         if (marketRes.ok) {
            const marketData = await marketRes.json();
            const trades = marketData?.data?.trades || [];
            
            let devDumpedEarly = false;
            let dumpVolumeEth = 0;
            
            trades.forEach((ev: any) => {
               // Catch every possible actor naming convention across legacy/v6
               const actor = (ev.actorAddress || ev.maker || ev.userAddress || ev.walletAddress || ev.who || ev.actor || "").toLowerCase();
               const isSell = ev.side === 'SELL' || ev.isBuy === false || ev.type === 'SELL';
               
               if (actor === targetDev && isSell) {
                  devDumpedEarly = true;
                  const dumpAmount = Number(ev.ethAmount || ev.quoteAmount || ev.pairPrincipalUnits || ev.eth || 0);
                  // Ensure we don't divide by 1e18 if it's already a clean decimal from legacy API
                  dumpVolumeEth += (dumpAmount > 1000) ? (dumpAmount / 1e18) : dumpAmount;
               }
            });
            return { ...item, dumperMetrics: { devDumpedEarly, dumpVolumeEth } };
         }
         return { ...item, dumperMetrics: { devDumpedEarly: false, dumpVolumeEth: 0 } };
       } catch { return { ...item, dumperMetrics: { devDumpedEarly: false, dumpVolumeEth: 0 } }; }
    });

    const scannedLaunches = await Promise.all(deepScanPromises);

    // 3. Aggregate Lifetime Metrics on created tokens only
    let totalPreGradDumps = 0;
    let totalDumpVolumeEth = 0;

    scannedLaunches.forEach((launch) => {
      if (launch.dumperMetrics?.devDumpedEarly) {
        totalPreGradDumps += 1;
        totalDumpVolumeEth += launch.dumperMetrics.dumpVolumeEth;
      }
    });

    const totalLaunches = createdTokens.length;
    const graduatedCount = createdTokens.filter((item: any) => item.lifecycle === "GRADUATED" || item.graduated === true || item.curve?.lifecycle === "GRADUATED").length;

    return NextResponse.json({
      data: {
        items: [...scannedLaunches, ...createdTokens.slice(15)],
        profiler: {
          totalLaunches,
          graduatedCount,
          graduationRate: totalLaunches > 0 ? Math.round((graduatedCount / totalLaunches) * 100) : 0,
          totalPreGradDumps,
          totalDumpVolumeEth,
          isSerialDumper: totalPreGradDumps >= 1 || (totalLaunches >= 3 && (graduatedCount / totalLaunches) < 0.15)
        },
        page: { totalCount: totalLaunches }
      }
    });
  } catch (err) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}