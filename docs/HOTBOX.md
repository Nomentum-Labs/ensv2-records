# Running on hotbox

Project `ensv2`, environment `prod`. Create everything from the hotbox dashboard (**New Service**). Internal hostnames follow `<project>-<env>-<service>`, and auto subdomains follow `<service>-<env>-<project>.on.hotbox.wtf`.

| Service | Source | Public | What it does |
|---|---|---|---|
| `db` | image `postgres:17-alpine` | no | records index |
| `redis` | image `redis:7-alpine` | no | profile cache, shared by all instances (keys are prefixed `ensv2:<chain>:`) |
| `sepolia-indexer` | GitHub `Nomentum-Labs/ensv2-records` @ `main` | no | follows Sepolia, writes the index, invalidates cached profiles |
| `sepolia-api` | GitHub, same repo | port 3000 → `sepolia-api-prod-ensv2.on.hotbox.wtf` | Sepolia API (ENSv2 live) |
| `mainnet-api` | GitHub, same repo | port 3000 → `mainnet-api-prod-ensv2.on.hotbox.wtf` | mainnet API, the enstate replacement; no index until ENS publishes final v2 addresses |

GitHub services: **Dockerfile path** `Dockerfile`, **Build context** `.` (these two fields have been swapped by accident before, which gives "Cannot locate specified Dockerfile").

## Variables

Mark anything with a credential as **secret**. Plain variables are also passed to builds as build args.

The database connection uses Postgres's standard `PG*` variables, so the password never goes inside a URL. `DATABASE_URL` also works, but special characters in the password (`/ # ? @ % :`) must be percent-encoded. The service rejects a malformed URL at startup without printing it.

**db**
- `POSTGRES_USER=ensv2`, `POSTGRES_DB=ensv2`, `POSTGRES_PASSWORD` (secret, generate one)
- volume `data` → `/var/lib/postgresql/data`

**redis**: no variables needed.

**sepolia-indexer**
```
MODE=indexer
CHAIN=sepolia
RPC_URL=<sepolia RPC>                                                   # secret
PGHOST=ensv2-prod-db
PGUSER=ensv2
PGDATABASE=ensv2
PGPASSWORD=<same as db POSTGRES_PASSWORD>                         # secret
REDIS_URL=redis://ensv2-prod-redis:6379
```
The RPC must allow `eth_getLogs` with no address filter over 2k-block ranges (Alchemy does; publicnode doesn't). Migrations run automatically at startup. A full Sepolia backfill takes about a minute.

**sepolia-api**
```
MODE=api
CHAIN=sepolia
PORT=3000
RPC_URL=<sepolia RPC>                                                   # secret
PGHOST=ensv2-prod-db
PGUSER=ensv2
PGDATABASE=ensv2
PGPASSWORD=<same as db POSTGRES_PASSWORD>                         # secret
REDIS_URL=redis://ensv2-prod-redis:6379
CHAIN_RPC_1=http://eth-archive-erigon:8545                              # mainnet NFT avatars
```

**mainnet-api**
```
MODE=api
CHAIN=mainnet
PORT=3000
RPC_URL=http://eth-archive-erigon:8545
REDIS_URL=redis://ensv2-prod-redis:6379
```
With no database variables, mainnet runs without the index and fetches the default key list, the same as phase 1. When ENS publishes the final mainnet ENSv2 addresses:
1. Add `mainnet-indexer`, configured like `sepolia-indexer`, with `CHAIN=mainnet`, `ROOT_REGISTRY`, `INDEX_START_BLOCK` and `ENSV1_RESOLVER` set.
2. Give `mainnet-api` the same `PG*` variables. Both chains can share one database, because the cursor is per chain. The registry and record tables are not partitioned by chain, though, so a separate database per chain is cleaner.

## Checks after deploy

```bash
curl https://sepolia-api-prod-ensv2.on.hotbox.wtf/health     # ok, indexer.lag ≈ 0–2
curl https://sepolia-api-prod-ensv2.on.hotbox.wtf/n/brand.mkagent.eth   # agent:* records (index working)
curl https://sepolia-api-prod-ensv2.on.hotbox.wtf/a/0x113A0ffeADa47e110Ad01098BEBA3403060978FB   # palau.eth
curl https://mainnet-api-prod-ensv2.on.hotbox.wtf/n/vitalik.eth
curl https://mainnet-api-prod-ensv2.on.hotbox.wtf/n/jesse.base.eth      # offchain, ccip_urls set, no errors
```

Compare with the current enstate:
```bash
npm run compare -- --ours https://mainnet-api-prod-ensv2.on.hotbox.wtf --theirs https://ens.on.hotbox.wtf names.txt
```

## Notes

- The indexer runs at 0 confirmations. erigon 3.5+ sometimes reports a head block that `eth_getLogs` doesn't accept yet ("block range extends beyond current head block"). The indexer retries after 250ms.
- Cutting consumers over (EFP services, Grails `ENS_WORKER_URL`) is a URL change to the mainnet instance. Keep `ens.on.hotbox.wtf` running until the comparison is clean.
