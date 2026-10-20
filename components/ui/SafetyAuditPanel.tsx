import React from "react";
import type { SecuritySimulationResult, RiskLevel } from "@/lib/analytics/securitySimulator";

export interface SafetyCheck {
  label: string;
  safe: boolean;
}

export interface SafetyChecks {
  mev: SafetyCheck;
  creatorBag: SafetyCheck;
  dumperRisk?: SafetyCheck;
}

interface SafetyAuditPanelProps {
  hasSocials: boolean;
  safetyChecks: SafetyChecks;
  /**
   * Optional on-chain security simulation from `/api/analytics/security`.
   * Purely additive: when absent the panel renders exactly as before.
   */
  securityResult?: SecuritySimulationResult | null;
}

/**
 * Semantic colour map for the on-chain risk verdict.
 * CRITICAL/HIGH -> red, MEDIUM -> yellow, LOW/SAFE -> green.
 */
const RISK_TEXT_COLOR: Record<RiskLevel, string> = {
  CRITICAL: 'text-red-500',
  HIGH: 'text-red-500',
  MEDIUM: 'text-yellow-500',
  LOW: 'text-green-500',
};

const RISK_BADGE_COLOR: Record<RiskLevel, string> = {
  CRITICAL: 'bg-red-500/10 text-red-500 border-red-500/30',
  HIGH: 'bg-red-500/10 text-red-500 border-red-500/30',
  MEDIUM: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30',
  LOW: 'bg-green-500/10 text-green-500 border-green-500/30',
};

/** Normalise an arbitrary risk string into a known RiskLevel (defensive). */
function normalizeRiskLevel(value: unknown): RiskLevel | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  if (upper === 'CRITICAL' || upper === 'HIGH' || upper === 'MEDIUM' || upper === 'LOW') {
    return upper;
  }
  return null;
}

/** Format a tax percentage defensively (NaN / missing -> 0.00%). */
function formatTax(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0.00%';
  return `${Math.min(100, Math.max(0, num)).toFixed(2)}%`;
}

/** Tax severity: >15% red, >=5% yellow, otherwise green. */
function taxColor(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'text-zinc-400';
  if (num > 15) return 'text-red-500';
  if (num >= 5) return 'text-yellow-500';
  return 'text-green-500';
}

/**
 * Inline pulse skeleton used inside a value slot while async data resolves.
 * It occupies the same box as the eventual value so the row never resizes.
 */
function Skeleton({ width = 'w-20' }: { width?: string }) {
  return <span className={`inline-block animate-pulse bg-zinc-800/50 rounded h-4 ${width}`} />;
}

/** One permanent row. The DOM node is never unmounted or replaced. */
function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex justify-between items-center gap-3 p-3 bg-zinc-950 rounded-lg border border-zinc-800 min-h-[52px]">
      <span className="text-zinc-500 shrink-0">{label}</span>
      <span className="flex items-center justify-end gap-1.5 text-right min-w-0">{children}</span>
    </li>
  );
}

