# ensv2-records

ENS name resolution service for EFP, Ethereum Identity Kit and Grails. It resolves ENSv1, ENSv2 and offchain (CCIP-read) names through the ENS UniversalResolver, and keeps the same HTTP API as the [enstate](https://github.com/v3xlabs/enstate) "ens worker" it replaces. Existing consumers switch over by changing a URL.

Phase 1 (this code) is the stateless resolution API. Phase 2 adds a records indexer for ENSv2 resolvers. It discovers which text keys each name actually has (the UniversalResolver can't list them) and invalidates cached profiles when records change.

## Why not keep enstate

Tested against Sepolia, which has already migrated to ENSv2:

| | enstate v1.1.0 | ensv2-records |
|---|---|---|
| Current UniversalResolver (`0xeEeE…EeEe`) | every request 404s (calls the removed `resolve(bytes,bytes[])`) | ✅ |
| v2 name `resolver` field | the v1→v2 bridge contract | the name's actual resolver |
| Primary names set via the default reverse registrar | 404 | ✅ (UR `reverse`, ENSIP-19) |
| Unregistered / expired `.eth` | 200 with an empty or stale profile | 404 |
| IPNS / Swarm contenthash | error | `ipns://`, `bzz://` |
| Base, Linea, Scroll, zkSync addresses | not fetched | ✅ |
| Name normalization | lowercase only | ENSIP-15 |
| Cache | silently disabled when Redis is unreachable | Redis is a startup error; in-memory if unset |

## API

Routes, field names, bulk format and error bodies follow enstate.

| Route | |
|---|---|
| `GET /n/:name` | Profile for a name |
| `GET /a/:address` | Profile for the address's primary name (404 if none) |
| `GET /u/:nameOrAddress` | Either of the above |
| `GET /i/:nameOrAddress`, `/h/:nameOrAddress` | 303 to the avatar / header image (`data:` images served inline) |
| `GET /bulk/n?names[]=…`, `/bulk/a?addresses[]=…`, `/bulk/u?queries[]=…` | `{response_length, response: [{type:'success', …profile} \| {type:'error', status, error}]}` |
| `GET /this`, `/health` | Version and chain / RPC health |

Add `?fresh=true` to skip the cache read.

```json
{
  "name": "yoginth.eth",
  "address": "0x03Ba34f6Ea1496fa316873CF8350A3f7eaD317EF",
  "avatar": "https://…",
  "header": "https://…",
  "display": "yoginth.eth",
  "contenthash": "ipfs://…",
  "records": { "com.github": "bigint", "…": "…" },
  "chains": { "eth": "0x03Ba…", "btc": "bc1q…", "base": "0x…" },
  "fresh": 1792553446769,
  "resolver": "0x45600dAd96384A0a2A0A9ac9287D943bcFCf3EF9",
  "ccip_urls": ["https://…"],
  "errors": { "records.x": "…" }
}
```

Optional fields are omitted when empty. Errors are `{"status":404,"error":"Not Found"}` and `{"status":400,"error":"invalid name: …"}`.

Differences from enstate:
- `address` is omitted, not `0x000…000`, when a name has no ETH address.
- The default key list is larger and includes `status`.
- **Offchain names** fetch only the core records (`CORE_RECORD_KEYS` in `src/records.ts`). Every offchain lookup is a separate HTTP request to the name's gateway, and gateways rate-limit hard.

## How resolution works

- **Forward:** one `resolveWithGateways(name, multicall([...]))` call to the UniversalResolver per profile. On-chain resolvers handle 500+ lookups in one call; we measured under 220ms. Core records go first. If that call went offchain, the rest are skipped; otherwise a second call fetches them.
- **CCIP-read:** handled by viem's local batch gateway. Requests are capped per gateway host (`CCIP_CONCURRENCY_PER_HOST`) and retried once on 429/5xx.
- **Reverse:** `reverseWithGateways(address, 60)`. The UR checks the forward address, and the result must be ENSIP-15 normalized.
- **Avatars and headers (ENSIP-12):**
  - https and `data:` values are passed through.
  - `ipfs://`, `ipns://` and `ar://` are rewritten to gateway URLs.
  - `eip155:` NFT references are followed to the token image, with an ownership check by default (`AVATAR_VERIFY_NFT_OWNER`).
  - NFTs on other chains need `CHAIN_RPC_<chainId>`.

## Development

```bash
cp .env.example .env        # set RPC_URL (and CHAIN)
npm install
npm run build && node --env-file=.env dist/src/index.js
npm test                    # unit tests
SEPOLIA_RPC_URL=… MAINNET_RPC_URL=… npm run test:live
npm run compare -- --ours http://localhost:3000 --theirs https://ens.ethfollow.xyz names.txt
```

Configuration lives in `.env.example`, validated in `src/config.ts`. The UniversalResolver proxy has the same address on mainnet and Sepolia. Mainnet switches to ENSv2 when ENS points that proxy at UniversalResolverV2; no change is needed here.

## Records indexer

The UniversalResolver can return any record, but it can't tell you which text keys a name has. The indexer fills that gap and keeps the cache fresh.

- **Reading:** it follows the chain `CONFIRMATIONS` blocks behind head. Each `eth_getLogs` call covers every indexed event from **every contract** (no address filter), because discovering resolvers through factories misses some. Each block range and the cursor are written in one transaction.
- **Registry tree** (`registry_labels`, `registry_paths`):
  - Labels come from `LabelRegistered`/`LabelReserved`, keyed by token id with the 32 version bits zeroed, so regenerated tokens keep their row.
  - Subregistry links give each registry reachable from the root a name, and every label under it a full name and node.
  - The node is computed from the parent node and the on-chain labelhash.
  - A registry keeps its first path; self-loops are ignored (ETHRegistry has some on Sepolia); if a path is removed, the registry re-attaches through another parent.
- **Records** (`resolver_links`, `resolver_records`):
  - PermissionedResolver records are keyed by `(resolver, recordId)`. Names attach to them through `Linked`; a name without a link falls back to the default record at node `0x00…00`.
  - PublicResolverV2 and v1-style resolvers are keyed by node.
  - Reverse-registrar events are tracked so cached primary names can be invalidated.
- **Keys:** after the first pass, the API asks the index for every text key set on the name's resolver (`IndexedKeySource`) and fetches those too. Values always come from the UniversalResolver, so the index only decides *which* keys to request.
- **Cache invalidation:** each batch reports the names and addresses it touched, and the indexer deletes their `n:`/`a:` cache keys. Share `REDIS_URL` between processes, or run `MODE=all`.
- **`GET /v2/n/:name`:** indexed registry data for a name (registry, token id, status, expiry, resolver, subregistry, record id, stored records). `/health` shows indexer lag.

Sepolia (2026-10-21):
- A full backfill from the v2 deploy block takes under a minute and produces about 14k labels and 8k records.
- `scripts/verify-index.ts` compared 400 random names and 361 text records against the chain with zero mismatches.

Mainnet stays off until `ROOT_REGISTRY` / `INDEX_START_BLOCK` are set to final ENSv2 addresses.

```bash
docker compose up                        # postgres + redis + indexer + api on :3000
TEST_DATABASE_URL=… npm run test:db      # indexer tests (wipes that database)
node --env-file=.env dist/scripts/verify-index.js 400
```

Known limits:
- Reorgs deeper than `CONFIRMATIONS` aren't rolled back.
- v1 names only get keys set after the v2 start block. The full v1 history isn't indexed, so v1 names mostly rely on the default key list.
- Offchain names can't be indexed.

## Roadmap

- Mainnet addresses once ENS finalizes the ENSv2 deployment.
- Optional v1 key backfill (for example from ENSNode) so unmigrated names get their full key list.
- Rate limiting, SSE endpoints and OpenAPI docs, as in enstate.
