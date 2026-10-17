import React from "react";
import type { SecuritySimulationResult } from "@/lib/analytics/securitySimulator";

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

export default function SafetyAuditPanel({
  hasSocials,
  safetyChecks,
}: SafetyAuditPanelProps) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
      <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-4">Contract Safety & Audits</h3>
      <ul className="space-y-3 text-sm">
        <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
          <span className="text-zinc-500">Social Presence</span>
          <span className={hasSocials ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
            {hasSocials ? 'Linked' : 'No Socials'}
          </span>
        </li>
        <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
          <span className="text-zinc-500">MEV Exposure</span>
          <span className={safetyChecks.mev.safe ? 'text-emerald-400 font-bold' : 'text-yellow-400 font-bold'}>{safetyChecks.mev.label}</span>
        </li>
        <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
          <span className="text-zinc-500">Creator Wallet</span>
          <span className={safetyChecks.creatorBag.safe ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
            {safetyChecks.creatorBag.label}
          </span>
        </li>
        <li className="flex justify-between items-center p-3 bg-zinc-950 rounded-lg border border-zinc-800">
          <span className="text-zinc-500">Developer Discipline</span>
          <span className={safetyChecks?.dumperRisk?.safe ? 'text-emerald-400 font-bold' : 'text-red-500 font-bold bg-red-500/10 px-2 py-0.5 rounded border border-red-500/30 animate-pulse'}>
            {safetyChecks?.dumperRisk?.label || "Scanning..."}
          </span>
        </li>
      </ul>
    </div>
  );
}
