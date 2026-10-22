# ensv2-records

ENS name resolution service for EFP, Ethereum Identity Kit and Grails. It resolves ENSv1, ENSv2 and offchain (CCIP-read) names through the ENS UniversalResolver, and serves the same HTTP API as the [enstate](https://github.com/v3xlabs/enstate) "ens worker" it replaces, so existing consumers switch over by changing a URL.

Alongside resolution, an optional records indexer follows ENSv2 registries and resolvers. It lets profiles include every text key a name has set (the UniversalResolver can't list keys), keeps cached profiles fresh when records change, and powers the `/v2` routes for ENSv2 registry data and PermissionedResolvers.

## Deployments

| Chain | URL | Records index |
|---|---|---|
| Sepolia | https://sepolia-api-prod-ensv2.on.hotbox.wtf | ✅ |
| Mainnet | https://mainnet-api-prod-ensv2.on.hotbox.wtf | Not yet (waiting on final ENSv2 mainnet addresses) |

Every instance serves its API reference at `/docs`. The API is public, needs no key, and allows any origin (CORS). Hosting details are in [docs/HOTBOX.md](docs/HOTBOX.md).

## API

### Profiles

Routes, field names, bulk format and error bodies follow enstate.

| Route | |
|---|---|
| `GET /n/:name` | Profile for a name |
| `GET /a/:address` | Profile for the address's primary name (404 if none) |
| `GET /u/:nameOrAddress` | Either of the above |
| `GET /i/:nameOrAddress`, `/h/:nameOrAddress` | 303 to the avatar / header image (`data:` images served inline) |
| `GET /bulk/n?names[]=…`, `/bulk/a?addresses[]=…`, `/bulk/u?queries[]=…` | `{response_length, response: [{type:'success', …profile} \| {type:'error', status, error}]}`, up to `MAX_BULK_SIZE` inputs |

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

Optional fields are omitted when empty. Errors are `{"status":404,"error":"Not Found"}`, `{"status":400,"error":"invalid name: …"}`, and 502 when the name's resolver or gateway fails.

Differences from enstate:
- `address` is omitted, not `0x000…000`, when a name has no ETH address.
- The default key list is larger and includes `status`.
- **Offchain names** fetch only the core records (`CORE_RECORD_KEYS` in `src/records.ts`). Every offchain lookup is a separate HTTP request to the name's gateway, and gateways rate-limit hard.

### Index

These read the records index directly and return 501 on an instance without one. Values can lag the chain by a few blocks; use `/n` for live record values.

| Route | |
|---|---|
| `GET /v2/n/:name` | ENSv2 registry data for a name: registry, token id, status, expiry, resolver, subregistry, stored records, the record it reads (`record_id`), and whether that's its own link (`linked_record_id`) or the default (`uses_default`) |
| `GET /v2/resolvers?account=0x…` | PermissionedResolvers the account has any role on: `roles` for every key, `key_grants` for single keys, and `manages_records` |
| `GET /v2/resolvers/:address` | A PermissionedResolver's record count, default record, created/updated block and time, `unlinked_name_count`, accounts with root roles, and per-key grants |
| `GET /v2/resolvers/:address/records?limit=&offset=` | The resolver's records, each with its stored values and the names using it (up to 100, plus `linked_name_count`, `inherited_name_count` and `name_count`) |
| `GET /v2/resolvers/:address/records/:id/names?q=&limit=&offset=` | Every name using one record, alphabetical, with an exact `total`. `linked: false` marks names inheriting the default record. `q` is a case-insensitive substring search |

How PermissionedResolver records work:
- Records are numbered from 1 per resolver. A setter call for a name without a record creates one, and other names can be linked to an existing record (`linkToRecord` / `linkToNode`), so several names can share one record.
- Names on the resolver that aren't linked to a record read the default record (`default_record_id`, the record linked to the root node). The default record's counts include these inherited names: names whose resolver is set to this one in the ENSv2 registry, registered and not expired, with no link of their own.
- Stored values carry an `encoding`: `utf8` for text and name, `bytes` for addr, contenthash and data (raw hex as stored on chain), `address` for interface implementers, and `flag` for abi (only whether an ABI is set is indexed). Addresses and contenthashes also come with `decoded`, in the chain's own address format or as a URI such as `ipfs://…`.
- Roles come from EnhancedAccessControl. Roles on the root resource apply to every key; a key grant is limited to one text/data key, coin type, ABI content type or interface. `admin_roles` are the roles an account may grant and revoke. `manages_records` is false for an account whose only role is the deployer's `can_name`.
- Setters take the DNS-encoded name, e.g. `setText(name, key, value)`, not the namehash.

### Meta

| Route | |
|---|---|
| `GET /health` | Chain, RPC head block and indexer lag |
| `GET /this` | Name, version, git revision and chain |
| `GET /` → `/docs` | API reference (Scalar, pinned with SRI) rendered from `/docs/openapi.json` |

## Compared with enstate

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

## How resolution works

- **Forward:** one `resolveWithGateways(name, multicall([...]))` call to the UniversalResolver per profile. On-chain resolvers handle 500+ lookups in one call; we measured under 220ms. Core records go first. If that call went offchain, the rest are skipped; otherwise a second call fetches them.
- **CCIP-read:** handled by viem's local batch gateway. Requests are capped per gateway host (`CCIP_CONCURRENCY_PER_HOST`) and retried once on 429/5xx.
- **Reverse:** `reverseWithGateways(address, 60)`. The UR checks the forward address, and the result must be ENSIP-15 normalized.
- **Avatars and headers (ENSIP-12):**
  - https and `data:` values are passed through.
  - `ipfs://`, `ipns://` and `ar://` are rewritten to gateway URLs.
  - `eip155:` NFT references are followed to the token image, with an ownership check by default (`AVATAR_VERIFY_NFT_OWNER`).
  - NFTs on other chains need `CHAIN_RPC_<chainId>`.
- **Expiry:** an ENSv2 registry stops returning a name's resolver as soon as the name expires, so expired v2 names 404 for their whole grace period. Their records are still stored and come back if the name is renewed.

The UniversalResolver proxy has the same address on mainnet and Sepolia. Mainnet switches to ENSv2 when ENS points that proxy at UniversalResolverV2; no change is needed here.

## Records index

The UniversalResolver can return any record, but it can't tell you which text keys a name has. The indexer fills that gap, keeps the cache fresh, and serves the `/v2` routes.

- **Reading:** it follows the chain `CONFIRMATIONS` blocks behind head (default 0, the tip). Each `eth_getLogs` call covers every indexed event from **every contract** (no address filter), because discovering resolvers through factories misses some. Each block range and the cursor are written in one transaction.
- **Registry tree** (`registry_labels`, `registry_paths`):
  - Labels come from `LabelRegistered`/`LabelReserved`, keyed by token id with the 32 version bits zeroed, so regenerated tokens keep their row.
  - Subregistry links give each registry reachable from the root a name, and every label under it a full name and node.
  - The node is computed from the parent node and the on-chain labelhash.
  - A registry keeps its first path; self-loops are ignored (ETHRegistry has some on Sepolia); if a path is removed, the registry re-attaches through another parent.
- **Records** (`resolver_links`, `resolver_records`):
  - PermissionedResolver records are keyed by `(resolver, recordId)`. Names attach to them through `Linked`; a name without a link falls back to the default record at node `0x00…00`.
  - PublicResolverV2 and v1-style resolvers are keyed by node.
  - Reverse-registrar events are tracked so cached primary names can be invalidated.
- **PermissionedResolvers** (`resolvers`, `resolver_roles`, `resolver_resource_args`):
  - A contract counts as a resolver once it emits `ResolverCreated()`.
  - `EACRolesChanged` is kept only for those contracts, since registries use the same access control. A role row is only overwritten by a newer event.
  - Records are numbered from 1, and every new record is announced with `Linked`, so the highest id seen is the record count.
  - `updated_block` is the latest block with a record, link, role or key-grant event on the resolver. Timestamps for created/updated blocks are looked up once and stored in `block_times`.
- **Keys:** after the first pass, the API asks the index for every text key set on the name's resolver (`IndexedKeySource`) and fetches those too. Values always come from the UniversalResolver, so the index only decides *which* keys to request.
- **Cache invalidation:** each batch reports the names and addresses it touched, and the indexer deletes their `n:`/`a:` cache keys. Share `REDIS_URL` between processes, or run `MODE=all`.
- **Migrations** run automatically at startup. When an upgrade indexes events an existing index never read, the indexer fills them in with a one-time backfill (progress in `backfill_state`) before following the chain; existing data is left in place.

Sepolia presets (`ROOT_REGISTRY`, `INDEX_START_BLOCK`, `ENSV1_RESOLVER`) are built in. A full Sepolia index from the v2 deploy block takes under a minute. Mainnet needs those three variables once ENS publishes the final ENSv2 addresses.

Known limits:
- Reorgs deeper than `CONFIRMATIONS` (default 0) aren't rolled back. A reorged tip block can leave stale index rows until those names change again; profile values still come live from the UniversalResolver.
- Names in the ENSv1 registry that point at a PermissionedResolver only count towards its records once they link to one; inheriting the default record is tracked for ENSv2 registry names only.
- v1 names only get keys set after the v2 start block. The full v1 history isn't indexed, so v1 names mostly rely on the default key list.
- Offchain names can't be indexed.

## Configuration

Environment variables, validated in `src/config.ts`. `.env.example` has a starting point.

| Variable | Default | |
|---|---|---|
| `CHAIN` | `mainnet` | `mainnet` or `sepolia` |
| `RPC_URL` | required | One or more RPC URLs (comma-separated), used with fallback |
| `CHAIN_RPC_<chainId>` | | RPCs for resolving `eip155:` NFT avatars on other chains |
| `PORT` | `3000` | |
| `REDIS_URL` | | Profile cache. Unreachable Redis is a startup error; unset uses a small in-process cache |
| `PROFILE_CACHE_TTL` / `NOT_FOUND_CACHE_TTL` | `600` / `300` | Seconds |
| `MAX_BULK_SIZE` | `10` | Inputs per bulk request |
| `IPFS_GATEWAY` / `ARWEAVE_GATEWAY` | `https://ipfs.io/ipfs/` / `https://arweave.net/` | For avatar and header URLs |
| `CCIP_CONCURRENCY_PER_HOST` | `6` | Concurrent CCIP-read requests per gateway host |
| `AVATAR_VERIFY_NFT_OWNER` | `true` | Check that the name's ETH address owns an `eip155:` NFT avatar |
| `PROFILE_RECORDS` / `MULTICOIN_CHAINS` | built-in lists | Comma-separated overrides of the default text keys / coin types |
| `MODE` | `api` | `api` serves HTTP, `indexer` follows the chain, `all` does both in one process |
| `DATABASE_URL` or `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`PGPORT` | | Postgres for the records index. Without it the API runs without the index |
| `ROOT_REGISTRY` / `INDEX_START_BLOCK` / `ENSV1_RESOLVER` | Sepolia presets | ENSv2 root registry, first block to index, and the v1→v2 bridge resolver |
| `CONFIRMATIONS` | `0` | Blocks behind head to index |
| `LOG_RANGE` | `2000` | Blocks per `eth_getLogs`; halves automatically when the provider rejects a range |
| `POLL_INTERVAL_MS` | `12000` | How often the indexer checks for new blocks at the tip |
| `GIT_REV` | `dev` | Reported by `/this` (set as a Docker build arg) |

The indexer's RPC must allow `eth_getLogs` with no address filter over `LOG_RANGE`-block ranges.

## Running

```bash
cp .env.example .env        # set RPC_URL (and CHAIN)
npm install
npm run build && node --env-file=.env dist/src/index.js
docker compose up           # local Sepolia stack: postgres + redis + indexer + api on :3000
```

The Docker image runs `node dist/src/index.js`; set `MODE` per service. With separate API and indexer processes, share `REDIS_URL` so the indexer can invalidate cached profiles.

## Testing and verification

```bash
npm test                                                  # unit tests
SEPOLIA_RPC_URL=… MAINNET_RPC_URL=… npm run test:live     # against live chains
TEST_DATABASE_URL=… npm run test:db                       # indexer tests (wipes that database)
node --env-file=.env dist/scripts/verify-index.js 300     # compare a random sample of the index with the chain
npm run compare -- --ours http://localhost:3000 --theirs https://ens.ethfollow.xyz names.txt   # compare profiles with enstate
```

`verify-index` checks nodes, resolvers, subregistries and text records for sampled names, plus record counts, record ids, root roles and unlinked (default-inheriting) names for sampled PermissionedResolvers. The last Sepolia run (2026-10-22) found no mismatches across 300 names, 300 text records and 968 resolver checks.

## Roadmap

- Mainnet index once ENS finalizes the ENSv2 deployment.
- Optional v1 key backfill (for example from ENSNode) so unmigrated names get their full key list.
- Rate limiting and SSE endpoints, as in enstate.

## License

MIT
