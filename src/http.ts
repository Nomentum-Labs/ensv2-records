import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { PublicClient } from 'viem';
import type { Config } from './config.js';
import type { Profile, ProfileService } from './profile.js';
import { NotFoundError } from './resolve/forward.js';
import { guessLookup, InvalidInputError, normalizeName, parseAddress } from './resolve/name.js';

export const VERSION = '0.1.0';

type BulkItem = ({ type: 'success' } & Profile) | { type: 'error'; status: number; error: string };

const isFresh = (c: Context) => ['true', '1'].includes(c.req.query('fresh') ?? '');

/** Error → enstate-compatible status + body. */
function toError(err: unknown): { status: 400 | 404 | 500; error: string } {
  if (err instanceof InvalidInputError) return { status: 400, error: err.message };
  if (err instanceof NotFoundError) return { status: 404, error: 'Not Found' };
  console.error(err);
  return { status: 500, error: (err as Error)?.message?.split('\n')[0] ?? 'Internal error' };
}

/** Bulk query params: enstate uses `names[]=a&names[]=b`; also accept repeated `names=` and comma lists. */
function bulkInputs(c: Context, param: string): string[] {
  const raw = [...(c.req.queries(`${param}[]`) ?? []), ...(c.req.queries(param) ?? [])].flatMap((v) => v.split(','));
  return [...new Set(raw.map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

export function createApp(deps: { profiles: ProfileService; client: PublicClient; config: Config }) {
  const { profiles, client, config } = deps;
  const app = new Hono();
  app.use('*', cors());

  const meta = () => ({
    name: 'ensv2-records',
    version: VERSION,
    rev: process.env.GIT_REV ?? 'dev',
    chain: config.chain,
  });

  const respond = async (c: Context, fn: () => Promise<Profile>) => {
    try {
      return c.json(await fn());
    } catch (err) {
      const e = toError(err);
      return c.json(e, e.status);
    }
  };

  const byQuery = (q: string, fresh: boolean) => {
    const l = guessLookup(q);
    return l.type === 'name' ? profiles.byName(l.name, fresh) : profiles.byAddress(l.address, fresh);
  };

  app.get('/', (c) => c.json(meta()));
  app.get('/this', (c) => c.json(meta()));
  app.get('/health', async (c) => {
    try {
      return c.json({ ok: true, chain: config.chain, block: Number(await client.getBlockNumber()) });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message.split('\n')[0] }, 503);
    }
  });

  app.get('/n/:name', (c) => respond(c, async () => profiles.byName(normalizeName(c.req.param('name')), isFresh(c))));
  app.get('/a/:address', (c) => respond(c, async () => profiles.byAddress(parseAddress(c.req.param('address')), isFresh(c))));
  app.get('/u/:query', (c) => respond(c, async () => byQuery(c.req.param('query'), isFresh(c))));

  const bulk = (param: string, one: (input: string, fresh: boolean) => Promise<Profile>) => async (c: Context) => {
    const inputs = bulkInputs(c, param);
    if (inputs.length > config.maxBulkSize) {
      return c.json({ status: 400, error: `maximum input length exceeded (expected at most ${config.maxBulkSize})` }, 400);
    }
    const fresh = isFresh(c);
    const response = await Promise.all(
      inputs.map(async (input): Promise<BulkItem> => {
        try {
          return { type: 'success', ...(await one(input, fresh)) };
        } catch (err) {
          const e = toError(err);
          return { type: 'error', status: e.status, error: e.error };
        }
      }),
    );
    return c.json({ response_length: response.length, response });
  };
  app.get('/bulk/n', bulk('names', (n, f) => profiles.byName(normalizeName(n), f)));
  app.get('/bulk/a', bulk('addresses', (a, f) => profiles.byAddress(parseAddress(a), f)));
  app.get('/bulk/u', bulk('queries', byQuery));

  /** /i (avatar) and /h (header): redirect to the image, or serve data: URIs inline. */
  const image = (field: 'avatar' | 'header') => async (c: Context) => {
    let profile: Profile;
    try {
      profile = await byQuery(c.req.param('query')!, isFresh(c));
    } catch (err) {
      const e = toError(err);
      return c.json(e, e.status);
    }
    const url = profile[field];
    if (!url) return c.json({ status: 404, error: 'Not Found' }, 404);
    const data = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
    if (!data) return c.redirect(url, 303);
    const [, mime, b64, body] = data;
    if (!mime!.startsWith('image/')) return c.json({ status: 415, error: 'Unsupported Media Type' }, 415);
    const bytes = b64 ? Buffer.from(body!, 'base64') : Buffer.from(decodeURIComponent(body!));
    return c.body(bytes, 200, { 'content-type': mime! });
  };
  app.get('/i/:query', image('avatar'));
  app.get('/h/:query', image('header'));

  app.notFound((c) => c.json({ status: 404, error: 'Unknown route' }, 404));
  return app;
}
