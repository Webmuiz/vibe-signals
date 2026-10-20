/**
 * Insider Cluster Mapping Engine (Cabal Detector)
 * ===============================================
 *
 * Builds a wallet-funding graph for a token's holder set and quantifies how
 * much supply is controlled by a coordinated "cabal" — wallets that share a
 * common funding origin or individually hold a meaningful slice of supply.
 *
 * Model
 * -----
 *  1. FUNDING ORIGIN — holders are grouped by `funderAddress`. Any funder that
 *     bankrolls two or more holders links those holders into one cluster.
 *  2. WHALE MEMBERSHIP — a wallet holding more than 1% of supply is treated as
 *     a cluster member on its own, even without a shared funder.
 *  3. SUPPLY CONCENTRATION — `cabalSupplyPct` is the sum of `balancePct` over
 *     every clustered wallet (each wallet counted once).
 *
 * The resulting graph is persisted to `insider_clusters` (created by
 * scripts/migrations/003_cabal_clusters.sql) as a JSON `{ nodes, edges }`
 * document so the UI can render the network without re-running the analysis.
 *
 * All database access is best-effort: write failures are logged and swallowed,
 * and reads degrade to a zeroed default, so a Turso outage can never break a
 * caller's request path.
 */
import { createClient, type Client as LibsqlClient } from '@libsql/client';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CabalRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface HolderData {
    address: string;
    /** Share of total supply held, expressed as a percentage (0-100). */
    balancePct: number;
    /** Address that originally funded this wallet, when known. */
    funderAddress?: string;
}

export interface ClusterNode {
    id: string;
    label: string;
    balancePct: number;
    isClusterMember: boolean;
}

export interface ClusterEdge {
    source: string;
    target: string;
    type: 'FUNDED_BY' | 'DIRECT_TRANSFER';
}

export interface CabalAnalysisResult {
    tokenAddress: string;
    totalAnalyzedWallets: number;
    clusteredWallets: number;
    cabalSupplyPct: number;
    fundingSourceOverlapCount: number;
    riskLevel: CabalRiskLevel;
    /** JSON stringified `{ nodes: ClusterNode[], edges: ClusterEdge[] }`. */
    clusterGraphJson: string;
    analyzedAt: string;
    /**
     * True when this is the zeroed placeholder returned because no row exists
     * (or the read failed) — callers use it to decide whether to recompute.
     */
    isDefault: boolean;
    /**
     * True when the holder set could not be read at all (e.g. `totalSupply()`
     * reverted, or the token has no bytecode). In that case `riskLevel` is
     * NOT a verdict — it is a placeholder and must not be rendered as "LOW".
     */
    isUnavailable: boolean;
    /** Human-readable reasons the analysis could not be completed. */
    warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A wallet above this share of supply is a cluster member on its own. */
const WHALE_THRESHOLD_PCT = 1;

/** A funder must back at least this many holders to form a cluster. */
const MIN_WALLETS_PER_FUNDER = 2;

/** Shorten an address for display in the graph UI. */
function shortAddress(address: string): string {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** viem errors carry richer text in `shortMessage` / `details`. */
interface ViemLikeError extends Error {
    shortMessage?: string;
    details?: string;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        const rich = error as ViemLikeError;
        return (rich.shortMessage || rich.details || error.message)
            .toString()
            .slice(0, 200);
    }
    return String(error).slice(0, 200);
}

// ---------------------------------------------------------------------------
// Turso client (lazy — env vars are only available at request time in Next.js)
// ---------------------------------------------------------------------------
let db: LibsqlClient | null = null;

function getDb(): LibsqlClient {
    if (db) return db;
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) throw new Error('TURSO_DATABASE_URL is not set');
    db = createClient({ url, authToken });
    return db;
}

// ---------------------------------------------------------------------------
// Risk assignment
// ---------------------------------------------------------------------------

/**
 * Assign a risk level from supply concentration and funder overlap.
 *
 *   CRITICAL: cabalSupplyPct > 30 OR fundingSourceOverlapCount >= 5
 *   HIGH:     cabalSupplyPct > 15 OR fundingSourceOverlapCount >= 3
 *   MEDIUM:   cabalSupplyPct > 5  OR fundingSourceOverlapCount >= 1
 *   LOW:      otherwise
 */
export function assignCabalRiskLevel(
    cabalSupplyPct: number,
    fundingSourceOverlapCount: number
): CabalRiskLevel {
    if (cabalSupplyPct > 30 || fundingSourceOverlapCount >= 5) return 'CRITICAL';
    if (cabalSupplyPct > 15 || fundingSourceOverlapCount >= 3) return 'HIGH';
    if (cabalSupplyPct > 5 || fundingSourceOverlapCount >= 1) return 'MEDIUM';
    return 'LOW';
}

