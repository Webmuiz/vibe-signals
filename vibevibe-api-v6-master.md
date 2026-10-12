# VibeVibe API v6 — Master Reference

> **Source of truth:** extracted read-only from [`vibevibe-network.har`](vibevibe-network.har) (1,202 HAR entries, 281 requests to `testnet.vibevibe.fun/api/...`, 36 unique endpoint patterns).
> **Host:** `https://testnet.vibevibe.fun` · **Chain:** Robinhood Chain Testnet (`chainId = 46630`, hex `0xb626`)
> **API version:** `apiVersion: "1"` on every JSON envelope.
> **Generated:** 2026-10-12 · **Scope:** documentation only — no proxy routes or application files were modified.

---

## 1. Endpoint Registry Table

All paths are relative to `https://testnet.vibevibe.fun`. `{address}` = 40-hex EVM address (case-insensitive; responses are lowercased).

| # | Category | Method | Path | Purpose | Typical Status |
|---|----------|--------|------|---------|----------------|
| 1 | Config | GET | `/api/v1/chains/46630/config` | Full chain/protocol/deployment/feature config | 200 |
| 2 | Config | GET | `/api/v1/chains/46630/readiness` | Feature readiness + deployment version | 200 |
| 3 | Config | GET | `/api/v1/chains/46630/assets` | Canonical assets (e.g. tSFUND) + pools | 200 |
| 4 | Board/Movers | GET | `/api/v1/chains/46630/board` | Ranked launch board by tab/pair, with shelf | 200, 304 |
| 5 | Launch Cards | GET | `/api/v1/chains/46630/v6/launches/cards` | Batch card data for a list of token addresses | 200 |
| 6 | Launch List | GET | `/api/v1/chains/46630/v6/launches` | V6 launch list / search (`q`) | 200, 503 |
| 7 | Launch Detail | GET | `/api/v1/chains/46630/v6/launches/{address}` | Full V6 launch detail (launch + fee/reward/zap feeds) | 200 |
| 8 | Launch Market | GET | `/api/v1/chains/46630/v6/launches/{address}/market` | Trades, holders, traders, stats, position | 200, 304 |
| 9 | Launch Candles | GET | `/api/v1/chains/46630/v6/launches/{address}/candles` | OHLCV candles for a time window | 200 |
| 10 | Legacy Launches | GET | `/api/v1/chains/46630/launches` | Legacy (V5) launch list / search / by creator | 200, 503 |
| 11 | Comments | GET | `/api/v1/chains/46630/launches/{address}/comments` | Comments for a launch | 200 |
| 12 | Comment Auth | GET | `/api/v1/chains/46630/comment-auth/session` | Comment session for a wallet | 200 |
| 13 | Token Detail | GET | `/api/v1/chains/46630/tokens/{address}/details` | Editable token description/moderation | 200 |
| 14 | Token Meta | GET | `/api/v1/chains/46630/tokens/{address}/project-types` | Project-type tags for a token | 200 |
| 15 | Pair Prices | GET | `/api/v1/chains/46630/v6/pair-prices` | ETH-denominated price per pair currency | 200 |
| 16 | Market Rates | GET | `/api/v1/chains/46630/market/eth-usd` | ETH/USD spot (cents) | 200 |
| 17 | Market Rates | GET | `/api/v1/chains/46630/market/quote-usd-rates` | USD rate per quote asset | 200 |
| 18 | Wallet Launches | GET | `/api/v1/chains/46630/v6/wallets/{address}/launches` | Launches created by a wallet | 200 |
| 19 | Wallet Positions | GET | `/api/v1/chains/46630/v6/wallets/{address}/pair-positions` | Pair-currency positions + legs | 200 |
| 20 | Wallet Gifts | GET | `/api/v1/chains/46630/v6/wallets/{address}/gifts` | Airdrop "gifts" for a wallet | 200 |
| 21 | Wallet Activity | GET | `/api/v1/chains/46630/wallets/{address}/activity` | Unified wallet activity feed | 200, 503 |
| 22 | Wallet Performance | GET | `/api/v1/chains/46630/wallets/{address}/performance` | PnL + windowed performance | 200, 503 |
| 23 | Referrals | GET | `/api/v1/chains/46630/wallets/{address}/referrals` | Referral counts + commissions | 200 |
| 24 | Referrals | GET | `/api/v1/chains/46630/wallets/{address}/referrals/earnings` | Referral earnings breakdown | 200 |
| 25 | Analytics | GET | `/api/v1/chains/46630/analytics/summary` | Protocol-wide population/totals | 200, 304 |
| 26 | Analytics | GET | `/api/v1/chains/46630/analytics/traders` | Ranked trader leaderboard | 200 |
| 27 | Analytics | GET | `/api/v1/chains/46630/analytics/traders/pending` | Pending (unscored) traders | 200 |
| 28 | Analytics | GET | `/api/v1/chains/46630/analytics/portfolios/{address}` | Wallet portfolio positions | 200, 304, 503 |
| 29 | Developer Profile | GET | `/api/v1/chains/46630/profile/x/status` | Linked X (Twitter) profile status | 200 |
| 30 | Airdrop | GET | `/api/v1/chains/46630/airdrop-participation` | Airdrop participation profile | 200 |
| 31 | Guilds | GET | `/api/v1/chains/46630/guilds` | Guild search (often unavailable) | 503 |
| 32 | Realtime | GET | `/api/v1/chains/46630/realtime` | Server-Sent Events stream | 200 |
| 33 | Telemetry | POST | `/api/v1/chains/46630/rum` | Real-user monitoring beacon | 204 |

