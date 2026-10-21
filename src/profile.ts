import { getAddress, type Address, type PublicClient } from 'viem';
import type { Cache } from './cache.js';
import { ccipUrlStore } from './chain.js';
import type { Config } from './config.js';
import { resolveImage } from './decode/avatar.js';
import { decodeContenthash } from './decode/contenthash.js';
import { encodeCoinAddress } from './decode/multicoin.js';
import type { KeySource } from './keys.js';
import { coinDisplayName, CORE_RECORD_KEYS, ETH_COIN_TYPE } from './records.js';
import { NotFoundError, resolveRecords, type RecordQuery } from './resolve/forward.js';
import { lookupPrimaryName } from './resolve/reverse.js';

/**
 * Same shape and field order as enstate v1.1.0, so existing consumers (EFP services, Grails)
 * can switch by changing a URL. Optional fields are omitted when empty, as in enstate.
 */
export type Profile = {
  name: string;
  address?: Address;
  avatar?: string;
  header?: string;
  display: string;
  contenthash?: string;
  records: Record<string, string>;
  chains: Record<string, string>;
  /** Milliseconds since epoch when this profile was resolved. */
  fresh: number;
  resolver: Address;
  ccip_urls?: string[];
  errors: Record<string, string>;
};

const NOT_FOUND = '__not_found__';
const NO_PRIMARY = '';

export type ProfileServiceDeps = {
  client: PublicClient;
  avatarClients: Map<number, PublicClient>;
  cache: Cache;
  config: Config;
  keys: KeySource;
};

export class ProfileService {
  constructor(private readonly deps: ProfileServiceDeps) {}

  /** `name` must already be normalized. Throws NotFoundError when the name has no resolver. */
  async byName(name: string, fresh = false): Promise<Profile> {
    const { cache, config } = this.deps;
    const key = `n:${name}`;
    if (!fresh) {
      const hit = await cache.get(key);
      if (hit === NOT_FOUND) throw new NotFoundError(`${name} not found`);
      if (hit) return JSON.parse(hit) as Profile;
    }
    try {
      const profile = await this.resolve(name);
      await cache.set(key, JSON.stringify(profile), config.profileCacheTtl);
      return profile;
    } catch (err) {
      if (err instanceof NotFoundError) await cache.set(key, NOT_FOUND, config.notFoundCacheTtl);
      throw err;
    }
  }

  /** Profile of the address's primary name. Throws NotFoundError when it has none. */
  async byAddress(address: Address, fresh = false): Promise<Profile> {
    const name = await this.primaryName(address, fresh);
    if (!name) throw new NotFoundError(`${address} has no primary name`);
    return this.byName(name, fresh);
  }

  async primaryName(address: Address, fresh = false): Promise<string | null> {
    const { cache, config, client } = this.deps;
    const key = `a:${address.toLowerCase()}`;
    if (!fresh) {
      const hit = await cache.get(key);
      if (hit !== null) return hit === NO_PRIMARY ? null : hit;
    }
    const name = await lookupPrimaryName(client, address);
    await cache.set(key, name ?? NO_PRIMARY, name ? config.profileCacheTtl : config.notFoundCacheTtl);
    return name;
  }

  private async resolve(name: string): Promise<Profile> {
    const { client, config, keys } = this.deps;
    const extraKeys = await keys.keysFor(name).catch(() => []);
    const textKeys = [...new Set([...config.recordKeys, ...extraKeys])];
    const coinTypes = config.coinTypes.filter((c) => c !== ETH_COIN_TYPE);
    const core = new Set(CORE_RECORD_KEYS);
    const firstPass: RecordQuery[] = [
      { kind: 'addr' },
      ...textKeys.filter((k) => core.has(k)).map((key): RecordQuery => ({ kind: 'text', key })),
      { kind: 'contenthash' },
    ];
    const secondPass: RecordQuery[] = [
      ...textKeys.filter((k) => !core.has(k)).map((key): RecordQuery => ({ kind: 'text', key })),
      ...coinTypes.map((coinType): RecordQuery => ({ kind: 'coin', coinType })),
    ];

    // Core records first. If that went offchain (CCIP-read was used), stop there to stay under
    // gateway rate limits; on-chain names get the rest in a second, cheap call.
    const ccipUrls = new Set<string>();
    const first = await ccipUrlStore.run(ccipUrls, () => resolveRecords(client, name, firstPass));
    const queries = [...firstPass];
    const answers = [...first.answers];
    const resolver = first.resolver;
    if (ccipUrls.size === 0 && secondPass.length) {
      const second = await ccipUrlStore.run(ccipUrls, () => resolveRecords(client, name, secondPass));
      queries.push(...secondPass);
      answers.push(...second.answers);
    }

    const errors: Record<string, string> = {};
    const records: Record<string, string> = {};
    const chains: Record<string, string> = {};
    let address: Address | undefined;
    let contenthash: string | undefined;

    queries.forEach((q, i) => {
      const a = answers[i]!;
      const label =
        q.kind === 'text' ? `records.${q.key}` : q.kind === 'coin' ? `chains.${coinDisplayName(q.coinType)}` : q.kind;
      if (!a.ok) {
        errors[label] = a.error;
        return;
      }
      if (a.value === null) return;
      try {
        switch (q.kind) {
          case 'addr':
            address = getAddress(a.value);
            chains.eth = address;
            break;
          case 'text':
            records[q.key] = a.value;
            break;
          case 'coin':
            chains[coinDisplayName(q.coinType)] = encodeCoinAddress(q.coinType, a.value as `0x${string}`);
            break;
          case 'contenthash':
            contenthash = decodeContenthash(a.value as `0x${string}`);
            break;
        }
      } catch (err) {
        errors[label] = (err as Error).message;
      }
    });

    const imageCtx = {
      owner: address ?? null,
      clients: this.deps.avatarClients,
      ipfsGateway: config.ipfsGateway,
      arweaveGateway: config.arweaveGateway,
      verifyNftOwner: config.verifyNftOwner,
    };
    const image = async (field: 'avatar' | 'header') => {
      const raw = records[field];
      if (!raw) return undefined;
      try {
        return await resolveImage(raw, imageCtx);
      } catch (err) {
        errors[`image.${field}`] = (err as Error).message;
        return undefined;
      }
    };
    const [avatar, header] = await Promise.all([image('avatar'), image('header')]);

    const displayRecord = records.display;
    const profile: Profile = {
      name,
      address,
      avatar,
      header,
      display: displayRecord && displayRecord.toLowerCase() === name.toLowerCase() ? displayRecord : name,
      contenthash,
      records,
      chains,
      fresh: Date.now(),
      resolver: getAddress(resolver),
      ccip_urls: ccipUrls.size ? [...ccipUrls] : undefined,
      errors,
    };
    // drop undefined optionals so the JSON matches enstate's omitted fields
    for (const k of Object.keys(profile) as (keyof Profile)[]) if (profile[k] === undefined) delete profile[k];
    return profile;
  }
}
