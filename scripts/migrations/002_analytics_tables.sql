-- 002_analytics_tables.sql
-- Analytics tables for the Mindshare and Security Simulator modules.
-- Idempotent: safe to re-run against an existing Turso database.

CREATE TABLE IF NOT EXISTS mindshare_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL UNIQUE,
    telegram_mentions_24h INTEGER DEFAULT 0,
    unique_channels INTEGER DEFAULT 0,
    sentiment_score REAL DEFAULT 0.0,
    organic_ratio REAL DEFAULT 0.0,
    computed_mindshare_score INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS security_simulations (
    token_address TEXT PRIMARY KEY,
    is_honeypot BOOLEAN DEFAULT FALSE,
    buy_tax_percent REAL DEFAULT 0.0,
    sell_tax_percent REAL DEFAULT 0.0,
    can_black_list BOOLEAN DEFAULT FALSE,
    is_mintable BOOLEAN DEFAULT FALSE,
    risk_level TEXT CHECK(risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    simulated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mindshare_telemetry_score
    ON mindshare_telemetry (computed_mindshare_score DESC);

CREATE INDEX IF NOT EXISTS idx_security_simulations_risk
    ON security_simulations (risk_level);
