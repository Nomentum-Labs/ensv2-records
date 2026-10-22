/**
 * Checks the index against the chain for a random sample of live ENSv2 labels:
 *   - node = namehash(name)
 *   - resolver / subregistry match registry.getResolver(label) / getSubregistry(label)
 *   - text records stored for the name match what the UniversalResolver returns
 *   - PermissionedResolvers: record count, the record id of linked names, and root role bitmaps
 *
 *   npm run build && node --env-file=.env dist/scripts/verify-index.js [sampleSize]
 */
import { getAddress, namehash, parseAbi, zeroAddress } from 'viem';
import { createClient } from '../src/chain.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';

const resolverAbi = parseAbi([
  'function getRecordCount() view returns (uint256)',
  'function getRecordId(bytes32 node) view returns (uint256)',
  'function roles(uint256 resource, address account) view returns (uint256)',
]);

const registryAbi = parseAbi([
  'function getResolver(string label) view returns (address)',
  'function getSubregistry(string label) view returns (address)',
]);

const config = loadConfig();
const client = createClient(config);
if (!config.database) throw new Error('set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE');
const db = createPool(config.database === 'env' ? undefined : config.database.url);
const sample = Number(process.argv[2] ?? 300);
const now = Math.floor(Date.now() / 1000);

const rows = (
  await db.query<{ registry: string; label: string; name: string; node: string; resolver: string | null; subregistry: string | null }>(
    `SELECT registry, label, name, node, resolver, subregistry FROM registry_labels
     WHERE name IS NOT NULL AND label IS NOT NULL AND status <> 'unregistered' AND expiry > $1
     ORDER BY random() LIMIT $2`,
    [now + 3600, sample],
  )
).rows;

let nodeBad = 0;
let resolverBad = 0;
let subBad = 0;
const mismatches: unknown[] = [];
const norm = (a: string | null | undefined) => (a && a !== zeroAddress ? a.toLowerCase() : null);

for (let i = 0; i < rows.length; i += 50) {
  const chunk = rows.slice(i, i + 50);
  const calls = chunk.flatMap((r) => [
    { address: getAddress(r.registry), abi: registryAbi, functionName: 'getResolver' as const, args: [r.label] as const },
    { address: getAddress(r.registry), abi: registryAbi, functionName: 'getSubregistry' as const, args: [r.label] as const },
  ]);
  const res = await client.multicall({ contracts: calls, allowFailure: true });
  chunk.forEach((r, j) => {
    if (namehash(r.name) !== r.node) {
      nodeBad++;
      mismatches.push({ name: r.name, field: 'node', db: r.node, expected: namehash(r.name) });
    }
    const resolver = res[2 * j]!;
    const sub = res[2 * j + 1]!;
    if (resolver.status === 'success' && norm(resolver.result as string) !== norm(r.resolver)) {
      resolverBad++;
      mismatches.push({ name: r.name, field: 'resolver', db: r.resolver, chain: resolver.result });
    }
    if (sub.status === 'success' && norm(sub.result as string) !== norm(r.subregistry)) {
      subBad++;
      mismatches.push({ name: r.name, field: 'subregistry', db: r.subregistry, chain: sub.result });
    }
  });
}

// text records: every indexed (non-null) text value should equal the live value
const recs = (
  await db.query<{ name: string; key: string; value: string }>(
    `SELECT l.name, rr.key, rr.value
     FROM registry_labels l
     JOIN resolver_links k ON k.resolver = l.resolver AND k.node = l.node AND k.record_id > 0
     JOIN resolver_records rr ON rr.resolver = l.resolver AND rr.scope = 'r:' || k.record_id::text AND rr.kind = 'text'
     WHERE l.name IS NOT NULL AND rr.value IS NOT NULL AND l.expiry > $1
     ORDER BY random() LIMIT $2`,
    [now + 3600, sample],
  )
).rows;
let textBad = 0;
for (const r of recs) {
  const live = await client.getEnsText({ name: r.name, key: r.key }).catch((e) => `ERR ${(e as Error).message.split('\n')[0]}`);
  if (live !== r.value) {
    textBad++;
    mismatches.push({ name: r.name, field: `text.${r.key}`, db: r.value.slice(0, 80), chain: String(live).slice(0, 80) });
  }
}

// resolvers: record counts, linked names' record ids, root roles
const resolvers = (
  await db.query<{ address: string; record_count: string }>('SELECT address, record_count::text FROM resolvers ORDER BY random() LIMIT $1', [sample])
).rows;
const links = (
  await db.query<{ resolver: string; node: string; record_id: string }>(
    'SELECT resolver, node, record_id::text FROM resolver_links ORDER BY random() LIMIT $1',
    [sample],
  )
).rows;
const roleRows = (
  await db.query<{ resolver: string; account: string; role_bitmap: string }>(
    'SELECT resolver, account, role_bitmap::text FROM resolver_roles WHERE resource = 0 ORDER BY random() LIMIT $1',
    [sample],
  )
).rows;
const resolverCalls = [
  ...resolvers.map((r) => ({ address: getAddress(r.address), abi: resolverAbi, functionName: 'getRecordCount' as const, args: [] as const })),
  ...links.map((l) => ({ address: getAddress(l.resolver), abi: resolverAbi, functionName: 'getRecordId' as const, args: [l.node as `0x${string}`] as const })),
  ...roleRows.map((r) => ({ address: getAddress(r.resolver), abi: resolverAbi, functionName: 'roles' as const, args: [0n, getAddress(r.account)] as const })),
];
const expected = [
  ...resolvers.map((r) => ({ what: `${r.address} record_count`, db: r.record_count })),
  ...links.map((l) => ({ what: `${l.resolver} recordId(${l.node})`, db: l.record_id })),
  ...roleRows.map((r) => ({ what: `${r.resolver} roles(0, ${r.account})`, db: r.role_bitmap })),
];
let recordsBad = 0;
let recordsSkipped = 0;
for (let i = 0; i < resolverCalls.length; i += 100) {
  const res = await client.multicall({ contracts: resolverCalls.slice(i, i + 100), allowFailure: true });
  res.forEach((r, j) => {
    const e = expected[i + j]!;
    if (r.status !== 'success') {
      recordsSkipped++; // e.g. getRecordId on a v1-style resolver that also emitted Linked-shaped events
      return;
    }
    if (String(r.result) !== e.db) {
      recordsBad++;
      mismatches.push({ field: e.what, db: e.db, chain: String(r.result) });
    }
  });
}

console.log(
  JSON.stringify(
    { labels: rows.length, nodeBad, resolverBad, subBad, texts: recs.length, textBad, resolverChecks: resolverCalls.length, recordsBad, recordsSkipped },
    null,
    2,
  ),
);
for (const m of mismatches.slice(0, 25)) console.log(JSON.stringify(m));
await db.end();
