/**
 * Live checks against real chains. Skipped unless the RPC env vars are set:
 *   SEPOLIA_RPC_URL=… MAINNET_RPC_URL=… npm run test:live
 * Expected values were read on-chain on 2026-10-20 and may drift as owners change records.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryCache } from '../../src/cache.js';
import { createAvatarClients, createClient } from '../../src/chain.js';
import { loadConfig } from '../../src/config.js';
import { noExtraKeys } from '../../src/keys.js';
import { ProfileService } from '../../src/profile.js';
import { NotFoundError } from '../../src/resolve/forward.js';

function service(chain: 'sepolia' | 'mainnet', rpc: string) {
  const config = loadConfig({ CHAIN: chain, RPC_URL: rpc });
  const client = createClient(config);
  return new ProfileService({ client, avatarClients: createAvatarClients(config, client), cache: new MemoryCache(), config, keys: noExtraKeys });
}

const SEPOLIA = process.env.SEPOLIA_RPC_URL;
const MAINNET = process.env.MAINNET_RPC_URL;

describe('sepolia (ENSv2 live)', { skip: !SEPOLIA && 'SEPOLIA_RPC_URL not set' }, () => {
  const s = () => service('sepolia', SEPOLIA!);

  it('v2 name on a PermissionedResolver reports the real resolver, not the v1 bridge', async () => {
    const p = await s().byName('reprovals.eth');
    assert.equal(p.address, '0x113A0ffeADa47e110Ad01098BEBA3403060978FB');
    assert.equal(p.resolver, '0x0E6fA48De5F4153d6CCf765F1DA7aa714F6fFF5B');
  });

  it('v2 name with records', async () => {
    const p = await s().byName('yoginth.eth');
    assert.equal(p.records['com.github'], 'bigint');
    assert.ok(p.avatar?.startsWith('https://'));
    assert.ok(p.chains.btc);
  });

  it('primary name set through the default reverse registrar (enstate 404s here)', async () => {
    assert.equal(await s().primaryName('0x113A0ffeADa47e110Ad01098BEBA3403060978FB'), 'palau.eth');
  });

  it('unmigrated v1 name resolves through the v2 UR', async () => {
    const p = await s().byName('gregskril.eth');
    assert.equal(p.address, '0x179A862703a4adfb29896552DF9e307980D19285');
    assert.ok(p.contenthash?.startsWith('ipfs://'));
  });

  it('unregistered and expired names are 404, not empty profiles', async () => {
    await assert.rejects(s().byName('doesnotexist-zzq9.eth'), NotFoundError);
    await assert.rejects(s().byName('croquis.eth'), NotFoundError);
  });

  it('DNS name whose TXT resolver only exists on mainnet is 404, not 500', async () => {
    await assert.rejects(s().byName('gregskril.com'), NotFoundError);
  });
});

describe('mainnet (ENSv1 today, v2 after the UR cutover)', { skip: !MAINNET && 'MAINNET_RPC_URL not set' }, () => {
  const s = () => service('mainnet', MAINNET!);

  it('vitalik.eth forward and reverse', async () => {
    const svc = s();
    const p = await svc.byName('vitalik.eth');
    assert.equal(p.address, '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    assert.equal(await svc.primaryName('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'), 'vitalik.eth');
  });

  it('DNS name via its offchain resolver', async () => {
    assert.equal((await s().byName('gregskril.com')).address, '0x179A862703a4adfb29896552DF9e307980D19285');
  });

  it('ipns and swarm contenthash (enstate errors on both)', async () => {
    const svc = s();
    assert.ok((await svc.byName('nick.eth')).contenthash?.startsWith('ipns://'));
    assert.ok((await svc.byName('ens.eth')).contenthash?.startsWith('bzz://'));
  });

  it('offchain name only fetches core records and reports its gateway', async () => {
    const p = await s().byName('jesse.base.eth');
    assert.equal(p.address, '0x2211d1D0020DAEA8039E46Cf1367962070d77DA9');
    assert.ok(p.ccip_urls?.some((u) => u.includes('coinbase.com')));
    assert.deepEqual(Object.keys(p.errors), [], `gateway errors: ${JSON.stringify(p.errors)}`);
  });
});
