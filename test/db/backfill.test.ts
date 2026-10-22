/**
 * Resolver backfill against a real Postgres, with a fake RPC client. Skipped unless
 * TEST_DATABASE_URL is set; the database's public schema is wiped.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, parseAbi, toHex, type PublicClient } from 'viem';
import { loadConfig } from '../../src/config.js';
import { createPool, migrate, type Db } from '../../src/db/pool.js';
import { resolverBackfillTopics } from '../../src/indexer/events.js';
import { Indexer } from '../../src/indexer/indexer.js';

const URL_ = process.env.TEST_DATABASE_URL;
const RES = '0x00000000000000000000000000000000000000c0';
const ALICE = '0x00000000000000000000000000000000000000a1';
const abi = parseAbi([
  'event ResolverCreated()',
  'event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)',
]);

const rawLog = (block: number, logIndex: number, topics: readonly unknown[], data: `0x${string}`) => ({
  address: RES,
  blockNumber: toHex(block),
  logIndex: toHex(logIndex),
  topics,
  data,
  removed: false,
});

describe('resolver backfill', { skip: !URL_ && 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  const config = loadConfig({ CHAIN: 'sepolia', RPC_URL: 'http://unused', ROOT_REGISTRY: '0x00000000000000000000000000000000000000a0', INDEX_START_BLOCK: '100', LOG_RANGE: '60' });

  before(async () => {
    db = createPool(URL_!);
  });
  after(async () => {
    await db.end();
  });
  beforeEach(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
  });

  const fakeClient = (calls: { fromBlock: string; toBlock: string; topics: unknown }[]) =>
    ({
      async request({ params }: { method: string; params: [{ fromBlock: string; toBlock: string; topics: unknown }] }) {
        calls.push(params[0]);
        const from = Number(params[0].fromBlock);
        const to = Number(params[0].toBlock);
        const logs = [
          rawLog(120, 0, encodeEventTopics({ abi, eventName: 'ResolverCreated' }), '0x'),
          rawLog(
            121,
            0,
            encodeEventTopics({ abi, eventName: 'EACRolesChanged', args: { resource: 0n, account: ALICE } }),
            encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, 1n << 4n]),
          ),
        ];
        return logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
      },
    }) as unknown as PublicClient;

  it('replays resolver events up to the existing cursor, once', async () => {
    await db.query("INSERT INTO indexer_state (chain, last_block) VALUES ('sepolia', 200)");
    const calls: { fromBlock: string; toBlock: string; topics: unknown }[] = [];
    const indexer = new Indexer({ db, client: fakeClient(calls), config, log: () => {} });
    await indexer.backfillResolvers();

    assert.deepEqual(calls.map((c) => [Number(c.fromBlock), Number(c.toBlock)]), [[100, 159], [160, 200]]);
    assert.deepEqual(calls[0]!.topics, [resolverBackfillTopics]);
    const roles = (await db.query('SELECT resolver, account, role_bitmap::text FROM resolver_roles')).rows;
    assert.deepEqual(roles, [{ resolver: RES, account: ALICE, role_bitmap: (1n << 4n).toString() }]);

    await indexer.backfillResolvers(); // already done
    assert.equal(calls.length, 2);
  });

  it('a new index has nothing to backfill', async () => {
    const calls: { fromBlock: string; toBlock: string; topics: unknown }[] = [];
    await new Indexer({ db, client: fakeClient(calls), config, log: () => {} }).backfillResolvers();
    assert.equal(calls.length, 0);
  });
});
