/**
 * Compares this service's profiles with a running enstate, field by field.
 *
 *   npm run build && node dist/scripts/compare-enstate.js \
 *     --ours http://localhost:3000 --theirs https://ens.ethfollow.xyz names.txt
 *
 * names.txt: one name or address per line. Prints a summary and every mismatch as JSON lines.
 */
import { readFileSync } from 'node:fs';

type P = {
  name?: string;
  address?: string;
  avatar?: string;
  header?: string;
  contenthash?: string;
  records?: Record<string, string>;
  chains?: Record<string, string>;
  status?: number;
};

const args = process.argv.slice(2);
const flag = (f: string, d: string) => {
  const i = args.indexOf(f);
  if (i < 0) return d;
  const v = args[i + 1]!;
  args.splice(i, 2);
  return v;
};
const ours = flag('--ours', 'http://localhost:3000').replace(/\/$/, '');
const theirs = flag('--theirs', 'https://ens.ethfollow.xyz').replace(/\/$/, '');
const concurrency = Number(flag('--concurrency', '4'));
const file = args[0];
if (!file) throw new Error('usage: compare-enstate [--ours url] [--theirs url] names.txt');
const inputs = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);

async function get(base: string, q: string): Promise<P> {
  const res = await fetch(`${base}/u/${encodeURIComponent(q)}`);
  if (!res.ok) return { status: res.status };
  return (await res.json()) as P;
}

const lc = (v?: string) => v?.toLowerCase();
const counts: Record<string, number> = {};
const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

async function compare(q: string) {
  const [a, b] = await Promise.all([get(ours, q), get(theirs, q)]);
  const diffs: Record<string, [unknown, unknown]> = {};
  if ((a.status ?? 200) !== (b.status ?? 200)) diffs.status = [a.status ?? 200, b.status ?? 200];
  else if (!a.status) {
    for (const f of ['name', 'address', 'avatar', 'header', 'contenthash'] as const) {
      if (lc(a[f]) !== lc(b[f])) diffs[f] = [a[f], b[f]];
    }
    // Records enstate had must match; extra keys on our side are expected (bigger key list).
    for (const [k, v] of Object.entries(b.records ?? {})) if (a.records?.[k] !== v) diffs[`records.${k}`] = [a.records?.[k], v];
    for (const [k, v] of Object.entries(b.chains ?? {})) if (lc(a.chains?.[k]) !== lc(v)) diffs[`chains.${k}`] = [a.chains?.[k], v];
  }
  bump(Object.keys(diffs).length ? 'mismatch' : 'match');
  for (const k of Object.keys(diffs)) bump(`diff:${k.split('.')[0]}`);
  if (Object.keys(diffs).length) console.log(JSON.stringify({ q, diffs }));
}

for (let i = 0; i < inputs.length; i += concurrency) {
  await Promise.all(inputs.slice(i, i + concurrency).map(compare));
}
console.error(JSON.stringify({ total: inputs.length, ...counts }, null, 2));
