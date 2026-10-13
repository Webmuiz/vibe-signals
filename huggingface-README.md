---
title: Vibe Signals Worker
emoji: ⚡
colorFrom: purple
colorTo: gray
sdk: docker
app_port: 7860
---

# Vibe Signals Worker

Background indexing and trade-monitoring worker for Vibe Signals. It listens
for `LaunchCreated` events on the Robinhood Chain testnet factory, attaches
per-curve trade watchers, and keeps the Turso database in sync with live
market data.

## Deployment (Hugging Face Spaces)

1. Create a new Space and select **Docker** as the SDK.
2. Copy the YAML frontmatter above into the Space's `README.md`.
3. Add the following **Secrets** in the Space settings (Settings → Variables
   and secrets). Do **not** commit these values to the repository:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `SECONDARY_RPC_URL` (optional backup RPC)
   - `PRIMARY_RPC_URL` (optional override)
   - `PROXY_BASE_URL` (optional override for the metrics proxy)
4. The container binds to port `7860` and answers `GET /` with
   `{"status":"alive"}` for health checks.

## Local run

```bash
npm install
npm run worker
```
