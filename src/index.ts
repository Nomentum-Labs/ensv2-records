import { serve } from '@hono/node-server';
import { createCache } from './cache.js';
import { createAvatarClients, createClient } from './chain.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db/pool.js';
import { createApp } from './http.js';
import { Indexer } from './indexer/indexer.js';
import { IndexQueries } from './indexer/queries.js';
import { IndexedKeySource, noExtraKeys } from './keys.js';
import { ProfileService } from './profile.js';

// MODE=api serves HTTP, MODE=indexer follows the chain, MODE=all does both in one process
// (needed for cache invalidation when there is no shared Redis).
const config = loadConfig();
const client = createClient(config);
const cache = await createCache(config.redisUrl, `ensv2:${config.chain}:`);
const db = config.database ? createPool(config.database === 'env' ? undefined : config.database.url) : undefined;

if (config.mode !== 'api' && !db) throw new Error('MODE=indexer/all needs DATABASE_URL (or PGHOST/PGUSER/PGPASSWORD/PGDATABASE)');
if (db) {
  const applied = await migrate(db);
  if (applied.length) console.log(`applied migrations: ${applied.join(', ')}`);
}

if (config.mode !== 'indexer') {
  const profiles = new ProfileService({
    client,
    avatarClients: createAvatarClients(config, client),
    cache,
    config,
    keys: db ? new IndexedKeySource(db, config.indexer.ensV1Resolver) : noExtraKeys,
  });
  const app = createApp({ profiles, client, config, index: db ? new IndexQueries(db, config.chain) : undefined });
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`ensv2-records api on :${info.port} (chain=${config.chain}, cache=${cache.kind}, index=${db ? 'on' : 'off'})`);
  });
}

if (config.mode !== 'api') {
  const indexer = new Indexer({ db: db!, client, config, cache });
  const stop = () => indexer.stop();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.log(`ensv2-records indexer from block ${(await indexer.cursor()) + 1} (chain=${config.chain})`);
  indexer.run().catch((err) => {
    console.error('indexer stopped', err);
    process.exit(1);
  });
}
