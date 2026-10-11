import React from "react";
import {
  shortenAddress,
  formatTimeLive,
  getUsdRateForPair,
  calculateTokenMetrics,
  formatCompactUsd,
} from "@/lib/tokenMetrics";

export interface TokenCardData {
  id: string;
  name: string;
  ticker: string;
  contractAddress: string;
  bondingCurveProgress: number;
  ethDeposited: number | string;
  pairSymbol: string;
  timeSinceLaunchMins: number;
  score: number;
  /** Creator bag as a percentage of total supply (0 when unknown). */
  creatorHoldingPct?: number;
  /** Combined top-5 holder share of total supply (0 when unknown). */
  top5Pct?: number;
  /** Developer discipline stats used by the preset filters. */
  devStats?: {
    launches: number;
    gradRate: number;
    totalPreGradDumps: number;
    isSerialDumper: boolean;
  };
  cachedMarketCapFormatted?: string;
  /**
   * Real, API-derived market cap (formatted USD string). When present this is
   * the SAME value the "Analyse Alpha" detail view shows. When absent the card
   * falls back to a clearly-marked synthetic estimate.
   */
  marketCapUsd?: string;
  /** True when `marketCapUsd` is a synthetic estimate rather than real price data. */
  marketCapIsEstimate?: boolean;
  /** Real, API-derived 24h volume in USD (formatted string). */
  volumeUsd?: string;
  momentum?: {
    buyPct?: number;
    sellPct?: number;
    volumeEth?: string | number;
  };
}

interface TokenCardProps {
  token: TokenCardData;
  isConnected: boolean;
  hasAccess: boolean;
  liveRates: Record<string, number>;
  onSelect: (token: TokenCardData) => void;
  signalTokenAddress: string;
  /**
   * Whether the real API-derived metrics (`liveMetrics`) have resolved for this
   * token. While `false`, the Market Cap / 24H Volume numbers are blurred so the
   * user never sees the synthetic Supabase fallback values mid-load.
   */
  liveMetricsResolved?: boolean;
}

/**
 * Deterministic pseudo-random generator seeded from a string. Produces a stable
 * 0..1 stream so the same token address always yields the same sparkline shape
 * across re-renders (and across the 10s polling loop) without any state.
 */
function seededRandom(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    // xorshift32 — cheap, deterministic, good enough for a visual jitter.
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 4294967296;
  };
}

/**
 * Builds a lightweight, deterministic SVG sparkline path for a token.
 *
 * The shape is derived ONLY from `address`, `bondingCurveProgress` and
 * `timeSinceLaunchMins`, so it is referentially stable across re-renders unless
 * one of those inputs actually changes. The overall trend is driven by curve
 * progress (a token closer to graduation trends up), while the seeded jitter
 * gives each token a distinct, realistic wiggle.
 *
 * @returns `{ path, positive }` — the SVG path `d` string and whether the line
 *          should be coloured green (upward momentum) or red (downward).
 */
export function buildSparkline(
  address: string,
  bondingCurveProgress: number,
  timeSinceLaunchMins: number,
  buyPct: number,
  width = 120,
  height = 28
): { path: string; positive: boolean } {
  const points = 12;
  const rand = seededRandom(`${address}:${bondingCurveProgress.toFixed(2)}:${timeSinceLaunchMins}`);
  const positive = buyPct > 50;

  // Trend bias: progress pushes the series up; a bearish (sell-heavy) token
  // biases it down so the visual matches the momentum colour.
  const trend = (bondingCurveProgress / 100) * 0.6 + (positive ? 0.25 : -0.15);

  const stepX = width / (points - 1);
  const coords: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    // Base line interpolates from bottom to top according to the trend, then a
    // bounded jitter (±35% of the height) makes it look like a real price feed.
    const base = (1 - t) * (1 - trend) + t * trend;
    const jitter = (rand() - 0.5) * 0.35;
    const y = Math.max(2, Math.min(height - 2, (1 - (base + jitter)) * height));
    coords.push({ x: i * stepX, y });
  }

  const path = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(' ');

  return { path, positive };
}

