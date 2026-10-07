import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address) return NextResponse.json({ error: 'Missing address' }, { status: 400 });

  try {
    const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };
    const targetDev = address.toLowerCase();

    // 1. Fetch all launches created by this wallet
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

    // Deduplicate and isolate tokens created by this wallet
    const deduplicated = Array.from(new Map(combinedItems.map((item) => [item.tokenAddress.toLowerCase(), item])).values());
    const createdTokens = deduplicated.filter((item: any) => {
      const launcher = (item.launcherAddress || item.creatorAddress || "").toLowerCase();
      return launcher === targetDev;
    });

    const createdTokenSet = new Set(createdTokens.map((t: any) => t.tokenAddress.toLowerCase()));
    const graduatedTokenSet = new Set(
      createdTokens
        .filter((item: any) => item.lifecycle === "GRADUATED" || item.graduated === true || item.curve?.lifecycle === "GRADUATED")
        .map((t: any) => t.tokenAddress.toLowerCase())
    );

    // 2. Fetch the Developer's Personal Activity Ledger (Immune to token trade volume)
    const [legacyActRes, v6ActRes] = await Promise.allSettled([
      fetch(`https://testnet.vibevibe.fun/api/v1/chains/46630/wallets/${address}/activity?limit=100`, { headers, cache: 'no-store' }),
      fetch(`https://testnet.vibevibe.fun/api/v1/chains/46630/v6/wallets/${address}/activity?limit=100`, { headers, cache: 'no-store' })
    ]);

    let walletEvents: any[] = [];
    if (legacyActRes.status === 'fulfilled' && legacyActRes.value.ok) {
      const legacyAct = await legacyActRes.value.json();
      if (legacyAct?.data?.items) walletEvents = [...walletEvents, ...legacyAct.data.items];
    }
    if (v6ActRes.status === 'fulfilled' && v6ActRes.value.ok) {
      const v6Act = await v6ActRes.value.json();
      if (v6Act?.data?.items) walletEvents = [...walletEvents, ...v6Act.data.items];
    }

    const uniqueWalletEvents = Array.from(
      new Map(walletEvents.map((ev: any) => [ev.id || `${ev.txHash}-${ev.logIndex}`, ev])).values()
    );

    // 3. Mathematical Verification: Detect sells on self-deployed tokens prior to graduation
    const dumpedTokenAddresses = new Set<string>();
    let totalDumpVolumeEth = 0;

    uniqueWalletEvents.forEach((ev: any) => {
      const isSell = ev.side === 'SELL' || ev.type === 'SELL';
      const tokenAddr = (ev.tokenAddress || "").toLowerCase();

      // Only evaluate if this sell was executed on a token THEY deployed
      if (isSell && createdTokenSet.has(tokenAddr)) {
        const isPreGraduation = ev.route === 'CURVE' || !graduatedTokenSet.has(tokenAddr);
        if (isPreGraduation) {
          dumpedTokenAddresses.add(tokenAddr);
          const ethWei = Number(ev.amountOutBaseUnits || ev.ethAmount || ev.pairPrincipalUnits || 0);
          totalDumpVolumeEth += (ethWei > 1000) ? (ethWei / 1e18) : ethWei;
        }
      }
    });

    const totalLaunches = createdTokens.length;
    const graduatedCount = graduatedTokenSet.size;
    const totalPreGradDumps = dumpedTokenAddresses.size;

    return NextResponse.json({
      data: {
        items: createdTokens,
        profiler: {
          totalLaunches,
          graduatedCount,
          graduationRate: totalLaunches > 0 ? Math.round((graduatedCount / totalLaunches) * 100) : 0,
          totalPreGradDumps,
          totalDumpVolumeEth,
          isSerialDumper: totalPreGradDumps > 0,
          dumpedTokens: Array.from(dumpedTokenAddresses)
        },
        page: { totalCount: totalLaunches }
      }
    });
  } catch (err) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}