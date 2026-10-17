/**
 * EVM Security Simulator
 * ======================
 *
 * Static safety analysis for VibeVibe launchpad tokens on Robinhood Chain
 * testnet (chain id 46630).
 *
 * Design notes
 * ------------
 * This module is deliberately *read-only and non-invasive*. It never sends
 * `eth_call` with a `value`, never uses `stateOverride` / `stateDiff`, and
 * never broadcasts a transaction. Public RPC nodes reject simulated value
 * transfers from unfunded accounts, which previously produced false-positive
 * honeypot verdicts — so dynamic buy/sell replay has been removed entirely.
 *
 * Analysis is therefore two-layered:
 *
 *  1. BYTECODE (static) — scan the deployed runtime bytecode for the 4-byte
 *     selectors of blacklist, mint and pause entry points. Selectors are
 *     computed with `toFunctionSelector`, so matching is exact rather than a
 *     fragile source-string search.
 *
 *  2. STATE READS — best-effort `readContract` probes for fee / ownership /
 *     limit parameters (`buyFee`, `sellFee`, `owner`, `maxTxAmount`, ...).
 *     Every probe is individually wrapped in try/catch: a method the token does
 *     not implement, or an RPC hiccup, degrades to `null` and never throws.
 *
 * The verdict is then persisted to the `security_simulations` table created by
 * scripts/migrations/002_analytics_tables.sql.
 */
import {
    createPublicClient,
    http,
    fallback,
    defineChain,
    parseAbi,
    toFunctionSelector,
    type Address,
    type Hex,
    type PublicClient,
} from 'viem';
import { createClient, type Client as LibsqlClient } from '@libsql/client';

