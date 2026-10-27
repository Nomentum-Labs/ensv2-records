import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PublicClient } from 'viem';
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/http.js';
import type { IndexQueries } from '../../src/indexer/queries.js';
import type { Profile, ProfileService } from '../../src/profile.js';
import { NotFoundError } from '../../src/resolve/forward.js';

const config = loadConfig({ CHAIN: 'sepolia', RPC_URL: 'http://unused', MAX_BULK_SIZE: '3' });

const profile = (name: string): Profile => ({
  name,
  address: '0x113A0ffeADa47e110Ad01098BEBA3403060978FB',
  avatar: name === 'img.eth' ? 'data:image/svg+xml;base64,PHN2Zy8+' : 'https://example.com/a.png',
  display: name,
  records: {},
  chains: {},
  fresh: 1,
  resolver: '0x0E6fA48De5F4153d6CCf765F1DA7aa714F6fFF5B',
  errors: {},
});

const fake = {
  async byName(name: string) {
    if (name === 'missing.eth') throw new NotFoundError('missing');
    return profile(name);
  },
  async byAddress() {
    throw new NotFoundError('no primary');
  },
} as unknown as ProfileService;

const app = createApp({ profiles: fake, client: {} as PublicClient, config });
const get = (path: string) => app.request(path);

describe('http', () => {
  it('returns enstate-shaped profiles and normalizes input', async () => {
    const res = await get('/n/Palau.ETH');
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Profile).name, 'palau.eth');
  });

  it('404 body matches enstate', async () => {
    const res = await get('/n/missing.eth');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { status: 404, error: 'Not Found' });
  });

  it('400 for invalid names and addresses', async () => {
    assert.equal((await get('/n/nodot')).status, 400);
    assert.equal((await get('/a/0x123')).status, 400);
  });

  it('bulk: per-item results, dedupe, limit', async () => {
    const res = await get('/bulk/n?names[]=a.eth&names[]=A.eth&names[]=missing.eth');
    const body = (await res.json()) as { response_length: number; response: { type: string; status?: number }[] };
    assert.equal(body.response_length, 2);
    assert.equal(body.response[0]!.type, 'success');
    assert.deepEqual(body.response[1], { type: 'error', status: 404, error: 'Not Found' });

    const over = await get('/bulk/n?names[]=a.eth&names[]=b.eth&names[]=c.eth&names[]=d.eth');
    assert.equal(over.status, 400);
    assert.deepEqual(await over.json(), { status: 400, error: 'maximum input length exceeded (expected at most 3)' });
  });

  it('/i redirects to http avatars and serves data: images inline', async () => {
    const r = await get('/i/a.eth');
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), 'https://example.com/a.png');
    const d = await get('/i/img.eth');
    assert.equal(d.status, 200);
    assert.equal(d.headers.get('content-type'), 'image/svg+xml');
    assert.equal(await d.text(), '<svg/>');
  });

  it('index routes answer 501 without an index', async () => {
    for (const p of ['/v2/n/a.eth', '/v2/token/0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4/1', '/v2/resolvers?account=0x113A0ffeADa47e110Ad01098BEBA3403060978FB', '/v2/resolvers/0x45600dAd96384A0a2A0A9ac9287D943bcFCf3EF9/records', '/v2/resolvers/0x45600dAd96384A0a2A0A9ac9287D943bcFCf3EF9/records/1/names']) {
      assert.equal((await get(p)).status, 501, p);
    }
  });

  it('record names: validates the id, paging and search', async () => {
    const calls: unknown[][] = [];
    const index = {
      async recordNames(...args: unknown[]) {
        calls.push(args);
        return args[0] === '0x0000000000000000000000000000000000000001' ? null : { names: [] };
      },
    } as unknown as IndexQueries;
    const withIndex = createApp({ profiles: fake, client: {} as PublicClient, config, index });
    const base = '/v2/resolvers/0x45600dAd96384A0a2A0A9ac9287D943bcFCf3EF9/records';
    assert.equal((await withIndex.request(`${base}/2/names?limit=5&offset=10&q=%20Ali%20`)).status, 200);
    assert.deepEqual(calls[0], ['0x45600dAd96384A0a2A0A9ac9287D943bcFCf3EF9', '2', 5, 10, 'Ali', false]);
    assert.equal((await withIndex.request(`${base}/2/names?include_unregistered=true`)).status, 200);
    assert.equal(calls[1]![5], true);
    for (const bad of ['0/names', 'x/names', '1/names?limit=0', `1/names?q=${'a'.repeat(256)}`, '1/names?include_unregistered=yes']) {
      assert.equal((await withIndex.request(`${base}/${bad}`)).status, 400, bad);
    }
    assert.equal((await withIndex.request('/v2/resolvers/0x0000000000000000000000000000000000000001/records/1/names')).status, 404);
  });

  it('token lookup: parses the registry and token id (decimal or hex)', async () => {
    const calls: unknown[][] = [];
    const index = {
      async token(...args: unknown[]) {
        calls.push(args);
        return args[1] === 2n ? null : { name: 'a.eth' };
      },
    } as unknown as IndexQueries;
    const withIndex = createApp({ profiles: fake, client: {} as PublicClient, config, index });
    const base = '/v2/token/0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4';
    const id = '32734455225614265237472656242865744288490494906533098096798569357815119347712';
    assert.equal((await withIndex.request(`${base}/${id}`)).status, 200);
    assert.deepEqual(calls[0], ['0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4', BigInt(id)]);
    assert.equal((await withIndex.request(`${base}/0x${BigInt(id).toString(16)}`)).status, 200);
    assert.equal(calls[1]![1], BigInt(id));
    assert.equal((await withIndex.request(`${base}/2`)).status, 404);
    for (const bad of [`${base}/-1`, `${base}/1.5`, `${base}/abc`, `${base}/0x${'f'.repeat(65)}`, `${base}/${'9'.repeat(79)}`, `${base}/${(1n << 256n).toString()}`, '/v2/token/0x123/1']) {
      assert.equal((await withIndex.request(bad)).status, 400, bad);
    }
  });

  it('unknown routes', async () => {
    assert.deepEqual(await (await get('/nope')).json(), { status: 404, error: 'Unknown route' });
  });
});

describe('docs', () => {
  it('base URL redirects to the API reference', async () => {
    const r = await get('/');
    assert.equal(r.status, 307);
    assert.equal(r.headers.get('location'), '/docs');
  });

  it('serves a pinned Scalar page and an OpenAPI spec covering every route', async () => {
    const page = await (await get('/docs')).text();
    assert.match(page, /@scalar\/api-reference@\d+\.\d+\.\d+\/.*integrity="sha384-/s);
    const spec = (await (await get('/docs/openapi.json')).json()) as { openapi: string; paths: Record<string, unknown> };
    assert.equal(spec.openapi, '3.1.0');
    for (const p of ['/n/{name}', '/a/{address}', '/u/{nameOrAddress}', '/bulk/n', '/bulk/a', '/bulk/u', '/i/{nameOrAddress}', '/h/{nameOrAddress}', '/v2/n/{name}', '/v2/token/{registry}/{tokenId}', '/v2/resolvers', '/v2/resolvers/{address}', '/v2/resolvers/{address}/records', '/v2/resolvers/{address}/records/{id}/names', '/health', '/this']) {
      assert.ok(spec.paths[p], `missing ${p}`);
    }
  });
});
