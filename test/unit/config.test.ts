import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';

const base = { CHAIN: 'sepolia', RPC_URL: 'http://rpc' };

describe('database config', () => {
  it('accepts a valid URL, including a percent-encoded password', () => {
    const c = loadConfig({ ...base, DATABASE_URL: `postgresql://ensv2:${encodeURIComponent('p/a#s?s@w%rd')}@ensv2-prod-db:5432/ensv2` });
    assert.equal(typeof c.database, 'object');
  });

  it('rejects an unencoded password without echoing it', () => {
    for (const bad of ['postgresql://ensv2:pa#ss@ensv2-prod-db:5432/ensv2', '"postgresql://ensv2:x@db/ensv2"', 'not a url']) {
      assert.throws(
        () => loadConfig({ ...base, DATABASE_URL: bad }),
        (err: Error) => /DATABASE_URL/.test(err.message) && !err.message.includes('pa#ss') && !err.message.includes(bad),
      );
    }
  });

  it('falls back to PG* env vars', () => {
    assert.equal(loadConfig({ ...base, PGHOST: 'ensv2-prod-db' }).database, 'env');
    assert.equal(loadConfig(base).database, undefined);
  });
});
