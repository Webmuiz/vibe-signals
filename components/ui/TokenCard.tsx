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

export default function TokenCard({
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
