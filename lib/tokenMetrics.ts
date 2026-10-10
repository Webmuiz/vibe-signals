// Pure, framework-agnostic helpers for token display metrics.
// Extracted from app/page.tsx so both the page and UI components can share them.

export function shortenAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatTimeLive(totalMinutes: number) {
  if (!totalMinutes && totalMinutes !== 0) return '0m';
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = Math.floor(totalMinutes % 60);

  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  return `${hours}h ${mins}m`;
}

export function getUsdRateForPair(symbol: string | undefined, liveRates: Record<string, number>): number {
  if (!symbol) return liveRates['ETH'] || 2416;
  const s = symbol.toUpperCase();

  if (s.includes('USD') && !s.includes('ETH')) return 1;
  if (liveRates[s]) return liveRates[s];
  if (s === 'ETH' || s === 'WETH') return liveRates['ETH'] || 2416;

  return liveRates['ETH'] || 2416;
}

export function calculateTokenMetrics(
  bondingCurveProgress: number,
  ethDeposited: number | string,
  pairSymbol: string = 'ETH',
  liveRates: Record<string, number>,
  lastPriceWeiPerToken?: number | string
) {
  const usdRate = getUsdRateForPair(pairSymbol, liveRates);

  if (lastPriceWeiPerToken && Number(lastPriceWeiPerToken) > 0) {
    const pricePairUnits = Number(lastPriceWeiPerToken) / 1e18;
    const mcUsd = usdRate > 0 ? pricePairUnits * 1_000_000_000 * usdRate : 0;
    return {
      marketCapFormatted: mcUsd > 0 ? mcUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '$0.00',
      marketCapRaw: mcUsd
    };
  }

  const progress = Math.min(100, Math.max(0, Number(bondingCurveProgress || 0)));
  const sym = (pairSymbol || 'ETH').toUpperCase();

  let gradUsd = 50500;
  let baseUsd = 4000;
  if (sym === 'VIBEVIBE' || sym === 'VIBE') {
    gradUsd = 220000; // Vibe-paired tokens have higher USD graduation targets
    baseUsd = 15000;
  }

  const currentUsd = progress >= 100
    ? gradUsd
    : baseUsd + ((gradUsd - baseUsd) * Math.pow(progress / 100, 1.45));

  return {
    marketCapFormatted: currentUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
    marketCapRaw: currentUsd
  };
}