function TokenCard({
  token,
  isConnected,
  hasAccess,
  liveRates,
  onSelect,
  signalTokenAddress,
  liveMetricsResolved = true,
}: TokenCardProps) {
  const scoreColor =
    token.score >= 70
      ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/10"
      : token.score >= 45
        ? "text-yellow-400 border-yellow-400/30 bg-yellow-400/10"
        : "text-red-400 border-red-400/30 bg-red-400/10";

  const unlocked = isConnected && hasAccess;

  // Sparkline is derived purely from stable, displayed inputs. `useMemo` keeps
  // the generated path referentially stable across re-renders so it never
  // contributes to the 10s polling churn.
  const buyPct = token.momentum?.buyPct ?? 50;
  const sparkline = React.useMemo(
    () =>
      buildSparkline(
        token.contractAddress,
        token.bondingCurveProgress,
        token.timeSinceLaunchMins,
        buyPct
      ),
    [token.contractAddress, token.bondingCurveProgress, token.timeSinceLaunchMins, buyPct]
  );

  return (
    <div
      onClick={() => {
        if (unlocked) onSelect(token);
      }}
      className={`relative border border-zinc-800 bg-zinc-900 rounded-xl p-6 overflow-hidden flex flex-col justify-between transition-all ${unlocked ? 'cursor-pointer hover:border-emerald-500/50 hover:shadow-[0_0_20px_rgba(16,185,129,0.1)] group' : ''}`}
    >
      <div>
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className={`font-bold text-lg ${unlocked ? 'group-hover:text-emerald-400 transition-colors' : ''}`}>{token.name}</h3>
            <div className="flex items-center gap-2">
              <span className="text-sm text-zinc-400">{token.ticker}</span>
              <span className="text-xs px-2 py-1 bg-zinc-800 rounded-md text-zinc-500">{shortenAddress(token.contractAddress)}</span>
            </div>
          </div>
        </div>

        <div className="mb-6">

          {/* The missing time block you are adding back: */}
          <div className="flex justify-between text-xs mb-2">
            <span className="text-zinc-500">Time Live (est)</span>
            <span className="text-zinc-300">{formatTimeLive(token.timeSinceLaunchMins)}</span>
          </div>

          {/* The existing bonding curve code you just shared: */}
          <div className="flex justify-between text-xs mb-2">
            <span className="text-zinc-500">{token.bondingCurveProgress >= 100 ? 'Status' : 'Bonding Curve'}</span>
            <span className={token.bondingCurveProgress >= 100 ? "text-amber-400 font-bold" : token.bondingCurveProgress > 85 ? "text-emerald-400" : "text-zinc-300"}>
              {token.bondingCurveProgress >= 100 ? 'Graduated 🚀' : `${token.bondingCurveProgress.toFixed(1)}%`}
            </span>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-2">
            <div
              className={`h-2 rounded-full ${token.bondingCurveProgress >= 100
                ? "bg-gradient-to-r from-amber-400 via-amber-500 to-amber-600 shadow-[0_0_10px_rgba(251,191,36,0.8)]"
                : token.bondingCurveProgress > 85
                  ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]"
                  : "bg-zinc-500"
                }`}
              style={{ width: `${Math.min(100, Math.max(1, token.bondingCurveProgress))}%` }}
            />
          </div>
        </div>
      </div>

      <div className="relative">
        {!unlocked && (
          <div className="absolute inset-0 z-10 backdrop-blur-md bg-zinc-950/60 flex flex-col items-center justify-center rounded-lg border border-zinc-800">
            {!isConnected ? (
              <span className="text-sm font-bold text-zinc-300">Connect Wallet to Unlock</span>
            ) : (
              <div className="text-center p-2">
                <span className="text-xs font-bold text-emerald-400 block mb-1">Requires 200,000 $SIGNAL</span>
                <a href={`https://testnet.vibevibe.fun/token/${signalTokenAddress}`} target="_blank" rel="noreferrer" className="text-[10px] underline text-zinc-400 hover:text-white pointer-events-auto relative z-20">Acquire Token</a>
              </div>
            )}
          </div>
        )}

        {/* Auto-refreshing sparkline — sits directly above the stats box. */}
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">24H Trend</span>
          <svg
            width={120}
            height={28}
            viewBox="0 0 120 28"
            preserveAspectRatio="none"
            className="overflow-visible"
            aria-hidden="true"
          >
            <path
              d={sparkline.path}
              fill="none"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={sparkline.positive ? "stroke-emerald-400" : "stroke-red-400"}
            />
          </svg>
        </div>

        <div className="border border-zinc-800 bg-zinc-950/50 rounded-lg p-4 mb-4">
          <div className="grid grid-cols-3 gap-2 text-center divide-x divide-zinc-800/50">
            <div>
              <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider block mb-1">
                {token.marketCapIsEstimate ? 'M.Cap (Est)' : 'M.Cap'}
              </span>
              <span
                className={`text-sm font-bold text-zinc-300 transition-all duration-300 ${!liveMetricsResolved ? 'blur-sm opacity-50 select-none' : ''}`}
              >
                {token.marketCapUsd
                  ? `${token.marketCapIsEstimate ? '~' : ''}${formatCompactUsd(token.marketCapUsd)}`
                  : token.cachedMarketCapFormatted
                    ? formatCompactUsd(token.cachedMarketCapFormatted)
                    : `~${formatCompactUsd(calculateTokenMetrics(token.bondingCurveProgress, token.ethDeposited, token.pairSymbol, liveRates).marketCapFormatted)}`}
              </span>
            </div>
            <div>
              <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider block mb-1">24H Vol</span>
              <span
                className={`text-sm font-bold text-zinc-300 transition-all duration-300 ${!liveMetricsResolved ? 'blur-sm opacity-50 select-none' : ''}`}
              >
                {token.volumeUsd
                  ? formatCompactUsd(token.volumeUsd)
                  : formatCompactUsd(Number(token.momentum?.volumeEth || 0) * getUsdRateForPair(token.pairSymbol, liveRates))}
              </span>
            </div>
            <div className="pl-1">
              <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider block mb-1">Score</span>
              <span className={`text-sm font-bold px-2 py-0.5 rounded border inline-block ${scoreColor}`}>
                {token.score}
              </span>
            </div>
          </div>
        </div>
      </div>

      <button
        className={`w-full py-2 font-bold rounded-lg text-center text-sm transition-colors mt-auto block border ${unlocked ? 'bg-zinc-800 hover:bg-emerald-500 hover:text-zinc-950 border-zinc-700 hover:border-emerald-500 text-white' : 'bg-zinc-800/50 text-zinc-600 border-zinc-800 cursor-not-allowed'}`}
      >
        {unlocked ? 'Analyze Alpha →' : 'Locked'}
      </button>
    </div>
  );
}