export default function SafetyAuditPanel({
  hasSocials,
  safetyChecks,
  securityResult,
}: SafetyAuditPanelProps) {
  // Only treat the result as live data when it is a real object. A null /
  // undefined prop (still loading, or the endpoint failed) degrades to inline
  // skeletons INSIDE the same rows — never to a different JSX tree.
  const live = securityResult && typeof securityResult === 'object' ? securityResult : null;
  const riskLevel = live ? normalizeRiskLevel(live.risk_level) : null;
  const hasLiveVerdict = !!live && riskLevel !== null;

  // Fallback signals (derived from grid/on-chain data) are used only when the
  // live verdict has not landed yet.
  const mev = safetyChecks?.mev;
  const creatorBag = safetyChecks?.creatorBag;
  const dumperRisk = safetyChecks?.dumperRisk;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-wider">Contract Safety & Audits</h3>
        {/* The badge slot is always present so the header height is stable. */}
        <span
          className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${
            hasLiveVerdict
              ? RISK_BADGE_COLOR[riskLevel as RiskLevel]
              : 'bg-zinc-800/50 text-zinc-500 border-zinc-700/50'
          }`}
        >
          {hasLiveVerdict ? `${riskLevel} RISK` : 'AUDITING'}
        </span>
      </div>

      {/* ONE permanent 6-item stack. Every row always renders. */}
      <ul className="space-y-3 text-sm">
        {/* 1. Social Presence — synchronous, always known. */}
        <Row label="Social Presence">
          <span className={hasSocials ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
            {hasSocials ? 'Linked' : 'No Socials'}
          </span>
        </Row>

        {/* 2. Honeypot Status */}
        <Row label="Honeypot Status">
          {hasLiveVerdict ? (
            <span className={live!.is_honeypot ? 'text-red-500 font-bold' : 'text-green-500 font-bold'}>
              {live!.is_honeypot ? 'Honeypot Detected' : 'Not a Honeypot'}
            </span>
          ) : (
            <Skeleton width="w-24" />
          )}
        </Row>

        {/* 3. Buy / Sell Tax */}
        <Row label="Buy / Sell Tax">
          {hasLiveVerdict ? (
            <span className="font-bold font-mono">
              <span className={taxColor(live!.buy_tax_percent)}>{formatTax(live!.buy_tax_percent)}</span>
              <span className="text-zinc-600 mx-1">/</span>
              <span className={taxColor(live!.sell_tax_percent)}>{formatTax(live!.sell_tax_percent)}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Skeleton width="w-12" />
              <span className="text-zinc-600">/</span>
              <Skeleton width="w-12" />
            </span>
          )}
        </Row>

        {/* 4. Risk Level + Blacklist / Mint Authority badges */}
        <Row label="Risk Level">
          {hasLiveVerdict ? (
            <span className="flex items-center gap-1.5 flex-wrap justify-end">
              <span className={`font-bold ${RISK_TEXT_COLOR[riskLevel as RiskLevel]}`}>{riskLevel}</span>
              <span
                className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                  live!.can_black_list
                    ? 'bg-red-500/10 text-red-500 border-red-500/30'
                    : 'bg-green-500/10 text-green-500 border-green-500/30'
                }`}
              >
                {live!.can_black_list ? 'Blacklist' : 'No Blacklist'}
              </span>
              <span
                className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                  live!.is_mintable
                    ? 'bg-red-500/10 text-red-500 border-red-500/30'
                    : 'bg-green-500/10 text-green-500 border-green-500/30'
                }`}
              >
                {live!.is_mintable ? 'Mintable' : 'Renounced'}
              </span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Skeleton width="w-14" />
              <Skeleton width="w-16" />
              <Skeleton width="w-16" />
            </span>
          )}
        </Row>

        {/* 5. MEV Exposure — falls back to the grid-derived signal. */}
        <Row label="MEV Exposure">
          {hasLiveVerdict ? (
            <span className={live!.is_honeypot ? 'text-yellow-400 font-bold' : 'text-emerald-400 font-bold'}>
              {live!.is_honeypot ? 'Elevated' : 'Low'}
            </span>
          ) : mev ? (
            <span className={mev.safe ? 'text-emerald-400 font-bold' : 'text-yellow-400 font-bold'}>
              {mev.label}
            </span>
          ) : (
            <Skeleton width="w-20" />
          )}
        </Row>

        {/* 6. Creator Wallet & Developer Discipline */}
        <Row label="Creator Wallet">
          {creatorBag || dumperRisk ? (
            <span className="flex items-center gap-1.5 flex-wrap justify-end">
              {creatorBag && (
                <span className={creatorBag.safe ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                  {creatorBag.label}
                </span>
              )}
              {dumperRisk && (
                <span
                  className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                    dumperRisk.safe
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                      : 'bg-red-500/10 text-red-500 border-red-500/30'
                  }`}
                >
                  {dumperRisk.label}
                </span>
              )}
            </span>
          ) : (
            <Skeleton width="w-24" />
          )}
        </Row>
      </ul>
    </div>
  );
}
