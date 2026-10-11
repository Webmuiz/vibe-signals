// Pure, framework-agnostic helpers for token display metrics.
// Extracted from app/page.tsx so both the page and UI components can share them.

export function shortenAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Formats a numeric USD value into a clean, compact string using K (thousands),
 * M (millions) and B (billions) suffixes, e.g. 16800 -> "$16.8K", 1200000 -> "$1.2M".
 *
 * Accepts either a raw number or a pre-formatted currency string (e.g. "$16,800.00"
 * or "16800") so it can be applied directly to values coming from the API layer.
 *
 * Rules:
 *  - Values below 1,000 keep their cents (e.g. "$842.50").
 *  - Values >= 1,000 are suffixed and trimmed to at most one decimal place.
 *  - Non-finite / unparseable input falls back to "$0.00".
 */
export function formatCompactUsd(value: number | string | null | undefined): string {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.replace(/[^0-9.-]/g, ''))
        : NaN;

  if (!Number.isFinite(numeric)) return '$0.00';

  const sign = numeric < 0 ? '-' : '';
  const abs = Math.abs(numeric);

  if (abs < 1_000) {
    return `${sign}$${abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  const units: Array<{ threshold: number; suffix: string }> = [
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' },
  ];

  const { threshold, suffix } = units.find((u) => abs >= u.threshold)!;
  const scaled = abs / threshold;

  // One decimal place, but drop a trailing ".0" for clean whole numbers.
  const formatted = scaled.toFixed(1).replace(/\.0$/, '');

  return `${sign}$${formatted}${suffix}`;
}

/**
 * Canonical, normalized market metrics for a single token.
 * This is the SINGLE SOURCE OF TRUTH consumed by both the homepage
 * TokenCard grid and the "Analyse Alpha" detail view.
 */
export interface LiveTokenMetrics {
  contractAddress: string;
  name: string;
  ticker: string;
  symbol: string;
  pairSymbol: string;
  bondingCurveProgress: number;
  ethDeposited: string;
  marketCapUsd: string;
  marketCapRaw: number;
  volumeEth: string;
  volumeUsd: string;
  buyPct: number;
  sellPct: number;
  priceUsd: number;
  hasSocials: boolean;
  socialLinks: Record<string, string>;
  devAddress: string;
  ammAddress: string;
  timeSinceLaunchMins: number;
  isGraduated: boolean;
  imageUri?: string;
  isLegacy: boolean;
}

/**
 * Raw shape of the `/api/proxyVibe` JSON payload (loosely typed on purpose —
 * the upstream VibeVibe API is versioned and fields vary across v5/v6/legacy).
 */
export interface RawVibeResponse {
  apiVersion?: string;
  data?: {
    launch?: any;
    tokenAddress?: string;
    feeEvents?: any[];
    marketStats?: any;
    marketTrades?: any[];
    ethPriceUsd?: number;
    [key: string]: any;
  };
  [key: string]: any;
}

const ERC20_SYMBOL_ABI = [
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

/**
 * Classification of the asset a token is quoted/priced against.
 *
 * VibeVibe launches can be paired against several distinct quote assets:
 *  - `native`  : raw ETH / WETH (the default bonding-curve pair).
 *  - `usd`     : a USD stable (USDG, USDC, ...) — 1:1 with USD.
 *  - `stock`   : a tokenized equity (NVDA, AAPL, SPCX, MSFT, TSLA, ...).
 *  - `guild`   : a VibeVibe Guild / community token (e.g. ALPHAHUNTERGUILD).
 *  - `vibe`    : the platform VIBE/VIBEVIBE token.
 *  - `unknown` : an unrecognised non-ETH quote asset.
 *
 * The distinction matters because pair reserves are denominated in the QUOTE
 * asset, so they may only be multiplied by that asset's own USD rate — never
 * blindly by the ETH oracle price.
 */
export type QuoteAssetKind = 'native' | 'usd' | 'stock' | 'guild' | 'vibe' | 'unknown';

const NATIVE_QUOTE_SYMBOLS = new Set(['ETH', 'WETH', 'NATIVE']);
const USD_QUOTE_SYMBOLS = new Set(['USD', 'USDC', 'USDT', 'USDG', 'DAI', 'STOCK']);
const VIBE_QUOTE_SYMBOLS = new Set(['VIBE', 'VIBEVIBE']);
const STOCK_QUOTE_SYMBOLS = new Set(['NVDA', 'AAPL', 'SPCX', 'MSFT', 'TSLA', 'AMZN', 'GOOG', 'META']);

/**
 * Classifies a quote asset from its resolved symbol and/or on-chain address.
 * Address-only hints (the zero address) are treated as native ETH.
 */
export function classifyQuoteAsset(
  pairSymbol: string | undefined,
  pairAddress?: string
): QuoteAssetKind {
  const addr = (pairAddress || '').toLowerCase();
  if (addr === '0x0000000000000000000000000000000000000000') return 'native';

  const s = (pairSymbol || '').toUpperCase().trim();
  if (!s) return 'unknown';

  if (NATIVE_QUOTE_SYMBOLS.has(s)) return 'native';
  if (USD_QUOTE_SYMBOLS.has(s)) return 'usd';
  if (VIBE_QUOTE_SYMBOLS.has(s)) return 'vibe';
  if (STOCK_QUOTE_SYMBOLS.has(s)) return 'stock';

  // Heuristic: anything ending in "GUILD" is a community/guild quote token.
  if (s.endsWith('GUILD')) return 'guild';

  return 'unknown';
}

/**
 * Resolves the USD price of ONE unit of the quote asset.
 *
 * Returns `null` when the quote asset is non-ETH and no trustworthy USD rate is
 * available — signalling to the caller that it must NOT fall back to the ETH
 * oracle (which would inflate a Guild/Stock-paired token's market cap into the
 * billions). Native ETH always resolves to the ETH oracle price.
 */
export function resolveQuoteUsdRate(
  kind: QuoteAssetKind,
  pairSymbol: string | undefined,
  pairAddress: string | undefined,
  liveRates: Record<string, number>,
  ethPriceUsd: number
): number | null {
  const addr = (pairAddress || '').toLowerCase();
  const sym = (pairSymbol || '').toUpperCase().trim();

  // 1. Exact address match from the oracle map is always authoritative.
  if (addr && liveRates[addr] != null && Number.isFinite(liveRates[addr])) {
    return liveRates[addr];
  }

  // 2. Exact symbol match from the oracle map.
  if (sym && liveRates[sym] != null && Number.isFinite(liveRates[sym])) {
    return liveRates[sym];
  }

  // 3. Native ETH/WETH always uses the ETH oracle.
  if (kind === 'native') return ethPriceUsd;

  // 4. USD stables are 1:1.
  if (kind === 'usd') return 1;

  // 5. Non-ETH quote asset with no known rate: refuse to guess.
  //    Returning null forces the caller to use the token's direct USD price.
  return null;
}

/**
 * Normalizes a raw `/api/proxyVibe` response into a single canonical
 * `LiveTokenMetrics` object. Both the homepage card and the detail view
 * MUST derive their displayed numbers from this function so they can never
 * disagree.
 *
 * @param json       Raw JSON returned by `/api/proxyVibe`.
 * @param liveRates  Global oracle rates (symbol/address -> USD).
 * @param fallback   Optional prior token state to fill gaps (e.g. name/ticker).
 * @param resolveSymbol  Optional async resolver for on-chain pair symbols.
 */
export async function normalizeVibeResponse(
  json: RawVibeResponse,
  liveRates: Record<string, number>,
  fallback?: Partial<LiveTokenMetrics> & { contractAddress?: string },
  resolveSymbol?: (address: string) => Promise<string | null>
): Promise<LiveTokenMetrics> {
  const launch = json?.data?.launch || (json?.data?.tokenAddress ? json.data : null) || {};
  const stats = json?.data?.marketStats;
  const feeEvents = json?.data?.feeEvents || [];

  // --- Degraded-payload guard ---
  // If the proxy returned an error object (no `data`), or a `data` block with
  // no launch/token identity, we must NOT synthesize zeros. Instead, preserve
  // the caller's last-known-good fallback so the UI keeps showing real numbers.
  const hasUsableData = !!(json?.data && (json.data.launch || json.data.tokenAddress));
  if (!hasUsableData && fallback) {
    return {
      contractAddress: (fallback.contractAddress || '').toLowerCase(),
      name: fallback.name || 'Unknown',
      ticker: fallback.ticker || 'TKN',
      symbol: fallback.symbol || '',
      pairSymbol: fallback.pairSymbol || 'ETH',
      bondingCurveProgress: fallback.bondingCurveProgress ?? 0,
      ethDeposited: fallback.ethDeposited || '0.0000 / 4.0',
      marketCapUsd: fallback.marketCapUsd || '$0.00',
      marketCapRaw: fallback.marketCapRaw ?? 0,
      volumeEth: fallback.volumeEth || '0.0000',
      volumeUsd: fallback.volumeUsd || '$0.00',
      buyPct: fallback.buyPct ?? 50,
      sellPct: fallback.sellPct ?? 50,
      priceUsd: fallback.priceUsd ?? 0,
      hasSocials: fallback.hasSocials ?? false,
      socialLinks: fallback.socialLinks || {},
      devAddress: fallback.devAddress || '',
      ammAddress: fallback.ammAddress || '',
      timeSinceLaunchMins: fallback.timeSinceLaunchMins ?? 0,
      isGraduated: fallback.isGraduated ?? false,
      imageUri: fallback.imageUri,
      isLegacy: fallback.isLegacy ?? false,
    };
  }

  const contractAddress = (launch.tokenAddress || fallback?.contractAddress || '').toLowerCase();

  // --- Pair symbol resolution ---
  let pairSymbol: string = launch.pairSymbol || fallback?.pairSymbol || '';
  if (!pairSymbol) {
    if (launch.pairIsNative || launch.pairCurrencyAddress === '0x0000000000000000000000000000000000000000') {
      pairSymbol = 'ETH';
    } else if (launch.pairCurrencyAddress && resolveSymbol) {
      pairSymbol = (await resolveSymbol(launch.pairCurrencyAddress)) || 'TOKEN';
    } else {
      pairSymbol = 'ETH';
    }
  }

  // --- Decimals for synthetic pairs (e.g. USDG = 6) ---
  const targetRaw = Number(launch.targetPairUnits || launch.curve?.netTargetWei || 4e18);
  const currentRaw = Number(launch.curve?.pairReserveUnits || launch.curve?.netRaisedWei || 0);
  const pDecimals = targetRaw > 0 && targetRaw < 1e14 ? 6 : 18;
  const pDivisor = Math.pow(10, pDecimals);

  // --- Graduation detection ---
  const isGraduated =
    launch.lifecycle === 'GRADUATED' ||
    launch.graduated === true ||
    launch.curve?.lifecycle === 'GRADUATED' ||
    !!launch.graduation ||
    !!launch.poolAddress ||
    !!launch.graduationPoolAddress ||
    !!launch.pool?.address ||
    (fallback?.bondingCurveProgress ?? 0) >= 100;

  const currentPairUnits = currentRaw / pDivisor;
  const targetPairUnits = targetRaw / pDivisor;

  let bondingCurveProgress = isGraduated
    ? 100
    : launch.curve?.progressBps != null
      ? launch.curve.progressBps / 100
      : Math.min(100, Math.max(0, (currentPairUnits / targetPairUnits) * 100));
  if (!isGraduated && bondingCurveProgress > 0 && bondingCurveProgress < 0.1) {
    bondingCurveProgress = 0.1;
  }
  const ethDeposited = isGraduated
    ? 'Graduated'
    : `${currentPairUnits.toFixed(4)} / ${targetPairUnits.toFixed(1)}`;

  // --- Quote-asset classification + USD rate for the pair ---
  // Pair reserves are denominated in the QUOTE asset, so they may only be
  // multiplied by that asset's own USD rate. Blindly using the ETH oracle for a
  // Guild/Stock-paired token inflates its market cap into the billions.
  const liveEthPrice = Number(json?.data?.ethPriceUsd) || liveRates['ETH'] || 2416;
  const pairAddr = (launch.pairCurrencyAddress || '').toLowerCase();
  const quoteKind = classifyQuoteAsset(pairSymbol, pairAddr);

  // `quoteUsdRate` is `null` when the quote asset is non-ETH and has no known
  // USD rate — in that case we must rely on the token's direct USD price.
  const quoteUsdRate = resolveQuoteUsdRate(
    quoteKind,
    pairSymbol,
    pairAddr,
    { ...liveRates, ETH: liveEthPrice, WETH: liveEthPrice },
    liveEthPrice
  );

  // --- Market cap (real price first, synthetic only as last resort) ---
  const directPriceUsd =
    launch.priceUsd || launch.analytics?.priceUsd || launch.curve?.priceUsd || stats?.priceUsd;
  let lastPriceWei =
    stats?.priceWeiPerToken || stats?.lastPriceWeiPerToken || launch.analytics?.lastPriceWeiPerToken || 0;
  if ((!lastPriceWei || Number(lastPriceWei) === 0) && json?.data?.marketTrades?.[0]) {
    lastPriceWei = json.data.marketTrades[0].executionPricePairUnitsPerToken;
  }

  let marketCapRaw = 0;
  let priceUsd = 0;
  if (directPriceUsd && Number(directPriceUsd) > 0) {
    // Preferred path: the API already gives us the token's direct USD price.
    priceUsd = Number(directPriceUsd);
    marketCapRaw = priceUsd * 1_000_000_000;
  } else if (Number(lastPriceWei) > 0 && quoteUsdRate != null && quoteUsdRate > 0) {
    // Pair-denominated price × the QUOTE asset's own USD rate.
    const pricePairUnits = Number(lastPriceWei) / pDivisor;
    priceUsd = pricePairUnits * quoteUsdRate;
    marketCapRaw = pricePairUnits * 1_000_000_000 * quoteUsdRate;
  } else if (Number(lastPriceWei) > 0 && quoteUsdRate == null) {
    // Non-ETH quote asset with no trustworthy USD rate: we deliberately do NOT
    // multiply by the ETH oracle. Leave priceUsd at 0 so the caller flags this
    // as an estimate rather than reporting a wildly inflated market cap.
    priceUsd = 0;
    marketCapRaw = 0;
  } else {
    // Explicit synthetic estimate — flagged by the caller via `priceUsd === 0`.
    marketCapRaw = calculateTokenMetrics(bondingCurveProgress, currentPairUnits, pairSymbol, liveRates).marketCapRaw;
  }

  const marketCapUsd =
    marketCapRaw > 0
      ? marketCapRaw.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
      : '$0.00';

  // --- Volume + buy/sell momentum ---
  let volumeEth = '0.0000';
  let buyPct = 50;
  let sellPct = 50;

  if (stats) {
    const buyVol = Number(stats.buyVolume24hPairUnits || 0) / pDivisor;
    const sellVol = Number(stats.sellVolume24hPairUnits || 0) / pDivisor;
    const totalVol = buyVol + sellVol;
    if (totalVol > 0) {
      volumeEth = totalVol.toFixed(4);
      buyPct = Math.round((buyVol / totalVol) * 100);
      sellPct = 100 - buyPct;
    }
  } else if (launch.analytics) {
    const volWei = Number(launch.analytics.volume24hWei || 0);
    if (volWei > 0) volumeEth = (volWei / pDivisor).toFixed(4);
    const buys = Number(launch.analytics.buyCount1h || 0);
    const sells = Number(launch.analytics.sellCount1h || 0);
    const totalTrades = buys + sells;
    if (totalTrades > 0) {
      buyPct = Math.round((buys / totalTrades) * 100);
      sellPct = 100 - buyPct;
    }
  } else if (feeEvents.length > 0) {
    let buyVolume = 0;
    let sellVolume = 0;
    feeEvents.forEach((ev: any) => {
      const eth = Number(ev.pairPrincipalUnits || 0) / 1e18;
      if (ev.side === 'BUY' || ev.source === 'CURVE_BUY' || ev.source === 'INITIAL_PURCHASE') {
        buyVolume += eth;
      } else if (ev.side === 'SELL' || ev.source === 'CURVE_SELL') {
        sellVolume += eth;
      }
    });
    const totalVol = buyVolume + sellVolume;
    if (totalVol > 0) {
      volumeEth = totalVol.toFixed(4);
      buyPct = Math.round((buyVolume / totalVol) * 100);
      sellPct = 100 - buyPct;
    }
  }

  // Volume is denominated in the QUOTE asset, so it may only be converted with
  // that asset's own USD rate. When the rate is unknown (non-ETH pair), we show
  // the raw pair-denominated figure instead of a bogus ETH-priced USD value.
  const volumeUsd =
    Number(volumeEth) > 0 && quoteUsdRate != null && quoteUsdRate > 0
      ? (Number(volumeEth) * quoteUsdRate).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
      : Number(volumeEth) > 0
        ? `${volumeEth} ${pairSymbol}`
        : '$0.00';

  // --- Socials ---
  const socials = launch.content?.socials || {};
  const hasSocials = !!(socials.x || socials.telegram || socials.website);

  // --- Time live ---
  const createdMs = new Date(launch.createdAt || Date.now()).getTime();
  const timeSinceLaunchMins = isNaN(createdMs)
    ? fallback?.timeSinceLaunchMins ?? 0
    : Math.max(0, Math.floor((Date.now() - createdMs) / 60000));

  const imageUri = launch.content?.image?.uri?.startsWith('ipfs://')
    ? launch.content.image.uri.replace('ipfs://', 'https://ipfs.io/ipfs/')
    : launch.content?.image?.uri;

  return {
    contractAddress,
    name: launch.name || fallback?.name || 'Unknown',
    ticker: launch.symbol || fallback?.ticker || 'TKN',
    symbol: launch.symbol || fallback?.symbol || '',
    pairSymbol,
    bondingCurveProgress,
    ethDeposited,
    marketCapUsd,
    marketCapRaw,
    volumeEth,
    volumeUsd,
    buyPct,
    sellPct,
    priceUsd,
    hasSocials,
    socialLinks: socials,
    devAddress: launch.launcherAddress || launch.creatorAddress || fallback?.devAddress || '',
    ammAddress: launch.curveAddress || fallback?.ammAddress || '',
    timeSinceLaunchMins,
    isGraduated,
    imageUri,
    isLegacy: json?.apiVersion === '1' || (!json?.data?.launch && !!json?.data?.tokenAddress),
  };
}

export { ERC20_SYMBOL_ABI };

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