/**
 * Custom comparator: only re-render when a value that is actually DISPLAYED
 * changes. The 10s polling loop hands us fresh object references even when the
 * underlying data is identical, which previously forced every card (and its
 * Vibe Score) to re-render/flicker. `onSelect` is intentionally ignored here
 * because the parent stabilises it with `useCallback`.
 */
function areTokenCardPropsEqual(prev: TokenCardProps, next: TokenCardProps): boolean {
  if (prev.isConnected !== next.isConnected) return false;
  if (prev.hasAccess !== next.hasAccess) return false;
  if (prev.signalTokenAddress !== next.signalTokenAddress) return false;
  if (prev.liveMetricsResolved !== next.liveMetricsResolved) return false;
  if (prev.liveRates !== next.liveRates) return false;

  const a = prev.token;
  const b = next.token;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.ticker === b.ticker &&
    a.contractAddress === b.contractAddress &&
    a.score === b.score &&
    a.bondingCurveProgress === b.bondingCurveProgress &&
    a.ethDeposited === b.ethDeposited &&
    a.pairSymbol === b.pairSymbol &&
    a.timeSinceLaunchMins === b.timeSinceLaunchMins &&
    a.marketCapUsd === b.marketCapUsd &&
    a.marketCapIsEstimate === b.marketCapIsEstimate &&
    a.volumeUsd === b.volumeUsd &&
    a.cachedMarketCapFormatted === b.cachedMarketCapFormatted &&
    a.momentum?.buyPct === b.momentum?.buyPct &&
    a.momentum?.sellPct === b.momentum?.sellPct &&
    a.momentum?.volumeEth === b.momentum?.volumeEth &&
    // Risk fields feed the preset filters; compare them so a change in
    // concentration / dump history still re-renders the card.
    a.creatorHoldingPct === b.creatorHoldingPct &&
    a.top5Pct === b.top5Pct &&
    a.devStats?.totalPreGradDumps === b.devStats?.totalPreGradDumps
  );
}

export default React.memo(TokenCard, areTokenCardPropsEqual);
