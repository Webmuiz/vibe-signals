# Vibe Signals - Technical Audit

This document contains a comprehensive technical audit of the Vibe Signals codebase based on the existing implementation. No code has been modified.

## 1. Framework, Language, Dependencies & Structure
- **Framework:** Next.js 16.3.8 (App Router)
- **Language:** TypeScript, React 19.2.8
- **Dependencies:** `@supabase/supabase-js`, `@privy-io/react-auth`, `wagmi`, `viem`, `tailwindcss v4`, `@tanstack/react-query`.
- **Structure:** Standard Next.js `app` router structure. Includes a standalone background process script (`indexer.ts`) at the root.
- **Status:** **Working and verified**

## 2. Frontend Architecture & Reusable Components
- **Implementation:** The entire frontend application is housed within a massive, monolithic `app/page.tsx` file (~1440 lines). It tightly couples UI rendering, complex state management, data fetching, and wallet interactions.
- **Components:** There are no extracted, reusable UI components.
- **Status:** **Partially implemented** (Functionally working, but architecturally poor).

## 3. Backend APIs, Server Routes & External Integrations
- **Implementation:** Custom API routes exist in `app/api/` (`indexToken`, `proxyDev`, `proxyPrices`, `proxyVibe`, `tokens`). They primarily act as proxies to bypass CORS and aggregate data from the external VibeVibe testnet API (`https://testnet.vibevibe.fun/api/...`).
- **Integrations:** Coinbase API (for ETH price), VibeVibe testnet APIs.
- **Status:** **Working and verified**

## 4. Blockchain RPC, Contract Interactions & Data Sources
- **Implementation:** Uses Robinhood Testnet Chain ID 46630 (`https://rpc.testnet.chain.robinhood.com`). 
- **Interactions:** Uses `viem` in `indexer.ts` to watch events (`Creation`, `CurveBuy`) and `wagmi` hooks (`useReadContract`, `useSendTransaction`) in the frontend for balances and trading.
- **Status:** **Working and verified**

## 5. Token Discovery, Bonding-Curve Monitoring & Analytics
- **Implementation:** `indexer.ts` actively monitors the Factory contract for new launches and the Router for trades. It calculates bonding curve progress based on AMM ETH balance vs target (4.0 ETH) and tracks trade volume.
- **Status:** **Working and verified**

## 6. Cabal Detector & Holder Concentration Calculations
- **Implementation:** Fetches holder data from the Robinhood Explorer API. It calculates the percentage held by the top 5 holders (excluding the AMM and burn addresses). If concentration exceeds 25%, it flags a "Cabal Risk".
- **Status:** **Implemented but unverified** (Highly dependent on the Explorer API's response structure remaining consistent and available).

## 7. Developer Profiling & Historical Token Analysis
- **Implementation:** `/api/proxyDev` aggregates a developer's past launches and wallet activity. It mathematically verifies if the developer has a history of selling their own tokens pre-graduation ("Serial Dumper").
- **Status:** **Implemented but unverified**

## 8. Risk-Scoring Logic & Data Dependencies
- **Implementation:** `calculateVibeScore` in `page.tsx` assigns a score (1-100) based on volume, buy pressure, curve traction, social presence, and penalizes for high creator holdings or block-0 snipers.
- **Dependencies:** Relies heavily on accurate data aggregation from both on-chain RPC and off-chain VibeVibe APIs.
- **Status:** **Working and verified**

## 9. Wallet Connection, Token-Gated Access & Permissions
- **Implementation:** Uses Privy for authentication and Wagmi for wallet state. Access to the detailed "Analyze Alpha" view requires the user to hold at least 200,000 `$SIGNAL` tokens.
- **Status:** **Working and verified**

## 10. Trading and Zap Router Integration
- **Implementation:** Implemented via `handleExecuteApe` and `handleExecuteSell` using `useSendTransaction`. The ABI parameters are manually hard-encoded using `encodeAbiParameters`.
- **Status:** **Implemented but unverified** (Manual ABI encoding is error-prone and brittle to contract updates).

## 11. Database, Caching & Real-Time Data Flow
- **Implementation:** Uses Supabase (`launches` table). The frontend subscribes to Postgres changes via `supabase.channel` for real-time UI updates. API routes like `proxyPrices` use basic in-memory caching (`let cachedResponse`).
- **Status:** **Working and verified**

## 12. Error Handling, Loading States & API Rate Limits
- **Implementation:** Basic `try/catch` blocks exist, but errors are mostly silently caught or logged to console. `isTxPending` and `isSyncingLive` manage some loading states. There is no rate limiting on the Next.js API routes.
- **Status:** **Partially implemented**

## 13. Security Vulnerabilities & Exposed Secrets
- **Implementation:** The `.env.local` file contains `SUPABASE_SECRET_KEY` and is currently committed/present in the root directory. This allows anyone with access to the source code to bypass RLS and manipulate the database.
- **Status:** **Broken** (Critical security risk).

## 14. Missing Tests & Likely Sources of Bugs
- **Implementation:** There is absolutely no testing infrastructure (no Jest, Vitest, or Cypress).
- **Bug Sources:** 
  - Massive `useEffect` dependency chains in `page.tsx` causing race conditions.
  - Silent failures in API proxies when the external VibeVibe API changes schemas.
  - Manual ABI string encoding for router trades.
- **Status:** **Missing**

## 15. Technical Debt & Architectural Weaknesses
- **Debt:** The monolithic `page.tsx` is unsustainable. State management is tangled.
- **Weakness:** The `indexer.ts` is an isolated Node script run via `tsx`. It lacks a robust process manager (like PM2) for automatic restarts on failure. 

---

## Component Dependencies & Breakage Risks
1. **Supabase Schema ↔ Frontend/Indexer:** `page.tsx` expects specific fields in the `launches` table. Changing `indexer.ts` payload requires synchronized frontend updates.
2. **VibeVibe API ↔ Proxy Routes:** The frontend relies on normalized data from `/api/proxyVibe` and `/api/proxyDev`. Any upstream changes to the VibeVibe API will break Risk Scoring and Developer Profiling.
3. **Explorer API ↔ Cabal Detector:** If the Robinhood Block Explorer rate-limits the app or changes its DOM/JSON structure, the Cabal Detector will fail silently or throw errors.

---

## Prioritized Improvement Plan

1. **Phase 1: Immediate Security Remediation**
   - Rotate the `SUPABASE_SECRET_KEY`.
   - Ensure `.env.local` is added to `.gitignore`.

2. **Phase 2: Architectural Refactoring (Frontend)**
   - Deconstruct `page.tsx` into modular components (e.g., `<RadarPanel>`, `<TradingTerminal>`, `<TokenCard>`).
   - Migrate complex data fetching to TanStack React Query (already installed) to eliminate fragile `useEffect` polling.

3. **Phase 3: Resiliency & Reliability**
   - Wrap `indexer.ts` in a process manager (PM2/Docker) to ensure 24/7 uptime.
   - Implement Zod schema validation on all `/api/*` routes to handle unexpected external API changes gracefully.
   - Replace hardcoded ABI encoding in trade functions with viem's typed contract methods.

4. **Phase 4: Testing & Maintenance**
   - Install Vitest and write unit tests for pure logic functions (`calculateVibeScore`, `getDevProfile`).
   - Add global error boundaries to the React app to prevent complete crashes on undefined data.