// ---------------------------------------------------------------------------
// Chain + contract addresses (verified against vibevibe.md §5 — do not invent).
// ---------------------------------------------------------------------------
export const robinhoodTestnet = defineChain({
    id: 46630,
    name: 'Robinhood Chain Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
    blockExplorers: {
        default: { name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com' },
    },
    testnet: true,
});

export const FACTORY_ADDRESS: Address = '0xe794217880011f9cA6961340eD5c16EC9559Fea0';
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// RPC client — same resilient transport policy as indexer.ts: explicit
// timeout + retries, with an optional SECONDARY_RPC_URL failover.
// ---------------------------------------------------------------------------
const PRIMARY_RPC_URL =
    process.env.PRIMARY_RPC_URL || 'https://rpc.testnet.chain.robinhood.com';
const SECONDARY_RPC_URL = process.env.SECONDARY_RPC_URL;

export const publicClient: PublicClient = createPublicClient({
    chain: robinhoodTestnet,
    transport: fallback(
        [
            http(PRIMARY_RPC_URL, { timeout: 20000, retryCount: 5, retryDelay: 1000 }),
            ...(SECONDARY_RPC_URL
                ? [http(SECONDARY_RPC_URL, { timeout: 20000, retryCount: 5, retryDelay: 1000 })]
                : []),
        ],
        { rank: false, retryCount: 2 }
    ),
});

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------
const FACTORY_ABI = parseAbi([
    'function curveOf(address token) view returns (address)',
]);

const CURVE_ABI = parseAbi([
    'function pairCurrency() view returns (address)',
    'function complete() view returns (bool)',
    'function currentRateBps() view returns (uint256)',
]);

/**
 * Optional token parameters. None of these are guaranteed to exist on a given
 * token, so each read is individually guarded.
 */
const TOKEN_PARAMS_ABI = parseAbi([
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function owner() view returns (address)',
    'function buyFee() view returns (uint256)',
    'function sellFee() view returns (uint256)',
    'function buyTax() view returns (uint256)',
    'function sellTax() view returns (uint256)',
    'function baseTaxBps() view returns (uint256)',
    'function maxTxAmount() view returns (uint256)',
    'function maxWalletAmount() view returns (uint256)',
    'function paused() view returns (bool)',
]);

// ---------------------------------------------------------------------------
// Bytecode signatures
// ---------------------------------------------------------------------------

/** Entry points that imply the owner can freeze / block specific wallets. */
const BLACKLIST_SIGNATURES = [
    'function isBlacklisted(address) view returns (bool)',
    'function isBlackListed(address) view returns (bool)',
    'function isBlocked(address) view returns (bool)',
    'function blacklist(address)',
    'function blackList(address)',
    'function setBlacklist(address,bool)',
    'function setBlackList(address,bool)',
    'function addToBlacklist(address)',
    'function addToBlackList(address)',
    'function addBlacklist(address)',
    'function addBlackList(address)',
    'function removeFromBlacklist(address)',
    'function removeFromBlackList(address)',
    'function setBot(address,bool)',
    'function setBots(address[],bool)',
] as const;

/** Entry points that imply new supply can be created after launch. */
const MINT_SIGNATURES = [
    'function mint(address,uint256)',
    'function mint(address,uint256,bytes)',
    'function mintTo(address,uint256)',
    'function mintTokens(address,uint256)',
    'function issue(uint256)',
] as const;

/** Entry points that imply trading can be halted by the owner. */
const PAUSABLE_SIGNATURES = [
    'function pause()',
    'function unpause()',
    'function paused() view returns (bool)',
    'function setPaused(bool)',
    'function pauseTrading()',
    'function unpauseTrading()',
] as const;

const BLACKLIST_SELECTORS = BLACKLIST_SIGNATURES.map((sig) => toFunctionSelector(sig));
const MINT_SELECTORS = MINT_SIGNATURES.map((sig) => toFunctionSelector(sig));
const PAUSABLE_SELECTORS = PAUSABLE_SIGNATURES.map((sig) => toFunctionSelector(sig));

/** Strip the 0x prefix and lowercase so selector matching is byte-exact. */
function normalizeBytecode(bytecode: Hex | undefined): string {
    return (bytecode ?? '0x').toLowerCase().replace(/^0x/, '');
}

/**
 * A selector is "present" when its 4-byte sequence appears anywhere in the
 * runtime code. This is a heuristic: it can produce false positives when the
 * bytes occur inside push-data, but it never misses a real dispatcher entry.
 */
function containsSelector(code: string, selector: Hex): boolean {
    return code.includes(selector.toLowerCase().replace(/^0x/, ''));
}

function matchSignatures(
    code: string,
    signatures: readonly string[],
    selectors: Hex[]
): string[] {
    const matched: string[] = [];
    signatures.forEach((sig, i) => {
        if (containsSelector(code, selectors[i])) matched.push(sig);
    });
    return matched;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface SecuritySimulationResult {
    token_address: Address;
    is_honeypot: boolean;
    buy_tax_percent: number;
    sell_tax_percent: number;
    can_black_list: boolean;
    is_mintable: boolean;
    risk_level: RiskLevel;
    simulated_at: string;
    /** Extra diagnostics — not persisted, useful for logs / API responses. */
    details: {
        has_bytecode: boolean;
        curve_address: Address | null;
        curve_complete: boolean | null;
        pair_currency: Address | null;
        token_decimals: number;
        /** Owner address, when the token exposes `owner()`. */
        owner: Address | null;
        /** Whether the token exposes a pause mechanism. */
        is_pausable: boolean;
        /** Whether `paused()` returned true (null when unsupported). */
        is_paused: boolean | null;
        /** Raw `maxTxAmount`, when exposed. */
        max_tx_amount: string | null;
        /** Raw `maxWalletAmount`, when exposed. */
        max_wallet_amount: string | null;
        /** Selectors that matched, for auditability. */
        matched_blacklist_selectors: string[];
        matched_mint_selectors: string[];
        matched_pausable_selectors: string[];
        /** Non-fatal RPC / ABI failures encountered while probing. */
        warnings: string[];
        /** True when the curve could not be resolved via the factory. */
        curve_unavailable: boolean;
    };
}

// ---------------------------------------------------------------------------
// Turso client (lazy — the module is importable from Next.js route handlers
// where env vars are only available at request time).
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

/**
 * Upsert a simulation verdict into `security_simulations`.
 * Idempotent: re-running for the same token refreshes the row.
 */
export async function persistSecuritySimulation(
    result: SecuritySimulationResult
): Promise<void> {
    await getDb().execute({
        sql: `INSERT INTO security_simulations (
                token_address,
                is_honeypot,
                buy_tax_percent,
                sell_tax_percent,
                can_black_list,
                is_mintable,
                risk_level,
                simulated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(token_address) DO UPDATE SET
                is_honeypot = excluded.is_honeypot,
                buy_tax_percent = excluded.buy_tax_percent,
                sell_tax_percent = excluded.sell_tax_percent,
                can_black_list = excluded.can_black_list,
                is_mintable = excluded.is_mintable,
                risk_level = excluded.risk_level,
                simulated_at = CURRENT_TIMESTAMP`,
        args: [
            result.token_address.toLowerCase(),
            result.is_honeypot ? 1 : 0,
            result.buy_tax_percent,
            result.sell_tax_percent,
            result.can_black_list ? 1 : 0,
            result.is_mintable ? 1 : 0,
            result.risk_level,
        ],
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const round2 = (value: number) => Math.round(value * 100) / 100;

/** Clamp a computed tax into a sane 0-100 range. */
const clampTax = (value: number) => Math.min(100, Math.max(0, value));

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        const anyErr = error as any;
        return (anyErr.shortMessage || anyErr.details || error.message)
            .toString()
            .slice(0, 200);
    }
    return String(error).slice(0, 200);
}

/**
 * Best-effort `readContract`. Returns `null` instead of throwing when the
 * method is unsupported or the RPC call fails, recording a warning.
 */
async function safeRead<T>(
    params: Parameters<PublicClient['readContract']>[0],
    warnings: string[],
    label: string
): Promise<T | null> {
    try {
        return (await publicClient.readContract(params as any)) as T;
    } catch (error) {
        warnings.push(`${label}: ${errorMessage(error)}`);
        return null;
    }
}

/**
 * Normalise a fee value to a percentage. Tokens express fees inconsistently:
 * basis points (e.g. 500 = 5%), raw percent (5), or 1e18-scaled (5e16).
 */
function feeToPercent(raw: bigint | null): number | null {
    if (raw === null) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value >= 1e15) return clampTax(value / 1e16); // 1e18-scaled
    if (value > 1000) return clampTax(value / 100); // basis points
    return clampTax(value); // already a percent
}

/**
 * Assign a risk level from the static + state signals.
 *
 *   blacklist + mint + pausable -> CRITICAL
 *   sell tax > 15% OR blacklist -> HIGH
 *   sell tax 5% - 15% OR mintable OR pausable -> MEDIUM
 *   otherwise                   -> LOW
 *
 * When no signal could be read at all, the caller passes the baseline values
 * produced by `baselineResult()` instead of calling this function.
 */
export function assignRiskLevel(params: {
    isHoneypot: boolean;
    sellTaxPercent: number;
    canBlackList: boolean;
    isMintable?: boolean;
    isPausable?: boolean;
}): RiskLevel {
    if (params.isHoneypot) return 'CRITICAL';
    if (params.canBlackList && params.isMintable && params.isPausable) return 'CRITICAL';
    if (params.sellTaxPercent > 15 || params.canBlackList) return 'HIGH';
    if (params.sellTaxPercent >= 5 || params.isMintable || params.isPausable) return 'MEDIUM';
    return 'LOW';
}

/**
 * Default verdict used when the RPC is unreachable or the token cannot be
 * inspected at all. Deliberately conservative (MEDIUM) rather than throwing.
 */
export function baselineResult(
    tokenAddress: Address,
    reason: string
): SecuritySimulationResult {
    return {
        token_address: tokenAddress,
        is_honeypot: false,
        buy_tax_percent: 0,
        sell_tax_percent: 0,
        can_black_list: false,
        is_mintable: false,
        risk_level: 'MEDIUM',
        simulated_at: new Date().toISOString(),
        details: {
            has_bytecode: false,
            curve_address: null,
            curve_complete: null,
            pair_currency: null,
            token_decimals: 18,
            owner: null,
            is_pausable: false,
            is_paused: null,
            max_tx_amount: null,
            max_wallet_amount: null,
            matched_blacklist_selectors: [],
            matched_mint_selectors: [],
            matched_pausable_selectors: [],
            warnings: [reason],
            curve_unavailable: true,
        },
    };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Analyse the security profile of a token and persist the verdict.
 *
 * Never throws for RPC-level failures: if bytecode cannot be fetched the
 * function returns `baselineResult()` (MEDIUM risk) instead.
 *
 * @param tokenAddress ERC-20 token address on Robinhood Chain testnet.
 * @param options.persist Set to false to skip the Turso upsert (default true).
 */
export async function simulateTokenSecurity(
    tokenAddress: `0x${string}`,
    options: { persist?: boolean } = {}
): Promise<SecuritySimulationResult> {
    const { persist = true } = options;
    const token = tokenAddress as Address;
    const warnings: string[] = [];

    // -----------------------------------------------------------------------
    // 1. Bytecode fetch + static selector scan
    // -----------------------------------------------------------------------
    let code = '';
    try {
        const bytecode = await publicClient.getBytecode({ address: token });
        code = normalizeBytecode(bytecode);
    } catch (error) {
        // RPC unreachable — degrade to the baseline verdict rather than throw.
        const fallback = baselineResult(token, `getBytecode failed: ${errorMessage(error)}`);
        if (persist) await persistSecuritySimulation(fallback).catch(() => undefined);
        return fallback;
    }

    const hasBytecode = code.length > 0;

    if (!hasBytecode) {
        // No contract at this address — nothing can be traded, so treat it as
        // maximally unsafe rather than silently returning LOW.
        const result: SecuritySimulationResult = {
            ...baselineResult(token, 'No contract bytecode at address'),
            is_honeypot: true,
            buy_tax_percent: 100,
            sell_tax_percent: 100,
            risk_level: 'CRITICAL',
        };
        if (persist) await persistSecuritySimulation(result).catch(() => undefined);
        return result;
    }

    const matchedBlacklist = matchSignatures(code, BLACKLIST_SIGNATURES, BLACKLIST_SELECTORS);
    const matchedMint = matchSignatures(code, MINT_SIGNATURES, MINT_SELECTORS);
    const matchedPausable = matchSignatures(code, PAUSABLE_SIGNATURES, PAUSABLE_SELECTORS);

    const canBlackList = matchedBlacklist.length > 0;
    const isMintable = matchedMint.length > 0;
    const isPausable = matchedPausable.length > 0;

    // -----------------------------------------------------------------------
    // 2. State reads — every probe is independently guarded
    // -----------------------------------------------------------------------
    const decimalsRaw = await safeRead<number>(
        { address: token, abi: TOKEN_PARAMS_ABI, functionName: 'decimals' },
        warnings,
        'decimals'
    );
    const decimals = decimalsRaw === null ? 18 : Number(decimalsRaw);

    const owner = await safeRead<Address>(
        { address: token, abi: TOKEN_PARAMS_ABI, functionName: 'owner' },
        warnings,
        'owner'
    );

    const pausedRaw = await safeRead<boolean>(
        { address: token, abi: TOKEN_PARAMS_ABI, functionName: 'paused' },
        warnings,
        'paused'
    );

    const maxTxRaw = await safeRead<bigint>(
        { address: token, abi: TOKEN_PARAMS_ABI, functionName: 'maxTxAmount' },
        warnings,
        'maxTxAmount'
    );
    const maxWalletRaw = await safeRead<bigint>(
        { address: token, abi: TOKEN_PARAMS_ABI, functionName: 'maxWalletAmount' },
        warnings,
        'maxWalletAmount'
    );

    // Fee probes: try the common naming variants in order, first hit wins.
    const buyFeeRaw =
        (await safeRead<bigint>(
            { address: token, abi: TOKEN_PARAMS_ABI, functionName: 'buyFee' },
            warnings,
            'buyFee'
        )) ??
        (await safeRead<bigint>(
            { address: token, abi: TOKEN_PARAMS_ABI, functionName: 'buyTax' },
            warnings,
            'buyTax'
        ));

    const sellFeeRaw =
        (await safeRead<bigint>(
            { address: token, abi: TOKEN_PARAMS_ABI, functionName: 'sellFee' },
            warnings,
            'sellFee'
        )) ??
        (await safeRead<bigint>(
            { address: token, abi: TOKEN_PARAMS_ABI, functionName: 'sellTax' },
            warnings,
            'sellTax'
        )) ??
        (await safeRead<bigint>(
            { address: token, abi: TOKEN_PARAMS_ABI, functionName: 'baseTaxBps' },
            warnings,
            'baseTaxBps'
        ));

    let buyTaxPercent = feeToPercent(buyFeeRaw) ?? 0;
    let sellTaxPercent = feeToPercent(sellFeeRaw) ?? 0;

    // -----------------------------------------------------------------------
    // 3. Curve metadata (optional — graduated tokens have none)
    // -----------------------------------------------------------------------
    let curve: Address | null = null;
    const resolvedCurve = await safeRead<Address>(
        {
            address: FACTORY_ADDRESS,
            abi: FACTORY_ABI,
            functionName: 'curveOf',
            args: [token],
        },
        warnings,
        'curveOf'
    );
    if (resolvedCurve && resolvedCurve !== ZERO_ADDRESS) curve = resolvedCurve;

    let pairCurrency: Address | null = null;
    let curveComplete: boolean | null = null;
    if (curve) {
        pairCurrency = await safeRead<Address>(
            { address: curve, abi: CURVE_ABI, functionName: 'pairCurrency' },
            warnings,
            'pairCurrency'
        );
        curveComplete = await safeRead<boolean>(
            { address: curve, abi: CURVE_ABI, functionName: 'complete' },
            warnings,
            'complete'
        );

        // The curve's live tax rate is authoritative for launchpad tokens and
        // overrides any token-level fee guess when available.
        const rateBps = await safeRead<bigint>(
            { address: curve, abi: CURVE_ABI, functionName: 'currentRateBps' },
            warnings,
            'currentRateBps'
        );
        if (rateBps !== null) {
            const curveTax = clampTax(Number(rateBps) / 100);
            if (curveTax > 0) {
                buyTaxPercent = curveTax;
                sellTaxPercent = curveTax;
            }
        }
    }

    // -----------------------------------------------------------------------
    // 4. Risk assignment + persistence
    // -----------------------------------------------------------------------
    const riskLevel = assignRiskLevel({
        isHoneypot: false,
        sellTaxPercent,
        canBlackList,
        isMintable,
        isPausable,
    });

    const result: SecuritySimulationResult = {
        token_address: token,
        is_honeypot: false,
        buy_tax_percent: round2(buyTaxPercent),
        sell_tax_percent: round2(sellTaxPercent),
        can_black_list: canBlackList,
        is_mintable: isMintable,
        risk_level: riskLevel,
        simulated_at: new Date().toISOString(),
        details: {
            has_bytecode: true,
            curve_address: curve,
            curve_complete: curveComplete,
            pair_currency: pairCurrency,
            token_decimals: decimals,
            owner: owner ?? null,
            is_pausable: isPausable,
            is_paused: pausedRaw ?? null,
            max_tx_amount: maxTxRaw === null ? null : maxTxRaw.toString(),
            max_wallet_amount: maxWalletRaw === null ? null : maxWalletRaw.toString(),
            matched_blacklist_selectors: matchedBlacklist,
            matched_mint_selectors: matchedMint,
            matched_pausable_selectors: matchedPausable,
            warnings,
            curve_unavailable: curve === null,
        },
    };

    if (persist) await persistSecuritySimulation(result).catch(() => undefined);

    return result;
}
