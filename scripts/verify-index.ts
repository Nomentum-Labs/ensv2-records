/**
 * Checks the index against the chain for a random sample of live ENSv2 labels:
 *   - node = namehash(name)
 *   - resolver / subregistry match registry.getResolver(label) / getSubregistry(label)
 *   - text records stored for the name match what the UniversalResolver returns
 *
 *   npm run build && node --env-file=.env dist/scripts/verify-index.js [sampleSize]
 */
import { getAddress, namehash, parseAbi, zeroAddress } from 'viem';
import { createClient } from '../src/chain.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';

const registryAbi = parseAbi([
  'function getResolver(string label) view returns (address)',
  'function getSubregistry(string label) view returns (address)',
]);

const config = loadConfig();
const client = createClient(config);
const db = createPool(config.databaseUrl!);
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

console.log(JSON.stringify({ labels: rows.length, nodeBad, resolverBad, subBad, texts: recs.length, textBad }, null, 2));
for (const m of mismatches.slice(0, 25)) console.log(JSON.stringify(m));
await db.end();
