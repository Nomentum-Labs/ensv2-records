/**
 * Applier tests against a real Postgres. Skipped unless TEST_DATABASE_URL is set; the database's
 * public schema is wiped.
 *   TEST_DATABASE_URL=postgresql://postgres:dev@127.0.0.1:55440/ensv2_test npm run test:db
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { keccak256, namehash, pad, toHex, zeroHash, type Hex } from 'viem';
import { packetToBytes } from 'viem/ens';
import { createPool, migrate, withTx, type Db } from '../../src/db/pool.js';
import { Applier, labelKeyOf, type DecodedLog, type Paths } from '../../src/indexer/apply.js';
import { IndexQueries } from '../../src/indexer/queries.js';
import { IndexedKeySource } from '../../src/keys.js';

const URL_ = process.env.TEST_DATABASE_URL;

const ROOT = '0x00000000000000000000000000000000000000a0';
const ETH = '0x00000000000000000000000000000000000000e0';
const SUB = '0x00000000000000000000000000000000000000b0';
const RES = '0x00000000000000000000000000000000000000c0';
const V1 = '0x00000000000000000000000000000000000000d0';

const REG = '0x00000000000000000000000000000000000000f0';
const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b1';
const NAMER = '0x00000000000000000000000000000000000000c1';
const SET_TEXT = 1n << 4n;
const LINK = 1n << 28n;
const CAN_NAME = 1n << 120n;

const lh = (label: string) => keccak256(toHex(label));
const tokenId = (label: string, version = 0) => (BigInt(lh(label)) & ~0xffffffffn) | BigInt(version);
const dns = (name: string) => toHex(packetToBytes(name));

let block = 100;
let logIndex = 0;
const ev = (address: string, eventName: string, args: Record<string, unknown>): DecodedLog => ({ address, block: block++, logIndex: logIndex++, eventName, args });
const register = (registry: string, label: string, expiry = 2n ** 64n - 1n, version = 0) =>
  ev(registry, 'LabelRegistered', { tokenId: tokenId(label, version), labelHash: lh(label), label, expiry });

describe('indexer apply', { skip: !URL_ && 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let paths: Paths;

  const apply = async (...logs: DecodedLog[]) =>
    withTx(db, async (tx) => {
      const a = new Applier(tx, paths);
      for (const l of logs) await a.apply(l);
      return a.inv;
    });
  const label = async (registry: string, l: string) =>
    (await db.query('SELECT * FROM registry_labels WHERE registry = $1 AND label_key = $2', [registry, labelKeyOf(tokenId(l))])).rows[0];

  before(async () => {
    db = createPool(URL_!);
  });
  after(async () => {
    await db.end();
  });
  beforeEach(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    paths = await Applier.loadPaths(db, ROOT);
  });

  it('builds names and nodes down the registry tree, in any order', async () => {
    // ETHRegistry labels exist before the root points at it
    await apply(register(ETH, 'alice'), register(ROOT, 'eth'), ev(ROOT, 'SubregistryUpdated', { tokenId: tokenId('eth'), subregistry: ETH }));
    await apply(register(ETH, 'bob'), ev(ETH, 'SubregistryUpdated', { tokenId: tokenId('bob'), subregistry: SUB }), register(SUB, 'pay'));
    assert.equal((await label(ETH, 'alice')).name, 'alice.eth');
    assert.equal((await label(ETH, 'alice')).node, namehash('alice.eth'));
    assert.equal((await label(SUB, 'pay')).name, 'pay.bob.eth');
    assert.equal((await label(SUB, 'pay')).node, namehash('pay.bob.eth'));
    assert.equal((await label(ROOT, 'eth')).expiry, (2n ** 64n - 1n).toString());
  });

  it('ignores self-loops and keeps the first path', async () => {
    await apply(register(ROOT, 'eth'), ev(ROOT, 'SubregistryUpdated', { tokenId: tokenId('eth'), subregistry: ETH }));
    await apply(register(ETH, 'loop'), ev(ETH, 'SubregistryUpdated', { tokenId: tokenId('loop'), subregistry: ETH }));
    await apply(register(ETH, 'other'));
    assert.equal((await label(ETH, 'other')).name, 'other.eth');
    // a second parent pointing at SUB does not rename it
    await apply(register(ETH, 'one'), ev(ETH, 'SubregistryUpdated', { tokenId: tokenId('one'), subregistry: SUB }), register(SUB, 'x'));
    await apply(register(ETH, 'two'), ev(ETH, 'SubregistryUpdated', { tokenId: tokenId('two'), subregistry: SUB }));
    assert.equal((await label(SUB, 'x')).name, 'x.one.eth');
    // removing the first parent re-attaches SUB through the second
    await apply(ev(ETH, 'SubregistryUpdated', { tokenId: tokenId('one'), subregistry: '0x0000000000000000000000000000000000000000' }));
    assert.equal((await label(SUB, 'x')).name, 'x.two.eth');
  });

  it('re-registration resets resolver; regeneration keeps the label', async () => {
    await apply(register(ROOT, 'eth'), ev(ROOT, 'SubregistryUpdated', { tokenId: tokenId('eth'), subregistry: ETH }));
    await apply(register(ETH, 'carol'), ev(ETH, 'ResolverUpdated', { tokenId: tokenId('carol'), resolver: RES }));
    assert.equal((await label(ETH, 'carol')).resolver, RES);
    await apply(ev(ETH, 'TokenRegenerated', { oldTokenId: tokenId('carol'), newTokenId: tokenId('carol', 1) }));
    assert.equal((await label(ETH, 'carol')).token_id, pad(toHex(tokenId('carol', 1)), { size: 32 }));
    await apply(ev(ETH, 'LabelUnregistered', { tokenId: tokenId('carol', 1) }));
    assert.equal((await label(ETH, 'carol')).status, 'unregistered');
    await apply(register(ETH, 'carol', 2_000_000_000n, 2));
    assert.equal((await label(ETH, 'carol')).resolver, null);
    assert.equal((await label(ETH, 'carol')).status, 'registered');
  });

  it('keys: linked record, default record, unlink, node-keyed and the v1 bridge', async () => {
    const keys = new IndexedKeySource(db, V1);
    const node = namehash('dave.eth');
    await apply(
      ev(RES, 'Linked', { recordId: 1n, node, name: dns('dave.eth') }),
      ev(RES, 'TextUpdated', { recordId: 1n, key: 'agent:endpoint', value: 'https://x' }),
      ev(RES, 'Linked', { recordId: 2n, node: zeroHash, name: '0x00' as Hex }),
      ev(RES, 'TextUpdated', { recordId: 2n, key: 'default.key', value: 'y' }),
      ev(RES, 'TextUpdated', { recordId: 1n, key: 'cleared', value: '' }),
    );
    assert.deepEqual(await keys.keysFor('dave.eth', RES), ['agent:endpoint']);
    assert.deepEqual(await keys.keysFor('nolink.eth', RES), ['default.key']);
    await apply(ev(RES, 'Linked', { recordId: 0n, node, name: dns('dave.eth') }));
    assert.deepEqual(await keys.keysFor('dave.eth', RES), ['default.key']);

    const v1node = namehash('old.eth');
    await apply(ev(V1, 'TextChanged', { node: v1node, key: 'com.example', value: 'z' }));
    await apply(ev('0x00000000000000000000000000000000000000f1', 'TextChanged', { node: v1node, key: 'from.v1.resolver', value: 'z' }));
    assert.deepEqual(await keys.keysFor('old.eth', V1), ['com.example', 'from.v1.resolver']); // bridge sees every resolver's node records
    assert.deepEqual(await keys.keysFor('old.eth', RES), ['default.key']); // RES's default record applies to any name on RES
    await apply(ev(V1, 'VersionChanged', { node: v1node, newVersion: 1n }));
    assert.deepEqual(await keys.keysFor('old.eth', V1), ['from.v1.resolver']);
  });

  const roles = (account: string, newRoleBitmap: bigint, resource = 0n, at = RES) =>
    ev(at, 'EACRolesChanged', { resource, account, oldRoleBitmap: 0n, newRoleBitmap });
  const queries = () => new IndexQueries(db, 'test');

  it('resolver roles: only for known resolvers, and older events never overwrite newer ones', async () => {
    await apply(roles(ALICE, SET_TEXT, 0n, REG)); // a registry, not a resolver
    assert.equal((await db.query('SELECT * FROM resolver_roles')).rows.length, 0);

    await apply(ev(RES, 'ResolverCreated', {}));
    const older = roles(ALICE, SET_TEXT);
    const newer = roles(ALICE, SET_TEXT | LINK);
    await apply(newer, older); // backfill can replay an older event after a newer one
    const row = (await db.query('SELECT role_bitmap::text FROM resolver_roles WHERE resolver = $1', [RES])).rows[0];
    assert.equal(row.role_bitmap, (SET_TEXT | LINK).toString());

    await apply(roles(ALICE, 0n)); // revoked
    assert.deepEqual(await queries().resolversByAccount(ALICE), []);
  });

  it('resolver records: counts, linked names, default record, paging and Cleared', async () => {
    await apply(
      ev(RES, 'ResolverCreated', {}),
      ev(RES, 'Linked', { recordId: 1n, node: namehash('dave.eth'), name: dns('dave.eth') }),
      ev(RES, 'TextUpdated', { recordId: 1n, key: 'avatar', value: 'https://a' }),
      ev(RES, 'Linked', { recordId: 2n, node: zeroHash, name: '0x00' as Hex }),
      ev(RES, 'TextUpdated', { recordId: 2n, key: 'description', value: 'default' }),
      ev(RES, 'Linked', { recordId: 1n, node: namehash('erin.eth'), name: dns('erin.eth') }), // linkToRecord
      ev(RES, 'Linked', { recordId: 3n, node: namehash('frank.eth'), name: dns('frank.eth') }),
      ev(RES, 'AddressUpdated', { recordId: 3n, coinType: 60n, addressBytes: '0x00000000000000000000000000000000000000AA' }),
    );
    const page = await queries().resolverRecords(RES, 100, 0);
    assert.equal(page!.record_count, 3);
    assert.equal(page!.default_record_id, '2');
    assert.deepEqual(page!.records[0], {
      record_id: '1',
      names: ['dave.eth', 'erin.eth'],
      name_count: 2,
      records: [{ kind: 'text', key: 'avatar', value: 'https://a' }],
    });
    assert.deepEqual(page!.records[1]!.names, []); // the default record is linked to the root, which has no name
    assert.deepEqual(page!.records[2]!.records, [{ kind: 'addr', key: '60', value: '0x00000000000000000000000000000000000000aa' }]);

    const second = await queries().resolverRecords(RES, 1, 1);
    assert.deepEqual(second!.records.map((r) => r.record_id), ['2']);

    const inv = await apply(ev(RES, 'Cleared', { recordId: 1n }));
    assert.deepEqual([...inv.names].sort(), ['dave.eth', 'erin.eth']);
    assert.deepEqual((await queries().resolverRecords(RES, 1, 0))!.records[0]!.records, []);
    assert.equal(await queries().resolverRecords(REG, 100, 0), null);
  });

  it('resolvers by account, per-key grants and the namer', async () => {
    const twitter = BigInt(keccak256(toHex('com.twitter')));
    await apply(
      ev(RES, 'ResolverCreated', {}),
      roles(NAMER, CAN_NAME),
      roles(ALICE, SET_TEXT | LINK),
      ev(RES, 'ResourceArgument', { resource: twitter, arg: toHex('com.twitter') }),
      roles(BOB, SET_TEXT, twitter),
    );
    const mine = await queries().resolversByAccount(ALICE);
    assert.deepEqual(mine.map((r) => [r.address, r.roles]), [[RES, ['set_text', 'link']]]);
    assert.deepEqual(await queries().resolversByAccount(NAMER), []); // namer role only
    assert.deepEqual(await queries().resolversByAccount(BOB), []); // per-key grant only

    const info = await queries().resolver(RES);
    assert.deepEqual(info!.accounts.map((a) => a.account).sort(), [ALICE, NAMER]);
    assert.equal(info!.key_grants.length, 1);
    assert.equal(info!.key_grants[0]!.account, BOB);
    assert.equal(info!.key_grants[0]!.key, 'com.twitter');
    assert.equal(info!.key_grants[0]!.resource, pad(toHex(twitter), { size: 32 }));
  });

  it('backfill uses Linked only for record counts', async () => {
    await withTx(db, async (tx) => {
      const a = new Applier(tx, paths);
      await a.applyResolverBackfill(ev(RES, 'ResolverCreated', {}));
      await a.applyResolverBackfill(ev(RES, 'Linked', { recordId: 5n, node: namehash('gina.eth'), name: dns('gina.eth') }));
      await a.applyResolverBackfill(ev(RES, 'Linked', { recordId: 2n, node: namehash('hal.eth'), name: dns('hal.eth') }));
    });
    assert.equal((await queries().resolver(RES))!.record_count, 5);
    assert.equal((await db.query('SELECT * FROM resolver_links')).rows.length, 0); // live links are left alone
  });

  it('reports which names and addresses changed', async () => {
    await apply(register(ROOT, 'eth'), ev(ROOT, 'SubregistryUpdated', { tokenId: tokenId('eth'), subregistry: ETH }), register(ETH, 'erin'));
    await apply(ev(RES, 'Linked', { recordId: 7n, node: namehash('erin.eth'), name: dns('erin.eth') }));
    const inv = await apply(ev(RES, 'TextUpdated', { recordId: 7n, key: 'avatar', value: 'https://a' }));
    assert.deepEqual([...inv.names], ['erin.eth']);
    const inv2 = await apply(ev(ETH, 'ResolverUpdated', { tokenId: tokenId('erin'), resolver: RES }));
    assert.deepEqual([...inv2.names], ['erin.eth']);
    const addr = '0x00000000000000000000000000000000000000aa';
    const rnode = namehash(`${addr.slice(2)}.addr.reverse`);
    await apply(ev(V1, 'ReverseClaimed', { addr, node: rnode }));
    const inv3 = await apply(ev(V1, 'NameChanged', { node: rnode, name: 'erin.eth' }));
    assert.deepEqual([...inv3.addresses], [addr]);
  });
});
