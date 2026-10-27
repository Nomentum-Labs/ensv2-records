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
      await a.flushActivity();
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

  it('token lookup: any version of the token id, the v1 labelhash, reserved labels', async () => {
    const q = new IndexQueries(db, 'test');
    await apply(register(ROOT, 'eth'), ev(ROOT, 'SubregistryUpdated', { tokenId: tokenId('eth'), subregistry: ETH }));
    await apply(register(ETH, 'dave'), ev(ETH, 'TokenRegenerated', { oldTokenId: tokenId('dave'), newTokenId: tokenId('dave', 1) }));
    const old = await q.token(ETH.toUpperCase().replace('0X', '0x'), tokenId('dave'));
    assert.equal(old?.name, 'dave.eth');
    assert.equal(old?.label, 'dave');
    assert.equal(old?.current, false);
    assert.equal(old?.token_id, pad(toHex(tokenId('dave', 1)), { size: 32 }));
    assert.equal((await q.token(ETH, tokenId('dave', 1)))?.current, true);
    // a v1 BaseRegistrar token id is the full labelhash; its low 32 bits are ignored
    assert.equal((await q.token(ETH, BigInt(lh('dave'))))?.name, 'dave.eth');
    await apply(ev(ETH, 'LabelReserved', { tokenId: tokenId('erin'), labelHash: lh('erin'), label: 'erin', expiry: 2_000_000_000n }));
    const reserved = await q.token(ETH, BigInt(lh('erin')));
    assert.equal(reserved?.status, 'reserved');
    assert.equal(reserved?.name, 'erin.eth');
    assert.equal(await q.token(ETH, tokenId('nobody')), null);
    assert.equal(await q.token(SUB, tokenId('dave')), null);
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
    const past = BigInt(Math.floor(Date.now() / 1000) - 86_400);
    await apply(register(ROOT, 'eth'), ev(ROOT, 'SubregistryUpdated', { tokenId: tokenId('eth'), subregistry: ETH }));
    for (const l of ['dave', 'erin', 'frank']) await apply(register(ETH, l));
    await apply(register(ETH, 'gone', past)); // expired
    await apply(
      ev(RES, 'ResolverCreated', {}),
      // an app placeholder that can never be registered, and an expired name: links, but not names
      ev(RES, 'Linked', { recordId: 1n, node: namehash('ab12.grails-config.invalid'), name: dns('ab12.grails-config.invalid') }),
      ev(RES, 'Linked', { recordId: 1n, node: namehash('gone.eth'), name: dns('gone.eth') }),
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
      is_default: false,
      names: ['dave.eth', 'erin.eth'],
      name_count: 2,
      linked_name_count: 2,
      unregistered_link_count: 2,
      inherited_name_count: 0,
      records: [{ kind: 'text', key: 'avatar', value: 'https://a', encoding: 'utf8' }],
    });
    assert.equal(page!.records[1]!.is_default, true);
    assert.deepEqual(page!.records[1]!.names, []); // the default record is linked to the root, which has no name
    assert.deepEqual(page!.records[2]!.records, [
      { kind: 'addr', key: '60', value: '0x00000000000000000000000000000000000000aa', encoding: 'bytes', decoded: '0x00000000000000000000000000000000000000AA' },
    ]);

    assert.equal(page!.records[2]!.unregistered_link_count, 0);

    const hidden = await queries().recordNames(RES, '1', 10, 0);
    assert.deepEqual([hidden!.total, hidden!.names.map((n) => n.name)], [2, ['dave.eth', 'erin.eth']]);
    const shown = await queries().recordNames(RES, '1', 10, 0, undefined, true);
    assert.deepEqual(shown!.names, [
      { name: 'ab12.grails-config.invalid', linked: true, registered: false },
      { name: 'dave.eth', linked: true, registered: true },
      { name: 'erin.eth', linked: true, registered: true },
      { name: 'gone.eth', linked: true, registered: false },
    ]);

    const second = await queries().resolverRecords(RES, 1, 1);
    assert.deepEqual(second!.records.map((r) => r.record_id), ['2']);

    const inv = await apply(ev(RES, 'Cleared', { recordId: 1n }));
    assert.deepEqual([...inv.names].sort(), ['ab12.grails-config.invalid', 'dave.eth', 'erin.eth', 'gone.eth']);
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
    assert.deepEqual(mine.map((r) => [r.address, r.roles, r.manages_records, r.key_grants]), [[RES, ['set_text', 'link'], true, []]]);
    const namer = await queries().resolversByAccount(NAMER);
    assert.deepEqual(namer.map((r) => [r.address, r.roles, r.manages_records]), [[RES, ['can_name'], false]]);
    const bob = await queries().resolversByAccount(BOB); // a grant on one key only
    assert.equal(bob.length, 1);
    assert.deepEqual([bob[0]!.roles, bob[0]!.role_bitmap, bob[0]!.manages_records], [[], '0x0', true]);
    assert.deepEqual(bob[0]!.key_grants.map((g) => [g.key, g.roles, g.resource]), [['com.twitter', ['set_text'], pad(toHex(twitter), { size: 32 })]]);

    const info = await queries().resolver(RES);
    assert.deepEqual(info!.accounts.map((a) => a.account).sort(), [ALICE, NAMER]);
    assert.equal(info!.key_grants.length, 1);
    assert.equal(info!.key_grants[0]!.account, BOB);
    assert.equal(info!.key_grants[0]!.key, 'com.twitter');
    assert.equal(info!.key_grants[0]!.resource, pad(toHex(twitter), { size: 32 }));
  });

  it('default record: inherited names, counts, explicit links and search', async () => {
    const past = BigInt(Math.floor(Date.now() / 1000) - 86_400);
    const OTHER = '0x00000000000000000000000000000000000000c2';
    await apply(register(ROOT, 'eth'), ev(ROOT, 'SubregistryUpdated', { tokenId: tokenId('eth'), subregistry: ETH }));
    for (const l of ['alice', 'bob', 'carol', 'erin', 'frank', 'gina_x']) await apply(register(ETH, l));
    await apply(register(ETH, 'dave', past)); // expired
    for (const l of ['alice', 'bob', 'carol', 'dave', 'erin', 'gina_x']) await apply(ev(ETH, 'ResolverUpdated', { tokenId: tokenId(l), resolver: RES }));
    await apply(ev(ETH, 'ResolverUpdated', { tokenId: tokenId('frank'), resolver: OTHER })); // another resolver
    await apply(
      ev(RES, 'ResolverCreated', {}),
      ev(RES, 'Linked', { recordId: 1n, node: zeroHash, name: '0x00' as Hex }), // default record
      ev(RES, 'Linked', { recordId: 2n, node: namehash('alice.eth'), name: dns('alice.eth') }),
      ev(RES, 'Linked', { recordId: 1n, node: namehash('bob.eth'), name: dns('bob.eth') }), // explicitly linked to the default
      ev(RES, 'Linked', { recordId: 2n, node: namehash('erin.eth'), name: dns('erin.eth') }),
      ev(RES, 'Linked', { recordId: 0n, node: namehash('erin.eth'), name: dns('erin.eth') }), // unlinked again
    );

    const page = await queries().resolverRecords(RES, 10, 0);
    const [def, two] = page!.records;
    assert.deepEqual(
      [def!.is_default, def!.names, def!.linked_name_count, def!.inherited_name_count, def!.name_count],
      [true, ['bob.eth', 'carol.eth', 'erin.eth', 'gina_x.eth'], 1, 3, 4],
    );
    assert.deepEqual([two!.is_default, two!.names, two!.name_count, two!.inherited_name_count], [false, ['alice.eth'], 1, 0]);
    assert.equal((await queries().resolver(RES))!.unlinked_name_count, 3);

    const all = await queries().recordNames(RES, '1', 10, 0);
    assert.equal(all!.total, 4);
    assert.deepEqual(all!.names, [
      { name: 'bob.eth', linked: true, registered: true },
      { name: 'carol.eth', linked: false, registered: true },
      { name: 'erin.eth', linked: false, registered: true },
      { name: 'gina_x.eth', linked: false, registered: true },
    ]);
    const paged = await queries().recordNames(RES, '1', 1, 1);
    assert.deepEqual([paged!.total, paged!.names.map((n) => n.name)], [4, ['carol.eth']]);
    const search = await queries().recordNames(RES, '1', 10, 0, 'ER');
    assert.deepEqual([search!.total, search!.names.map((n) => n.name)], [1, ['erin.eth']]);
    assert.equal((await queries().recordNames(RES, '1', 10, 0, '_'))!.total, 1); // wildcards match literally
    assert.equal((await queries().recordNames(RES, '1', 10, 0, '%'))!.total, 0);
    const linkedOnly = await queries().recordNames(RES, '2', 10, 0);
    assert.deepEqual([linkedOnly!.is_default, linkedOnly!.names], [false, [{ name: 'alice.eth', linked: true, registered: true }]]);
    assert.equal(await queries().recordNames(OTHER, '1', 10, 0), null);

    const n = async (name: string) => {
      const r = (await queries().name(name))!;
      return [r.record_id, r.linked_record_id, r.uses_default];
    };
    assert.deepEqual(await n('carol.eth'), ['1', null, true]);
    assert.deepEqual(await n('alice.eth'), ['2', '2', false]);
    assert.deepEqual(await n('bob.eth'), ['1', '1', false]);
    assert.deepEqual(await n('frank.eth'), [null, null, false]);
  });

  it('updated_block follows the latest resolver event and only moves forward', async () => {
    const updated = async () => Number((await db.query('SELECT updated_block FROM resolvers WHERE address = $1', [RES])).rows[0].updated_block);
    const created = ev(RES, 'ResolverCreated', {});
    await apply(created);
    assert.equal(await updated(), created.block);
    const text = ev(RES, 'TextUpdated', { recordId: 1n, key: 'a', value: 'b' });
    await apply(text, roles(ALICE, SET_TEXT, 0n, REG)); // a registry's role change isn't resolver activity
    assert.equal(await updated(), text.block);
    await apply({ ...ev(RES, 'Linked', { recordId: 1n, node: namehash('x.eth'), name: dns('x.eth') }), block: 1 }); // replayed older event
    assert.equal(await updated(), text.block);
    assert.equal((await db.query('SELECT * FROM resolvers WHERE address = $1', [REG])).rows.length, 0);
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
