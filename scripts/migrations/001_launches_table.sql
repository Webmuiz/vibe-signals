-- 001_launches_table.sql
--
-- Creates the core `launches` table.
--
-- WHY THIS EXISTS: the migration set previously started at 002 and only ever
-- ran ALTER TABLE statements against `launches`. That worked because the table
-- had been created by hand in the original Turso database. Pointing the app at
-- a FRESH Turso instance therefore fails immediately:
--
--   SQLITE_UNKNOWN: no such table: launches
--
-- and 004 (`ALTER TABLE launches ADD COLUMN pair_currency_address`) aborts the
-- whole migration run. This file makes a brand-new database bootstrappable.
--
-- The column set is the union of every column read or written by:
--   • indexer.ts                       (LaunchCreated INSERT + momentum UPDATE)
--   • app/api/indexToken/route.ts      (JIT upsert)
--   • app/api/tokens/route.ts          (BASE_COLUMNS projection)
--   • app/api/signals/route.ts         (feed projection)
--   • app/api/leaderboard/route.ts     (leaderboard projection)
--
-- Idempotent: safe to re-run against an existing database.

CREATE TABLE IF NOT EXISTS launches (
    -- Primary key. `launch_id` is the on-chain sequential id from the factory.
    launch_id INTEGER PRIMARY KEY,

    -- `token_address` is the natural key every upsert conflicts on
    -- (`ON CONFLICT(token_address) DO UPDATE`), so it MUST be UNIQUE.
    token_address TEXT NOT NULL UNIQUE,

    -- Bonding-curve contract address; the indexer attaches a trade watcher here.
    amm_address TEXT,

    -- Creator / launcher wallet. Used for block-0 sniper exclusion and the
    -- developer profiler.
    dev_address TEXT,

    -- Quote asset. `pair_symbol` may be NULL (e.g. MOBLAND);
    -- `pair_currency_address` is the authoritative key for USD-rate lookups.
    pair_symbol TEXT,
    pair_currency_address TEXT,

    -- Curve state. Only ever moves UP (non-regression guards in the indexer).
    liquidity_deposited REAL DEFAULT 0,
    curve_progress REAL DEFAULT 0,

    -- Block the launch landed in. Compared against trade blocks to detect
    -- block-0 snipers.
    launch_block INTEGER,

    -- Display metadata.
    name TEXT,
    symbol TEXT,

    -- Immutable on-chain launch timestamp. COALESCEd to insert time when the
    -- block read fails; never rewritten by a later re-index.
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- Momentum counters, maintained by updateMomentumInDatabase().
    volume_eth REAL DEFAULT 0,
    buy_count INTEGER DEFAULT 0,
    sell_count INTEGER DEFAULT 0,
    buy_pct REAL DEFAULT 50,
    sell_pct REAL DEFAULT 50,

    -- Sniper analytics. `sniper_wallets` is a JSON.stringify()'d array of
    -- lowercased wallet addresses, deduped in-process.
    block_zero_buyers INTEGER DEFAULT 0,
    sniper_wallets TEXT DEFAULT '[]',
    sniper_retention_pct REAL,

    -- Off-chain enrichment, refreshed by the live balance updater.
    -- `has_socials` is sticky: once 1 it is never set back to 0.
    has_socials INTEGER DEFAULT 0,
    cachedMarketCapFormatted TEXT,

    -- Probed at runtime by hasCreatorHoldingColumn(); the dashboard tolerates
    -- its absence, but a fresh DB should have it so the probe succeeds.
    creator_holding_pct REAL
);

-- The feed, leaderboard and /api/tokens all do
-- `ORDER BY launch_id DESC LIMIT n`, so this index serves every hot read path.
CREATE INDEX IF NOT EXISTS idx_launches_launch_id
    ON launches (launch_id DESC);

-- Momentum updates and JIT upserts both filter on token_address.
CREATE INDEX IF NOT EXISTS idx_launches_token_address
    ON launches (token_address);

-- Newest-first feed ordering by timestamp (used when launch_id ordering is
-- insufficient, e.g. JIT-inserted rows).
CREATE INDEX IF NOT EXISTS idx_launches_created_at
    ON launches (created_at DESC);
