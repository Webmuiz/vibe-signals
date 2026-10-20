-- 004_launches_columns.sql
--
-- Bring the production `launches` table in line with what
-- `app/api/indexToken/route.ts` writes.
--
-- The route upserts `pair_currency_address` (the authoritative quote-asset key
-- used for USD-rate lookups) but the deployed Turso schema predates that
-- column, so every index attempt failed with:
--
--   SQLITE_UNKNOWN: table launches has no column named pair_currency_address
--
-- Verified against production: `block_zero_buyers`, `sniper_wallets` and
-- `sniper_retention_pct` already exist, so only this one column is added.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`; the runner's `_migrations` guard
-- keeps this a one-shot.

ALTER TABLE launches ADD COLUMN pair_currency_address TEXT;
