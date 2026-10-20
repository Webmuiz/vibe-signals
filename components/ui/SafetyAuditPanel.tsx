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

export default function SafetyAuditPanel({
  hasSocials,
  safetyChecks,
  securityResult,
}: SafetyAuditPanelProps) {
  // Only treat the result as live data when it is a real object. A null /
  // undefined prop (still loading, or the endpoint failed) degrades to the
  // original placeholder UI below.
  const live = securityResult && typeof securityResult === 'object' ? securityResult : null;
  const riskLevel = live ? normalizeRiskLevel(live.risk_level) : null;
  const hasLiveVerdict = !!live && riskLevel !== null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-wider">Contract Safety & Audits</h3>
        {hasLiveVerdict && (
          <span
            className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${RISK_BADGE_COLOR[riskLevel as RiskLevel]}`}
          >
            {riskLevel} RISK
          </span>
        )}
      </div>
      <ul className="space-y-3 text-sm">
        <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
          <span className="text-zinc-500">Social Presence</span>
          <span className={hasSocials ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
            {hasSocials ? 'Linked' : 'No Socials'}
          </span>
        </li>

        {/* Honeypot status — live verdict when available, otherwise the
            existing MEV placeholder row. */}
        {hasLiveVerdict ? (
          <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
            <span className="text-zinc-500">Honeypot Status</span>
            <span className={live!.is_honeypot ? 'text-red-500 font-bold' : 'text-green-500 font-bold'}>
              {live!.is_honeypot ? 'Honeypot Detected' : 'Not a Honeypot'}
            </span>
          </li>
        ) : (
          <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
            <span className="text-zinc-500">MEV Exposure</span>
            <span className={safetyChecks.mev.safe ? 'text-emerald-400 font-bold' : 'text-yellow-400 font-bold'}>{safetyChecks.mev.label}</span>
          </li>
        )}

        {/* Buy / Sell tax — live values when available. */}
        {hasLiveVerdict ? (
          <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
            <span className="text-zinc-500">Buy / Sell Tax</span>
            <span className="font-bold font-mono">
              <span className={taxColor(live!.buy_tax_percent)}>{formatTax(live!.buy_tax_percent)}</span>
              <span className="text-zinc-600 mx-1">/</span>
              <span className={taxColor(live!.sell_tax_percent)}>{formatTax(live!.sell_tax_percent)}</span>
            </span>
          </li>
        ) : (
          <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
            <span className="text-zinc-500">Creator Wallet</span>
            <span className={safetyChecks.creatorBag.safe ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
              {safetyChecks.creatorBag.label}
            </span>
          </li>
        )}

        {/* Risk verdict — live when available, otherwise the existing
            Developer Discipline row (which shows "Scanning..." while pending). */}
        {hasLiveVerdict ? (
          <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
            <span className="text-zinc-500">Risk Level</span>
            <span className={`font-bold ${RISK_TEXT_COLOR[riskLevel as RiskLevel]}`}>{riskLevel}</span>
          </li>
        ) : (
          <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
            <span className="text-zinc-500">Developer Discipline</span>
            <span className={safetyChecks?.dumperRisk?.safe ? 'text-emerald-400 font-bold' : 'text-red-500 font-bold bg-red-500/10 px-2 py-0.5 rounded border border-red-500/30 animate-pulse'}>
              {safetyChecks?.dumperRisk?.label || "Scanning..."}
            </span>
          </li>
        )}

        {/* Extra live-only signals: blacklist + mint authority. */}
        {hasLiveVerdict && (
          <>
            <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
              <span className="text-zinc-500">Blacklist Capability</span>
              <span className={live!.can_black_list ? 'text-red-500 font-bold' : 'text-green-500 font-bold'}>
                {live!.can_black_list ? 'Owner Can Freeze' : 'None'}
              </span>
            </li>
            <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
              <span className="text-zinc-500">Mint Authority</span>
              <span className={live!.is_mintable ? 'text-red-500 font-bold' : 'text-green-500 font-bold'}>
                {live!.is_mintable ? 'Mintable' : 'Renounced'}
              </span>
            </li>
          </>
        )}
      </ul>
    </div>
  );
}
