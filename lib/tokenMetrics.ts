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

/**
 * Vibe Score v2 — transparent, weighted 0-100 launchpad token score.
 *
 * Formula:
 *   VibeScore = clamp( round( Base × TrustMultiplier × MomentumMultiplier − Penalties ), 1, 100 )
 *
 *   Base = 0.30·S_curve + 0.25·S_momentum + 0.20·S_trust + 0.15·S_safety + 0.10·S_identity
 *
 * Developer red flags act as a CEILING multiplier (not a bonus), so a serial
 * dumper can never exceed ~35 even with perfect momentum. Pure arithmetic,
 * O(1), no I/O — safe to run for every card on every poll.
 */
export interface VibeScoreParams {
  /** Sniper / MEV block-zero buyer count. */
  blockZeroBuyers: number;
  /** Token age in minutes. */
  timeSinceLaunchMins: number;
  /** Bonding curve progress, 0-100. */
  curveProgress: number;
  /** Diamond-hand holder percentage, 0-100. */
  diamondPct: number;
  /** 24h volume denominated in the pair asset (ETH-equivalent). */
  volumeEth: number;
  /** Buy pressure, 0-100. */
  buyPct: number;
  /** Whether the token has any social presence. */
  hasSocials: boolean;
  /** Creator bag as a percentage of total supply, 0-100. */
  creatorHoldingPct: number;
  /** Combined top-5 holder share of total supply, 0-100. */
  top5Pct?: number;
  /** Total launches by this developer (0 = unknown). */
  totalLaunches: number;
  /** Developer graduation rate, 0-100. */
  graduationRate: number;
  /** Number of past tokens this dev dumped pre-graduation. */
  totalPreGradDumps: number;
  /** Whether the dev has dumped at least one past token. */
  isSerialDumper: boolean;
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/** Logarithmic saturation: fast early traction, diminishing returns late. */
const saturate = (ratio: number) => 100 * Math.log10(1 + 9 * clamp(ratio, 0, 1));

export function calculateVibeScore(params: VibeScoreParams): number {
  const {
    blockZeroBuyers,
    timeSinceLaunchMins,
    curveProgress,
    diamondPct,
    volumeEth,
    buyPct,
    hasSocials,
    creatorHoldingPct,
    top5Pct = 0,
    totalLaunches,
    graduationRate,
    totalPreGradDumps,
    isSerialDumper,
  } = params;

  // --- Sub-scores (each 0-100) -------------------------------------------
  // S_curve: bonding curve progress (log-saturated).
  const sCurve = saturate(curveProgress / 100);

  // S_momentum: volume magnitude (saturates at 1 ETH) × buy-pressure quality.
  const volScore = saturate(clamp(volumeEth, 0, 1) / 1);
  const buyScore = clamp((buyPct - 50) * 2, 0, 100);
  const sMomentum = 0.6 * volScore + 0.4 * buyScore;

  // S_trust: developer track record (unknown dev = neutral 50, not punished).
  const sTrust = totalLaunches === 0 ? 50 : clamp(graduationRate, 0, 100);

  // S_safety: creator bag + sniper/MEV resistance + diamond hands.
  const bagScore = clamp(100 - creatorHoldingPct * 4, 0, 100);
  const sniperScore = clamp(100 - blockZeroBuyers * 5, 0, 100);
  const diamondScore = clamp(diamondPct, 0, 100);
  const sSafety = 0.45 * bagScore + 0.35 * sniperScore + 0.2 * diamondScore;

  // S_identity: social presence.
  const sIdentity = hasSocials ? 100 : 20;

  // --- Weighted base (0-100) ---------------------------------------------
  const base =
    0.3 * sCurve +
    0.25 * sMomentum +
    0.2 * sTrust +
    0.15 * sSafety +
    0.1 * sIdentity;

  // --- Trust multiplier: the developer discipline gate -------------------
  let trustMultiplier = 1.0;
  if (isSerialDumper) {
    trustMultiplier = 0.35; // dumped before → hard cap ~35
  } else if (totalLaunches >= 3 && graduationRate === 0) {
    trustMultiplier = 0.25; // serial non-graduate → hard cap ~25
  } else if (totalLaunches > 0) {
    if (graduationRate >= 50) trustMultiplier = 1.0;
    else if (graduationRate >= 20) trustMultiplier = 0.75;
    else trustMultiplier = 0.55;
  }

  // --- Momentum multiplier: anti-pump guard ------------------------------
  const momentumMultiplier =
    timeSinceLaunchMins < 10 && curveProgress > 70 ? 0.7 : 1.0;

  // --- Explicit penalties (post-multiplier) ------------------------------
  let penalties = 0;
  if (creatorHoldingPct > 10) penalties += 15;
  if (blockZeroBuyers > 15) penalties += 15;
  if (buyPct < 40 && volumeEth >= 0.01) penalties += 12;
  if (totalPreGradDumps >= 2) penalties += 10;

  // --- CRITICAL RISK hard penalties + score ceiling ----------------------
  // Additive scoring alone let dangerous tokens reach 70+ purely on socials
  // and volume. These rules impose hard, non-negotiable consequences.
  //
  // 1. Concentrated supply: creator bag > 15% OR top-5 > 40% → massive
  //    penalty AND a hard ceiling of 40 (a rug-in-waiting can never look safe).
  // 2. Developer discipline: any past pre-graduation dump → instant -25.
  const concentratedSupply = creatorHoldingPct > 15 || top5Pct > 40;
  if (concentratedSupply) penalties += 30;
  if (totalPreGradDumps > 0 || isSerialDumper) penalties += 25;

  // --- Developer graduation-rate BONUS -----------------------------------
  // Reward a proven track record of graduating tokens. This is added BEFORE
  // the final risk caps so it can lift a good dev, but it can never override
  // the hard ceilings below (a current dump still caps the score).
  let graduationBonus = 0;
  if (graduationRate >= 50) graduationBonus = 15;
  else if (graduationRate >= 25) graduationBonus = 8;
  else if (graduationRate > 0) graduationBonus = 4;

  // --- Final normalization -----------------------------------------------
  let raw = base * trustMultiplier * momentumMultiplier - penalties + graduationBonus;

  // Hard ceiling for concentrated supply. A token with 69% dev allocation and
  // a dumping history MUST land below 30 regardless of volume/graduation.
  if (concentratedSupply) raw = Math.min(raw, 40);

  // Developer-discipline ceiling. A non-zero dump history normally caps the
  // score at 30 — but a dev with a PROVEN graduation record (>25%) is not
  // crushed to a 1; they get a softer cap of 45.
  if (totalPreGradDumps > 0 || isSerialDumper) {
    raw = Math.min(raw, graduationRate > 25 ? 45 : 30);
  }

  return clamp(Math.round(raw), 1, 100);
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
  // `parseCreatedAtMs` normalizes seconds-vs-milliseconds so a 10-digit Unix
  // timestamp is not misread as a 1970 date (which produced bogus multi-day
  // runtimes). A null result means the field was unparseable → keep last-known.
  const createdMs = parseCreatedAtMs(launch.createdAt);
  const timeSinceLaunchMins =
    createdMs == null
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

/**
 * Normalizes a launch timestamp into epoch milliseconds.
 *
 * Upstream payloads are inconsistent: `createdAt` may arrive as an ISO string,
 * a Unix timestamp in SECONDS (10 digits), or a Unix timestamp in
 * MILLISECONDS (13 digits). Passing a seconds value straight into `new Date()`
 * treats it as milliseconds and yields a 1970 date, which then renders as a
 * nonsensical multi-day "LIVE: 11d 14h 19m" runtime. This helper detects the
 * unit and always returns milliseconds.
 *
 * Returns `null` when the value cannot be parsed, so callers can fall back to
 * a previously-known value instead of displaying garbage.
 */
export function parseCreatedAtMs(createdAt: unknown): number | null {
  if (createdAt == null) return null;

  // Numeric input: disambiguate seconds vs milliseconds by magnitude.
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) {
    // Anything below ~1e12 is a seconds timestamp (1e12 ms ≈ year 2001).
    return createdAt < 1e12 ? createdAt * 1000 : createdAt;
  }

  // Numeric string (e.g. "1700000000"): parse then apply the same rule.
  if (typeof createdAt === 'string' && /^\d+$/.test(createdAt.trim())) {
    const n = Number(createdAt.trim());
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  }

  // ISO / date string.
  const parsed = new Date(String(createdAt)).getTime();
  return Number.isNaN(parsed) ? null : parsed;
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

  // Market cap is ONLY ever derived from a real spot price. There is no
  // synthetic "graduation target" fallback: the previous hard-coded constants
  // ($50,500 for ETH pairs, $220,000 for VIBE pairs) were fabricated numbers
  // that had no relationship to the token's actual price and were the direct
  // cause of the "$220K grid card" discrepancy. When no trustworthy price is
  // available we return 0, which the UI renders as "Syncing..." rather than a
  // misleading figure.
  if (lastPriceWeiPerToken && Number(lastPriceWeiPerToken) > 0 && usdRate > 0) {
    const pricePairUnits = Number(lastPriceWeiPerToken) / 1e18;
    const mcUsd = pricePairUnits * 1_000_000_000 * usdRate;
    return {
      marketCapFormatted: mcUsd > 0 ? mcUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '$0.00',
      marketCapRaw: mcUsd
    };
  }

  // No real price available — signal "unresolved" with a zero market cap so the
  // caller shows a syncing placeholder instead of a synthetic estimate.
  return {
    marketCapFormatted: '$0.00',
    marketCapRaw: 0
  };
}