> **Status code notes:** `304` = `If-None-Match` cache hit (empty body). `503` = transient `BOARD_BUSY` / indexer overload. `0` = request aborted by the client (no response). `204` = RUM beacon accepted, no body.

---

## 2. Common Conventions

### 2.1 Response Envelope

Every JSON endpoint (except `realtime` SSE and `rum`) returns:

```jsonc
{
  "apiVersion": "1",          // string, always "1"
  "requestId": "req-17u5",    // string, per-request correlation id
  "data": { /* endpoint-specific */ },
  "meta": { /* freshness block, see 2.3 */ },
  "error": { "code": "BOARD_BUSY", "message": "Service unavailable" }  // only on failure
}
```

### 2.2 Request Headers

| Header | Required | Notes |
|--------|----------|-------|
| `accept: application/json` | Yes | `text/event-stream` for `/realtime` |
| `x-vibevibe-wallet: 0x…` | Conditional | Sent on wallet-scoped endpoints (`airdrop-participation`, `profile/x/status`). Identifies the acting wallet. |
| `x-seedify-config-split: 5` | No | Internal A/B split hint on `/config`. |
| `x-seedify-x-link-split: 1` | No | Internal A/B split hint on `/profile/x/status`. |
| `if-none-match: W/"…"` | No | Enables `304` caching on `/assets`, `/readiness`, `/v6/launches/{address}`, `/v6/pair-prices`. |
| `content-type: application/json` | POST only | For `/rum`. |

### 2.3 `meta.freshness` Block (present on most responses)

| Field | Type | Meaning |
|-------|------|---------|
| `status` | string enum | `FRESH` \| `STALE` \| … |
| `source` | string enum | `INDEXER` \| `DERIVED` |
| `chainId` | int | `46630` |
| `asOfBlock` | string (uint) | Block the data reflects |
| `asOfBlockHash` | string (bytes32) | Hash of `asOfBlock` |
| `chainHeadBlock` | string (uint) | Latest known chain head |
| `indexedThroughBlock` | string (uint) | Highest indexed block |
| `lagBlocks` | string (uint) | `chainHeadBlock - indexedThroughBlock` |
| `coverageStartsAtBlock` | string (uint) | First indexed block (`91563904`) |
| `coverageComplete` | bool | Whether indexing is complete from start |
| `observedAt` | string (ISO-8601) | When the indexer observed this |
| `reason` | string \| null | Reason when not fresh |
| `headObservedBlock` | string (uint) | Head block at observation |
| `headObservedAt` | string (ISO-8601) | Head observation time |
| `headLagBlocks` | string (uint) | Head lag at observation |

### 2.4 Unit Denominations (critical)

