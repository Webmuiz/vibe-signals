-- 003_cabal_clusters.sql
-- Insider Cluster Mapping (Cabal Detector) table.
-- Idempotent: safe to re-run against an existing Turso database.

CREATE TABLE IF NOT EXISTS insider_clusters (
    token_address TEXT PRIMARY KEY,
    total_analyzed_wallets INTEGER DEFAULT 0,
    clustered_wallets INTEGER DEFAULT 0,
    cabal_supply_pct REAL DEFAULT 0.0,
    funding_source_overlap_count INTEGER DEFAULT 0,
    risk_level TEXT CHECK(risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    cluster_graph_json TEXT, -- JSON array of linked edges
    analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(token_address) REFERENCES launches(token_address)
);

CREATE INDEX IF NOT EXISTS idx_insider_clusters_risk
    ON insider_clusters (risk_level);

CREATE INDEX IF NOT EXISTS idx_insider_clusters_analyzed_at
    ON insider_clusters (analyzed_at DESC);
