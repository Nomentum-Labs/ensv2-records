import { serve } from '@hono/node-server';
import { createCache } from './cache.js';
import { createAvatarClients, createClient } from './chain.js';
import { loadConfig } from './config.js';
import { createApp } from './http.js';
import { noExtraKeys } from './keys.js';
import { ProfileService } from './profile.js';

const config = loadConfig();
const client = createClient(config);
const cache = await createCache(config.redisUrl);
const profiles = new ProfileService({
  client,
  avatarClients: createAvatarClients(config, client),
  cache,
  config,
  keys: noExtraKeys,
});
const app = createApp({ profiles, client, config });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ensv2-records listening on :${info.port} (chain=${config.chain}, cache=${cache.kind})`);
});
