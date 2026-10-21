import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PublicClient } from 'viem';
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/http.js';
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

  it('unknown routes', async () => {
    assert.deepEqual(await (await get('/nope')).json(), { status: 404, error: 'Unknown route' });
  });
});