// ---------------------------------------------------------------------------
// Core analysis (pure — no I/O)
// ---------------------------------------------------------------------------

/**
 * Build the funding graph for `holders` and quantify cabal control.
 *
 * Addresses are lowercased so the same wallet written in different casing is
 * never double-counted. Duplicate holder entries are merged by taking the
 * larger balance, which is the conservative choice for a risk signal.
 */
export function analyzeCabalClusters(
    tokenAddress: string,
    holders: HolderData[]
): CabalAnalysisResult {
    const normalizedToken = tokenAddress.toLowerCase();
    const safeHolders = Array.isArray(holders) ? holders : [];

    // --- 1. Normalise + de-duplicate holders -------------------------------
    const byAddress = new Map<string, HolderData>();
    for (const holder of safeHolders) {
        if (!holder || typeof holder.address !== 'string') continue;
        const address = holder.address.trim().toLowerCase();
        if (address.length === 0) continue;

        const balancePct = Number.isFinite(holder.balancePct)
            ? Math.max(0, holder.balancePct)
            : 0;
        const funder =
            typeof holder.funderAddress === 'string' &&
            holder.funderAddress.trim().length > 0
                ? holder.funderAddress.trim().toLowerCase()
                : undefined;

        const existing = byAddress.get(address);
        if (existing) {
            existing.balancePct = Math.max(existing.balancePct, balancePct);
            if (!existing.funderAddress && funder) existing.funderAddress = funder;
        } else {
            byAddress.set(address, { address, balancePct, funderAddress: funder });
        }
    }

    const uniqueHolders = [...byAddress.values()];

    // --- 2. Group holders by funding origin --------------------------------
    const holderAddresses = new Set(uniqueHolders.map((h) => h.address));

    const byFunder = new Map<string, HolderData[]>();
    for (const holder of uniqueHolders) {
        if (!holder.funderAddress) continue;
        const group = byFunder.get(holder.funderAddress);
        if (group) group.push(holder);
        else byFunder.set(holder.funderAddress, [holder]);
    }

    // A funder counts as an overlap in two distinct situations:
    //
    //   a) It backs 2+ distinct wallets. This is the classic shared-operator
    //      pattern: one wallet dispenses gas to a set of fresh addresses.
    //
    //   b) It is itself a holder of this token. A funder that also holds the
    //      token is not an outside party — the funding link is a direct
    //      connection between two positions in the same asset. This covers the
    //      reciprocal case (A funded B and B funded A), where each funder backs
    //      exactly one wallet and rule (a) alone would report zero overlap.
    const overlappingFunders = [...byFunder.entries()].filter(
        ([funder, group]) =>
            group.length >= MIN_WALLETS_PER_FUNDER || holderAddresses.has(funder)
    );
    const fundingSourceOverlapCount = overlappingFunders.length;

    // --- 3. Determine cluster membership ----------------------------------
    const clusterMembers = new Set<string>();

    for (const [funder, group] of overlappingFunders) {
        // The funder is a control point of the cluster even when it holds no
        // supply of its own, so it is a member whenever it is a real holder.
        if (holderAddresses.has(funder)) clusterMembers.add(funder);
        for (const holder of group) clusterMembers.add(holder.address);
    }

    for (const holder of uniqueHolders) {
        if (holder.balancePct > WHALE_THRESHOLD_PCT) {
            clusterMembers.add(holder.address);
        }
    }

    // --- 4. Supply concentration ------------------------------------------
    let cabalSupplyPct = 0;
    for (const holder of uniqueHolders) {
        if (clusterMembers.has(holder.address)) {
            cabalSupplyPct += holder.balancePct;
        }
    }
    cabalSupplyPct = round2(Math.min(100, cabalSupplyPct));

    // --- 5. Graph construction --------------------------------------------
    const nodes: ClusterNode[] = uniqueHolders.map((holder) => ({
        id: holder.address,
        label: shortAddress(holder.address),
        balancePct: round2(holder.balancePct),
        isClusterMember: clusterMembers.has(holder.address),
    }));

    // A funder is frequently NOT itself a holder (a fresh operator wallet that
    // only distributes gas). The UI can only draw an edge between two existing
    // nodes, so every overlapping funder gets a synthetic node with 0% supply.
    // Without this the FUNDED_BY edges would be silently dropped on render.
    const nodeIds = new Set(nodes.map((node) => node.id));
    for (const [funder, group] of overlappingFunders) {
        if (nodeIds.has(funder)) continue;
        nodeIds.add(funder);
        nodes.push({
            id: funder,
            label: shortAddress(funder),
            balancePct: 0,
            // The funder is the hub of its own cluster, so it is a member by
            // definition — it is the shared control point.
            isClusterMember: group.length >= MIN_WALLETS_PER_FUNDER,
        });
    }

    const edges: ClusterEdge[] = [];
    const seenEdges = new Set<string>();

    const addEdge = (source: string, target: string, type: ClusterEdge['type']) => {
        const key = `${source}|${target}|${type}`;
        if (seenEdges.has(key)) return;
        seenEdges.add(key);
        edges.push({ source, target, type });
    };

    for (const [funder, group] of overlappingFunders) {
        // The funder is the edge source; each funded wallet points back at it.
        for (const holder of group) {
            addEdge(funder, holder.address, 'FUNDED_BY');
        }
    }

    // --- 6. Assemble result -----------------------------------------------
    const riskLevel = assignCabalRiskLevel(
        cabalSupplyPct,
        fundingSourceOverlapCount
    );

    // An empty holder set is not evidence of safety — it means the holder
    // discovery step produced nothing (no logs, all reads reverted, or the
    // token is not an ERC-20 at all). Flag it so callers never present the
    // resulting LOW as a real verdict.
    const isUnavailable = uniqueHolders.length === 0;
    const warnings = isUnavailable
        ? ['No holder data could be read on-chain; risk level is not a verdict.']
        : [];

    return {
        tokenAddress: normalizedToken,
        totalAnalyzedWallets: uniqueHolders.length,
        clusteredWallets: clusterMembers.size,
        cabalSupplyPct,
        fundingSourceOverlapCount,
        riskLevel,
        clusterGraphJson: JSON.stringify({ nodes, edges }),
        analyzedAt: new Date().toISOString(),
        isDefault: false,
        isUnavailable,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** True when a Turso/libSQL error is a foreign-key violation. */
function isForeignKeyViolation(error: unknown): boolean {
    const text = errorMessage(error).toUpperCase();
    return text.includes('FOREIGN KEY') || text.includes('SQLITE_CONSTRAINT');
}

/**
 * Insert a minimal `launches` row so `insider_clusters`' foreign key is
 * satisfied for a token the indexer has not seen yet.
 *
 * `INSERT OR IGNORE` is essential: if the indexer later writes the real row,
 * or if a concurrent request already created the stub, this is a no-op and
 * never clobbers authoritative launch data.
 */
async function ensureLaunchStub(tokenAddress: string): Promise<void> {
    await getDb().execute({
        sql: `INSERT OR IGNORE INTO launches (
                launch_id, token_address, amm_address, dev_address, pair_symbol,
                liquidity_deposited, curve_progress, launch_block, name, symbol
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            `cabal-stub-${tokenAddress}`,
            tokenAddress,
            '',
            '',
            '',
            0,
            0,
            0,
            'Unindexed Token',
            'UNKNOWN',
        ],
    });
}

/**
 * Analyse `holders` and upsert the verdict into `insider_clusters`.
 *
 * Returns the computed result regardless of whether the write succeeded.
 * Database failures are logged and swallowed — the caller never sees a throw.
 *
 * `insider_clusters.token_address` carries a foreign key to `launches`, so a
 * token that the indexer has not yet recorded cannot be cached. On an FK
 * violation we create a minimal `launches` stub and retry once; without this
 * every request for an unindexed token re-ran the full on-chain scan.
 */
export async function scoreAndPersistCabal(
    tokenAddress: string,
    holders: HolderData[]
): Promise<CabalAnalysisResult> {
    const result = analyzeCabalClusters(tokenAddress, holders);

    const upsert = () =>
        getDb().execute({
            sql: `INSERT INTO insider_clusters (
                    token_address,
                    total_analyzed_wallets,
                    clustered_wallets,
                    cabal_supply_pct,
                    funding_source_overlap_count,
                    risk_level,
                    cluster_graph_json,
                    analyzed_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                  ON CONFLICT(token_address) DO UPDATE SET
                    total_analyzed_wallets = excluded.total_analyzed_wallets,
                    clustered_wallets = excluded.clustered_wallets,
                    cabal_supply_pct = excluded.cabal_supply_pct,
                    funding_source_overlap_count = excluded.funding_source_overlap_count,
                    risk_level = excluded.risk_level,
                    cluster_graph_json = excluded.cluster_graph_json,
                    analyzed_at = CURRENT_TIMESTAMP`,
            args: [
                result.tokenAddress,
                result.totalAnalyzedWallets,
                result.clusteredWallets,
                result.cabalSupplyPct,
                result.fundingSourceOverlapCount,
                result.riskLevel,
                result.clusterGraphJson,
            ],
        });

    try {
        await upsert();
    } catch (error) {
        if (!isForeignKeyViolation(error)) {
            // Never let a DB outage break the caller.
            console.warn(
                `[cabalDetector] Failed to persist analysis for ${tokenAddress}: ${errorMessage(error)}`
            );
            return result;
        }

        // Token is not in `launches` yet — stub it and retry exactly once.
        try {
            await ensureLaunchStub(result.tokenAddress);
            await upsert();
        } catch (retryError) {
            console.warn(
                `[cabalDetector] Failed to persist analysis for ${tokenAddress} after launch stub: ${errorMessage(retryError)}`
            );
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Zeroed analysis returned when a token has no row yet. */
export function defaultCabalAnalysis(tokenAddress: string): CabalAnalysisResult {
    return {
        tokenAddress: tokenAddress.toLowerCase(),
        totalAnalyzedWallets: 0,
        clusteredWallets: 0,
        cabalSupplyPct: 0,
        fundingSourceOverlapCount: 0,
        riskLevel: 'LOW',
        clusterGraphJson: JSON.stringify({ nodes: [], edges: [] }),
        analyzedAt: new Date(0).toISOString(),
        isDefault: true,
        isUnavailable: false,
        warnings: [],
    };
}

/**
 * Explicit "could not analyse" result.
 *
 * Used when holder discovery fails outright (e.g. `totalSupply()` reverts).
 * `riskLevel` is deliberately `LOW` only as a neutral placeholder — callers
 * MUST check `isUnavailable` and avoid presenting it as a safety verdict.
 */
export function unavailableCabalAnalysis(
    tokenAddress: string,
    warnings: string[]
): CabalAnalysisResult {
    return {
        tokenAddress: tokenAddress.toLowerCase(),
        totalAnalyzedWallets: 0,
        clusteredWallets: 0,
        cabalSupplyPct: 0,
        fundingSourceOverlapCount: 0,
        riskLevel: 'LOW',
        clusterGraphJson: JSON.stringify({ nodes: [], edges: [] }),
        analyzedAt: new Date().toISOString(),
        isDefault: false,
        isUnavailable: true,
        warnings: warnings.length > 0
            ? warnings
            : ['Holder data unavailable; risk level is not a verdict.'],
    };
}

/**
 * Read the latest analysis row for a token.
 *
 * Returns a zeroed default (`riskLevel: 'LOW'`, empty graph) when the token has
 * no row yet, or when the query fails — this helper never throws.
 */
export async function getCabalAnalysis(
    tokenAddress: string
): Promise<CabalAnalysisResult> {
    const normalized = tokenAddress.toLowerCase();

    try {
        const res = await getDb().execute({
            sql: `SELECT
                    token_address,
                    total_analyzed_wallets,
                    clustered_wallets,
                    cabal_supply_pct,
                    funding_source_overlap_count,
                    risk_level,
                    cluster_graph_json,
                    analyzed_at
                  FROM insider_clusters
                  WHERE token_address = ?
                  LIMIT 1`,
            args: [normalized],
        });

        const row = res.rows[0];
        if (!row) return defaultCabalAnalysis(normalized);

        const rawRisk = String(row.risk_level ?? 'LOW').toUpperCase();
        const riskLevel: CabalRiskLevel =
            rawRisk === 'CRITICAL' || rawRisk === 'HIGH' || rawRisk === 'MEDIUM'
                ? rawRisk
                : 'LOW';

        const graphJson =
            typeof row.cluster_graph_json === 'string' &&
            row.cluster_graph_json.trim().length > 0
                ? row.cluster_graph_json
                : JSON.stringify({ nodes: [], edges: [] });

        return {
            tokenAddress: String(row.token_address ?? normalized).toLowerCase(),
            totalAnalyzedWallets: Number(row.total_analyzed_wallets ?? 0),
            clusteredWallets: Number(row.clustered_wallets ?? 0),
            cabalSupplyPct: Number(row.cabal_supply_pct ?? 0),
            fundingSourceOverlapCount: Number(
                row.funding_source_overlap_count ?? 0
            ),
            riskLevel,
            clusterGraphJson: graphJson,
            analyzedAt: row.analyzed_at
                ? String(row.analyzed_at)
                : new Date(0).toISOString(),
            isDefault: false,
            // A persisted row with zero analysed wallets means the last scan
            // found nothing — surface that instead of a clean LOW.
            isUnavailable: Number(row.total_analyzed_wallets ?? 0) === 0,
            warnings:
                Number(row.total_analyzed_wallets ?? 0) === 0
                    ? ['No holder data could be read on-chain; risk level is not a verdict.']
                    : [],
        };
    } catch (error) {
        console.warn(
            `[cabalDetector] Failed to read analysis for ${tokenAddress}: ${errorMessage(error)}`
        );
        return defaultCabalAnalysis(normalized);
    }
}