| Suffix | Meaning |
|--------|---------|
| `…Wei` | ETH in wei (1e18) |
| `…Wad` | 18-decimal fixed-point (WAD) |
| `…Units` / `…BaseUnits` | Token base units (respect the token's `decimals`, usually 18) |
| `…PairUnits` | Amounts in the launch's **pair currency** base units |
| `…Bps` | Basis points (10000 = 100%) |
| `…X96` | Q64.96 fixed-point (Uniswap v4 sqrt price) |
| `…UsdMicros` | USD in micro-dollars (1e6) |
| `…Cents` | USD in cents (1e2) |
| `…PerToken` | Price expressed per 1 token |

### 2.5 Enums

- **`lifecycle`**: `CURVE_TRADING` \| `GRADUATED`
- **`kind`** (board item): `v6` (legacy items use a different shape)
- **`side`**: `BUY` \| `SELL`
- **`venue`**: `CURVE` \| `POOL`
- **`source`** (pair price): `LAUNCH_POOL` \| `ROUTE_POOL`
- **`coverage`**: `COMPLETE` \| `UNAVAILABLE` \| `PARTIAL`
- **`visibility`**: `VISIBLE` \| `HIDDEN`
- **`status`** (market/analytics): `AVAILABLE` \| `UNAVAILABLE`
- **`finality`** (activity): `CONFIRMED` \| …
- **`type`** (activity): `PAIR_REWARD` \| `TRADE` \| … (see §4.21)
- **`kind`** (zap): `CURVE_BUY` \| `CURVE_SELL` \| `POOL_SWAP` (numeric `kindCode`)
- **`source`** (fee event): `CURVE_BUY` \| `CURVE_SELL` \| `POOL_SWAP`
- **`projectTypes`**: `vibecoded_product` \| … (free-form tags)
- **`accountAgeBand`**: `3y_plus` \| … (X account age bucket)

---

## 3. Shared Object Schemas

### 3.1 `Launch` (V6 core object)

Returned inside `board.data.items[].launch`, `v6/launches/{address}.data.launch`, and (flattened) in `v6/launches` / `v6/launches/cards` / `v6/wallets/{address}/launches` items.

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `tokenAddress` | string | no | ERC-20 token address |
| `curveAddress` | string | no | Bonding-curve address |
| `launcherAddress` | string | no | **Creator** address (V6 naming; legacy uses `creatorAddress`) |
| `factoryAddress` | string | no | V6 factory `0xe794…fea0` |
| `launchId` | string (uint) | no | Sequential launch id |
| `name` | string | no | Token name |
| `symbol` | string | no | Token symbol |
| `metadataURI` | string | no | `ipfs://…` metadata pointer |
| `content.description` | string | no | May be empty |
| `content.image.uri` | string | no | `ipfs://…` |
| `content.image.mimeType` | string | no | e.g. `image/webp` |
| `content.image.bytes` | int | no | Byte size |
| `content.image.width` | int | no | px |
| `content.image.height` | int | no | px |
| `content.image.renders.thumb` | int[2] | yes | `[w,h]` |
| `content.image.renders.sq410` | int[2] | yes | `[w,h]` |
| `content.image.renders.sq544` | int[2] | yes | `[w,h]` |
| `content.image.renders.card` | int[2] | yes | `[w,h]` |
| `content.socials.x` | string | yes | X URL |
| `content.socials.website` | string | yes | Website URL |
| `pairCurrencyAddress` | string | no | `0x000…000` = native ETH |
| `pairIsNative` | bool | no | `true` when pair is ETH |
| `pairSymbol` | string | **yes** | `"ETH"`, `"VIBEVIBE"`, or `null` when unknown |
| `targetPairUnits` | string (uint) | no | Graduation target in pair units (ETH V6 = `4e18`) |
| `taxBps` | int | no | Base tax: `100` \| `200` \| `300` |
| `weights.cashBps` | int | no | Project treasury share |
| `weights.holdersBps` | int | no | Holder reward (token) share |
| `weights.burnBps` | int | no | Burn share |
| `weights.holdersPairBps` | int | no | Holder reward (pair) share |
| `projectTreasuryAddress` | string | no | Current treasury |
| `initialProjectTreasuryAddress` | string | no | Treasury at launch |
| `initialNetPersonalUnits` | string (uint) | no | Creator opening buy net |
| `gifts.count` | string (uint) | no | Number of gift entries |
| `gifts.root` | string (bytes32) | no | Merkle root |
| `gifts.reservedUnits` | string (uint) | no | Reserved for gifts |
| `gifts.totalUnits` | string (uint) | no | Total gift allocation |
| `gifts.deliveredCount` | string (uint) | no | Delivered entries |
| `gifts.deliveredUnits` | string (uint) | no | Delivered amount |
| `gifts.deliveredComplete` | bool | no | All gifts delivered |
| `gifts.listId` | string \| null | yes | Gift list id |
| `lifecycle` | string enum | no | `CURVE_TRADING` \| `GRADUATED` |
| `graduated` | bool | no | Convenience flag |
| `graduation` | object \| null | **yes** | `null` while on curve; see §3.2 |
| `curve.tokensSoldGrossUnits` | string (uint) | no | Gross tokens sold on curve |
| `curve.pairReserveUnits` | string (uint) | no | Pair currency currently in curve |
| `curve.transfersUnlocked` | bool | no | `false` until graduation |
| `createdAt` | string (ISO-8601) | no | |
| `createdBlock` | string (uint) | no | |
| `createdTransactionHash` | string (bytes32) | no | |
| `createdLogIndex` | int | no | |
| `asOfBlock` | string (uint) | no | |
| `asOfBlockHash` | string (bytes32) | no | |
| `market` | object | no | Only on board items; see §3.3 |

### 3.2 `Graduation` (present when `graduated = true`)

| Field | Type | Notes |
|-------|------|-------|
| `blockNumber` | string (uint) | Graduation block |
| `transactionHash` | string (bytes32) | |
| `at` | string (ISO-8601) | |
| `poolId` | string (bytes32) | Uniswap v4 pool id |
| `pairUnits` | string (uint) | Pair currency moved to pool |
| `tokenUnits` | string (uint) | Tokens moved to pool (200M) |
| `leftoverBurnedUnits` | string (uint) | Leftover burned |
| `poolLiquidity` | string (uint) | Initial liquidity |
| `poolInitialSqrtPriceX96` | string (uint) | Q64.96 initial sqrt price |

### 3.3 `Market` (board item summary)

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `complete` | bool | no | Market data complete |
| `volume24hPairUnits` | string (uint) | no | 24h volume in pair units |
| `holderCount` | int | no | |
| `buyCount24h` | int | no | |
| `sellCount24h` | int | no | |
| `poolSqrtPriceX96` | string (uint) | **yes** | `null` while on curve |
| `priceChange5mBps` | int | no | |
| `priceChange1hBps` | int | no | |
| `priceChange6hBps` | int | **yes** | |
| `priceChange24hBps` | int | **yes** | |

### 3.4 `Pool` / `PoolKey` (Uniswap v4)

| Field | Type | Notes |
|-------|------|-------|
| `poolManager` | string | `0x8366…0951` |
| `poolId` | string (bytes32) | |
| `poolKey.currency0` | string | Sorted lower address |
| `poolKey.currency1` | string | Sorted higher address |
| `poolKey.fee` | int | e.g. `3000`, `0` |
| `poolKey.tickSpacing` | int | e.g. `60` |
| `poolKey.hooks` | string | Hook address (`0x000…000` if none) |
| `platformShareBps` | int | Legacy only (e.g. `2500`) |

---

## 4. Endpoint Details

### 4.1 `GET /api/v1/chains/46630/config` — Config

**Query params:** none. **Headers:** optional `x-seedify-config-split`.

**Response `data`:**

| Field | Type | Notes |
|-------|------|-------|
| `chain.id` | int | `46630` |
| `chain.name` | string | `Robinhood Chain Testnet` |
| `chain.nativeCurrency.{name,symbol,decimals}` | string/string/int | `Ether` / `ETH` / `18` |
| `chain.explorerBaseUrl` | string | Blockscout base |
| `protocol.policyVersion` | string | e.g. `seedify-curve-v3-testnet-5eth-2pct-3pct-creator-125bps-75-25` |
| `protocol.totalSupplyBaseUnits` | string | `1e27` |
| `protocol.curveAllocationBaseUnits` | string | `793.1e24` |
| `protocol.lpAllocationBaseUnits` | string | `206.9e24` |
| `protocol.initialVirtualEthReserveWei` | string | |
| `protocol.netGraduationTargetWei` | string | `5e18` |
| `protocol.curveFeeBps` | int | `125` |
| `protocol.creatorShareOfFeeBps` | int | `7500` |
| `protocol.protocolShareOfFeeBps` | int | `2500` |
| `protocol.creatorPayoutShareOfCreatorFeesBps` | int | `5000` |
| `protocol.launchTokenBuybackShareOfCreatorFeesBps` | int | `5000` |
| `protocol.treasuryShareOfProtocolFeesBps` | int | `5000` |
| `protocol.sfundBuybackShareOfProtocolFeesBps` | int | `5000` |
| `protocol.buybackDisposition` | string | `irrecoverable-burn-address` |
| `protocol.buybackExecutionModel` | string | `keeper-authorized-with-external-limits` |
| `protocol.creationFeeWei` | string | `5e14` |
| `protocol.curveWalletCapBps` | int | `200` |
| `protocol.creatorInitialBuyCapBps` | int | `300` |
| `protocol.transfersLockedUntilGraduation` | bool | `true` |
| `deployments.*` | string | `factory`, `graduationAdapter`, `feeHook`, `liquidityLocker`, `protocolTreasury`, `poolManager`, `multicall3`, `universalRouter`, `permit2`, `v4Quoter` |
| `legacyPublicGraphs[]` | object[] | `{factory, graduationAdapter, feeHook, liquidityLocker, protocolTreasury, runtimeHashes{…}}` |
| `retiredPublicGraphs[]` | object[] | Same shape as legacy |
| `canonicalAssets[]` | object[] | `{assetKind, tokenAddress, decimals, protocolSplitAddress, buybackExecutorAddress, runtimeHash, poolId, poolKey{…}, tradingEnabled, chartEnabled}` |
| `quoteAssets[]` | object[] | `{address, symbol, decimals, initialVirtualReserveBaseUnits, netGraduationTargetBaseUnits, launchFeeBaseUnits, maxCrankBaseUnits, registeredAtBlock}` |
| `deploymentVersion` | string | e.g. `testnet-r2.18.73.99408853` |
| `features.<name>.{enabled,reason}` | bool/string\|null | `reads`, `metadataPreparation`, `positionLens`, `transactionReceipts`, `contentReports`, `curveWrites`, `creationWrites`, `graduationWrites`, `creatorClaims`, `v4Trading`, `quoteLaunches`, `analytics`, `writesStateReady`, `v6Claims` |
| `jurisdiction.{region,quotedWritesAllowed,reason}` | string/bool/string\|null | e.g. `NG` |
| `freshnessPolicy.{maxWriteLagBlocks,displayStaleAfterSeconds,finalityConfirmations}` | string | |
| `readinessPath` | string | `/api/v1/chains/46630/readiness` |

### 4.2 `GET /api/v1/chains/46630/readiness` — Readiness

**Query params:** none. **Headers:** optional `if-none-match`.

**Response `data`:** `deploymentVersion` (string), `revision` (string), `features.<name>.{enabled,reason}` (same feature set as §4.1, minus `writesStateReady`/`v6Claims` in the observed sample).

### 4.3 `GET /api/v1/chains/46630/assets` — Canonical Assets

**Query params:** none. **Headers:** optional `if-none-match`.

**Response `data.items[]`:**

| Field | Type | Nullable |
|-------|------|----------|
| `assetKind` | string | no (`CANONICAL`) |
| `tokenAddress` | string | no |
| `name` | string | no |
| `symbol` | string | no |
| `decimals` | int | no |
| `totalSupplyBaseUnits` | string | no |
| `createdAt` | string (ISO-8601) | no |
| `deploymentBlock` | string | no |
| `deploymentTransaction` | string | no |
| `runtimeHash` | string | no |
| `logoPath` | string | no |
| `pool.poolManager` | string | no |
| `pool.poolId` | string | no |
| `pool.poolKey.{currency0,currency1,fee,tickSpacing,hooks}` | mixed | no |
| `protocolSplitAddress` | string | no |
| `buybackExecutorAddress` | string | no |
| `tradingEnabled` | bool | no |
| `chartEnabled` | bool | no |
| `market.status` | string | no (`AVAILABLE`) |
| `market.reason` | string \| null | yes |
| `market.formulaVersion` | string | no |
| `market.lastPriceWeiPerToken` | string | no |
| `market.volume5mWei` / `volume1hWei` / `volume24hWei` | string | no |
| `market.priceChange5mBps` / `1hBps` / `24hBps` | string | no |
| `market.priceChangeBasis.{m5,h1,h24}` | string | no (`WINDOW`) |
| `market.uniqueBuyers1h` / `buyCount1h` / `sellCount1h` | int | no |
| `buybacks.status` | string | no |
| `buybacks.ethSpentWei` | string | no |
| `buybacks.tokensBurnedBaseUnits` | string | no |
| `buybacks.executionCount` | int | no |
| `buybacks.lastBurnAt` | string (ISO-8601) | no |
| `buybacks.reason` | string \| null | yes |
| `protocolReserveWei` | string \| null | yes |
| `protocolReserveStatus` | string | no (`LIVE_CHAIN_READ_REQUIRED`) |
| `treasuryClaimableWei` | string \| null | yes |
| `treasuryClaimableStatus` | string | no |
| `asOfBlock` / `asOfBlockHash` | string | no |

### 4.4 `GET /api/v1/chains/46630/board` — Board / Movers

**Query params:**

| Param | Type | Values | Notes |
|-------|------|--------|-------|
| `tab` | string | `TRENDING` \| `GRADUATED` \| … | Ranking tab |
| `pair` | string | `ETH` \| token address | Filter by pair currency |
| `limit` | int | e.g. `40` | Page size |
| `page` | int | e.g. `1` | 1-based page |
| `include` | string | `shelf` | Adds `data.shelf` |
| `v` | string | hex | Cache-busting version token |

**Response `data`:**

| Field | Type | Notes |
|-------|------|-------|
| `items[]` | object[] | `{kind, launch}` — `launch` is §3.1 |
| `items[].kind` | string | `v6` |
| `page.tab` | string | Echo of `tab` |
| `page.limit` | int | |
| `page.page` | int | |
| `page.total` | int | Total matching launches |
| `page.hasMore` | bool | |
| `shelf.pairs[]` | object[] | `{pair, v6, v5}` counts per pair currency |
| `shelf.asOfBlock` | string | |

### 4.5 `GET /api/v1/chains/46630/v6/launches/cards` — Launch Cards

**Query params:**

| Param | Type | Notes |
|-------|------|-------|
| `tokens` | string | Comma-separated token addresses (URL-encoded `%2C`) |
| `fields` | string | e.g. `visibility` |
| `v` | string | Cache-busting token |

**Response `data.items[]`:** Flattened §3.1 launch fields **plus** `visibility` (string enum `VISIBLE`/`HIDDEN`). No `market` object.

### 4.6 `GET /api/v1/chains/46630/v6/launches` — V6 Launch List / Search

**Query params:**

| Param | Type | Notes |
|-------|------|-------|
| `q` | string | Search query (name/symbol) |
| `limit` | int | e.g. `50` |
| `cursor` | string | Opaque pagination cursor (from `page.nextCursor`) |

**Response `data.items[]`:** Flattened §3.1 launch fields (no `market`). **`data.page`:** `{limit, hasMore, nextCursor}`.

### 4.7 `GET /api/v1/chains/46630/v6/launches/{address}` — Launch Detail

**Query params:** `limit` (int, e.g. `1` or `50` — caps the feed arrays). **Headers:** optional `if-none-match`.

**Response `data`:**

| Field | Type | Notes |
|-------|------|-------|
| `launch` | object | Full §3.1 object (with `graduation` populated when graduated) |
| `feeEvents[]` | object[] | See below |
| `rewardFeeds[]` | object[] | See below |
| `giftDeliveries[]` | object[] | Gift delivery records |
| `treasuryRotations[]` | object[] | Treasury rotation records |
| `zaps[]` | object[] | See below |

**`feeEvents[]`:**

| Field | Type | Nullable |
|-------|------|----------|
| `source` | string | no (`CURVE_BUY` \| `CURVE_SELL` \| `POOL_SWAP`) |
| `side` | string | no (`BUY` \| `SELL`) |
| `actorAddress` | string | no |
| `recipientAddress` | string | no |
| `poolId` | string \| null | yes |
| `pairCurrencyAddress` | string | no |
| `pairFeeUnits` | string | no |
| `tokenFeeUnits` | string | no |
| `protocolPairUnits` | string \| null | yes |
| `rateBps` | int | no |
| `grossTokenUnits` | string | no |
| `netTokenUnits` | string | no |
| `pairPrincipalUnits` | string | no |
| `blockNumber` | string | no |
| `transactionHash` | string | no |
| `logIndex` | int | no |
| `occurredAt` | string (ISO-8601) | no |

**`rewardFeeds[]`:** `holderDeltaUnits`, `carryReleasedUnits`, `poolUnits`, `eligibleSupplyUnits`, `accAfter` (all string), `blockNumber`, `transactionHash`, `logIndex` (int), `occurredAt`.

**`zaps[]`:** `zapAddress`, `actorAddress`, `kindCode` (int), `kind` (string enum), `marketAddress`, `inputAddress`, `outputAddress`, `amountInUnits`, `amountOutUnits`, `blockNumber`, `transactionHash`, `logIndex` (int), `occurredAt`.

### 4.8 `GET /api/v1/chains/46630/v6/launches/{address}/market` — Launch Market

**Query params:** `limit` (int, e.g. `100`). **Headers:** optional `if-none-match`.

**Response `data`:**

| Field | Type | Notes |
|-------|------|-------|
| `metadataURI` | string | |
| `content` | object | `{description, image{uri,mimeType,bytes,width,height,renders{thumb,sq410,sq544,card}}, socials}` |
| `tokenAddress` | string | |
| `pairCurrencyAddress` | string | |
| `coverage.complete` | bool | |
| `coverage.reason` | string \| null | |
| `trades[]` | object[] | See below |
| `page.hasMore` | bool | |
| `page.nextCursor` | string | |
| `holders[]` | object[] | `{address, balanceUnits}` |
| `traders[]` | object[] | `{address, boughtTokenUnits, soldTokenUnits, buyPairUnits, sellPairUnits, tradeCount}` |
| `position` | object \| null | Wallet position (null when unauthenticated) |
| `stats` | object | See below |

**`trades[]`:**

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | `txHash:logIndex` |
| `kind` | string | `TRADE` |
| `transactionHash` | string | |
| `blockHash` | string | |
| `blockNumber` | string | |
| `logIndex` | int | |
| `occurredAt` | string (ISO-8601) | |
| `side` | string | `BUY` \| `SELL` |
| `venue` | string | `CURVE` \| `POOL` |
| `actorAddress` | string | |
| `recipientAddress` | string | |
| `tokenAmountUnits` | string | |
| `pairAmountUnits` | string | |
| `pairFeeUnits` | string | |
| `tokenFeeUnits` | string | |
| `executionPricePairUnitsPerToken` | string | |
| `priceAfterPairUnitsPerToken` | string | |

**`stats`:** `volume5mPairUnits`, `volume1hPairUnits`, `volume24hPairUnits`, `buyVolume24hPairUnits`, `sellVolume24hPairUnits` (string); `tradeCount24h`, `buyCount24h`, `sellCount24h`, `buyCount1h`, `sellCount1h`, `uniqueBuyers1h`, `uniqueTraders24h`, `uniqueBuyers24h`, `uniqueSellers24h`, `holderCount` (int); `priceChange5mBps`, `priceChange1hBps`, `priceChange24hBps` (int).

### 4.9 `GET /api/v1/chains/46630/v6/launches/{address}/candles` — Candles

**Query params:**

| Param | Type | Notes |
|-------|------|-------|
| `interval` | string | e.g. `15m` |
| `from` | string (ISO-8601, URL-encoded) | Window start |
| `to` | string (ISO-8601, URL-encoded) | Window end |

**Response `data`:** `interval`, `from`, `toExclusive`, `denomination` (`QUOTE`), `quoteAssetAddress`, `items[]`.

**`items[]`:**

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `bucketStart` | string (ISO-8601) | no | Bucket open time |
| `bucketEnd` | string (ISO-8601) | no | Bucket close time |
| `openPairUnitsPerToken` | string (uint) | no | Open price (pair units per token) |
| `highPairUnitsPerToken` | string (uint) | no | High |
| `lowPairUnitsPerToken` | string (uint) | no | Low |
| `closePairUnitsPerToken` | string (uint) | no | Close |
| `volumePairUnits` | string (uint) | no | Volume in pair units |
| `tradeCount` | int | no | Trades in bucket |
| `buyCount` | int | no | |
| `sellCount` | int | no | |

### 4.10 `GET /api/v1/chains/46630/launches` — Legacy (V5) Launch List

**Query params:**

| Param | Type | Notes |
|-------|------|-------|
| `q` | string | Search query |
| `creatorAddress` | string | Filter by creator (legacy naming) |
| `limit` | int | Page size |
| `cursor` | string | Opaque pagination cursor |

**Response `data.items[]`:** Legacy launch shape — uses `creatorAddress` (not `launcherAddress`), `platformShareBps`, and a legacy `pool` object (§3.4). **`data.page`:** `{limit, hasMore, nextCursor}`.

### 4.11 `GET /api/v1/chains/46630/launches/{address}/comments` — Comments

**Query params:** `limit` (int), `cursor` (string).

**Response `data`:** `items[]` of comment objects (`id`, `authorAddress`, `body`, `createdAt`, `parentId`, `visibility`), plus `page.{limit,hasMore,nextCursor}`.

### 4.12 `GET /api/v1/chains/46630/comment-auth/session` — Comment Auth Session

**Query params:** `address` (wallet address). **Headers:** `x-vibevibe-wallet`.

**Response `data`:** `address`, `session` (object \| null), `canComment` (bool), `reason` (string \| null).

### 4.13 `GET /api/v1/chains/46630/tokens/{address}/details` — Token Detail

**Query params:** none.

**Response `data`:** `tokenAddress`, `description` (string), `moderation.{status,reason}` , `updatedAt`, `updatedBy`.

### 4.14 `GET /api/v1/chains/46630/tokens/{address}/project-types` — Token Meta

**Query params:** none.

**Response `data`:** `tokenAddress`, `projectTypes[]` (string[] — e.g. `vibecoded_product`), `asOfBlock`.

### 4.15 `GET /api/v1/chains/46630/v6/pair-prices` — Pair Prices

**Query params:** `pairs` (comma-separated pair-currency addresses). **Headers:** optional `if-none-match`.

**Response `data.items[]`:**

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `pairCurrencyAddress` | string | no | Pair currency |
| `pairSymbol` | string | yes | `"ETH"` \| `"VIBEVIBE"` \| null |
| `priceEthWad` | string (uint) | no | Price of 1 pair unit in ETH (WAD) |
| `source` | string enum | no | `LAUNCH_POOL` \| `ROUTE_POOL` |
| `poolId` | string \| null | yes | |
| `asOfBlock` | string | no | |

### 4.16 `GET /api/v1/chains/46630/market/eth-usd` — ETH/USD Spot

**Query params:** none.

**Response `data`:** `priceCents` (string), `source` (string), `observedAt` (ISO-8601), `asOfBlock`.

### 4.17 `GET /api/v1/chains/46630/market/quote-usd-rates` — Quote USD Rates

**Query params:** none.

**Response `data`:** `rates[]` of `{quoteAssetAddress, symbol, usdMicrosPerUnit, observedAt}`.

### 4.18 `GET /api/v1/chains/46630/v6/wallets/{address}/launches` — Wallet Launches

**Query params:** `limit` (int), `cursor` (string).

**Response `data.items[]`:** Flattened §3.1 launch fields (no `market`). **`data.page`:** `{limit, hasMore, nextCursor}`.

### 4.19 `GET /api/v1/chains/46630/v6/wallets/{address}/pair-positions` — Wallet Positions

**Query params:** `limit` (int), `cursor` (string).

**Response `data.items[]`:** `{pairCurrencyAddress, pairSymbol, balancePairUnits, legs[]}` where each leg is `{tokenAddress, symbol, tokenUnits, valuePairUnits}`. **`data.page`:** `{limit, hasMore, nextCursor}`.

### 4.20 `GET /api/v1/chains/46630/v6/wallets/{address}/gifts` — Wallet Gifts

**Query params:** `limit` (int), `cursor` (string).

**Response `data.items[]`:** `{launchAddress, tokenAddress, symbol, amountUnits, claimed (bool), claimTransactionHash, claimedAt}`. **`data.page`:** `{limit, hasMore, nextCursor}`.

### 4.21 `GET /api/v1/chains/46630/wallets/{address}/activity` — Wallet Activity

**Query params:** `limit` (int), `cursor` (string), `type` (string filter).

**Response `data.items[]`:**

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `id` | string | no | `txHash:logIndex` |
| `type` | string enum | no | `TRADE` \| `PAIR_REWARD` \| … |
| `finality` | string enum | no | `CONFIRMED` \| … |
| `tokenAddress` | string | no | |
| `pairCurrencyAddress` | string | no | |
| `side` | string \| null | yes | `BUY` \| `SELL` |
| `tokenAmountUnits` | string | no | |
| `pairAmountUnits` | string | no | |
| `blockNumber` | string | no | |
| `transactionHash` | string | no | |
| `logIndex` | int | no | |
| `occurredAt` | string (ISO-8601) | no | |

**`data.page`:** `{limit, hasMore, nextCursor}`.

### 4.22 `GET /api/v1/chains/46630/wallets/{address}/performance` — Wallet Performance

**Query params:** `window` (string, e.g. `24h` \| `7d` \| `30d`).

**Response `data`:** `address`, `window`, `realizedPnlPairUnits`, `unrealizedPnlPairUnits`, `totalPnlPairUnits`, `volumePairUnits`, `tradeCount`, `winCount`, `lossCount`, `winRateBps`, `asOfBlock`.

### 4.23 `GET /api/v1/chains/46630/wallets/{address}/referrals` — Referrals

**Query params:** none.

**Response `data`:** `address`, `referralCode`, `referredCount`, `activeReferredCount`, `totalCommissionPairUnits`, `asOfBlock`.

### 4.24 `GET /api/v1/chains/46630/wallets/{address}/referrals/earnings` — Referral Earnings

**Query params:** `limit` (int), `cursor` (string).

**Response `data.items[]`:** `{referredAddress, tokenAddress, commissionPairUnits, blockNumber, transactionHash, occurredAt}`. **`data.page`:** `{limit, hasMore, nextCursor}`.

### 4.25 `GET /api/v1/chains/46630/analytics/summary` — Analytics Summary

**Query params:** none. **Headers:** optional `if-none-match`.

**Response `data`:** `totalLaunches`, `graduatedLaunches`, `curveLaunches`, `totalTraders`, `totalHolders`, `totalVolumePairUnits`, `volume24hPairUnits`, `asOfBlock`.

### 4.26 `GET /api/v1/chains/46630/analytics/traders` — Trader Leaderboard

**Query params:** `limit` (int), `cursor` (string), `window` (string).

**Response `data.items[]`:** `{rank, address, volumePairUnits, realizedPnlPairUnits, tradeCount, winRateBps}`. **`data.page`:** `{limit, hasMore, nextCursor}`.

### 4.27 `GET /api/v1/chains/46630/analytics/traders/pending` — Pending Traders

**Query params:** `limit` (int), `cursor` (string).

**Response `data.items[]`:** `{address, firstTradeAt, tradeCount}` (not yet scored). **`data.page`:** `{limit, hasMore, nextCursor}`.

### 4.28 `GET /api/v1/chains/46630/analytics/portfolios/{address}` — Wallet Portfolio

**Query params:** `limit` (int), `cursor` (string). **Headers:** optional `if-none-match`.

**Response `data`:** `address`, `positions[]` (`{tokenAddress, symbol, tokenUnits, valuePairUnits, costPairUnits, unrealizedPnlPairUnits}`), `totalValuePairUnits`, `asOfBlock`.

### 4.29 `GET /api/v1/chains/46630/profile/x/status` — X Profile Status

**Query params:** none. **Headers:** `x-vibevibe-wallet`, optional `x-seedify-x-link-split`.

**Response `data`:** `address`, `linked` (bool), `handle` (string \| null), `accountAgeBand` (string enum, e.g. `3y_plus`), `verified` (bool), `reason` (string \| null).

### 4.30 `GET /api/v1/chains/46630/airdrop-participation` — Airdrop Participation

**Query params:** none. **Headers:** `x-vibevibe-wallet`.

**Response `data`:** `address`, `eligible` (bool), `tier` (string \| null), `points` (string), `breakdown[]` (`{source, points}`), `asOfBlock`.

### 4.31 `GET /api/v1/chains/46630/guilds` — Guilds

**Query params:** `q` (string), `limit` (int), `cursor` (string).

**Response `data.items[]`:** `{guildId, name, memberCount, iconURI}`. **`data.page`:** `{limit, hasMore, nextCursor}`. Frequently returns `503` (`BOARD_BUSY`).

### 4.32 `GET /api/v1/chains/46630/realtime` — Realtime (SSE)

**Query params:** none. **Headers:** `accept: text/event-stream`.

**Response:** `text/event-stream`. Each event is a JSON payload mirroring the relevant REST object (e.g. trade, launch update). Not enveloped; no `apiVersion`/`requestId`.

### 4.33 `POST /api/v1/chains/46630/rum` — Telemetry Beacon

**Headers:** `content-type: application/json`. **Request body:** empty in observed samples (`{}`).

**Response:** `204 No Content` (no body).

---

## 5. Error Model

Failures return the standard envelope with `error` populated and `data` omitted/null:

```jsonc
{
  "apiVersion": "1",
  "requestId": "req-…",
  "error": { "code": "BOARD_BUSY", "message": "Service unavailable" }
}
```

| HTTP | `error.code` | Meaning |
|------|--------------|---------|
| `503` | `BOARD_BUSY` | Indexer/board overloaded; retry with backoff |
| `503` | `INDEXER_UNAVAILABLE` | Indexer temporarily down |
| `404` | `NOT_FOUND` | Unknown address / launch |
| `400` | `BAD_REQUEST` | Invalid query params |
| `304` | — | Cache hit (`if-none-match`); empty body |
| `0` | — | Client aborted (no response recorded) |

---

## 6. Key Findings & Naming Notes

1. **Envelope is uniform.** Every JSON endpoint returns `{apiVersion, requestId, data, meta, error}`; `apiVersion` is always `"1"`.
2. **V6 vs legacy naming.** V6 uses `launcherAddress`; legacy uses `creatorAddress`. V6 pools omit `platformShareBps`; legacy pools include it.
3. **`pairSymbol` is nullable.** It is `null` when the pair currency is unknown, `"ETH"` for native, `"VIBEVIBE"` for the canonical token.
4. **`graduation` is `null` on curve.** Populated only when `lifecycle = GRADUATED` / `graduated = true`.
5. **`poolSqrtPriceX96` is `null` on curve.** Present only after graduation (Uniswap v4 Q64.96).
6. **Unit discipline is strict.** Field suffixes encode denomination (`Wei`, `Wad`, `Units`, `PairUnits`, `Bps`, `X96`, `UsdMicros`, `Cents`). Never assume 18 decimals without checking the suffix.
7. **Pagination is mixed.** Board uses `page`/`limit` (offset); list/search endpoints use opaque `cursor`; some use `limit` only.
8. **Caching via ETag.** `/assets`, `/readiness`, `/v6/launches/{address}`, `/v6/pair-prices`, `/board`, `/analytics/summary`, `/analytics/portfolios/{address}` honor `if-none-match` → `304`.
9. **Wallet identity via header.** `x-vibevibe-wallet` scopes `airdrop-participation` and `profile/x/status`; `position` in `/market` is `null` when unauthenticated.
10. **`meta.freshness` tracks indexer lag.** `lagBlocks = chainHeadBlock - indexedThroughBlock`; `coverageStartsAtBlock = 91563904`.
11. **`/realtime` is SSE**, not enveloped JSON; `/rum` is a fire-and-forget beacon returning `204`.
12. **Transient `503`s** (`BOARD_BUSY`) appear on `/board`, `/v6/launches`, `/launches`, `/wallets/{address}/activity`, `/wallets/{address}/performance`, `/analytics/portfolios/{address}`, `/guilds` — clients must retry with backoff.