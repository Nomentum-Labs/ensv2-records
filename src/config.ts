import { z } from 'zod';
import { DEFAULT_COIN_TYPES, DEFAULT_RECORD_KEYS } from './records.js';

const list = (s: string | undefined) =>
  s
    ?.split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  CHAIN: z.enum(['mainnet', 'sepolia']).default('mainnet'),
  RPC_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  REDIS_URL: z.string().optional(),
  PROFILE_CACHE_TTL: z.coerce.number().int().nonnegative().default(600),
  NOT_FOUND_CACHE_TTL: z.coerce.number().int().nonnegative().default(300),
  MAX_BULK_SIZE: z.coerce.number().int().positive().default(10),
  IPFS_GATEWAY: z.string().url().default('https://ipfs.io/ipfs/'),
  ARWEAVE_GATEWAY: z.string().url().default('https://arweave.net/'),
  CCIP_CONCURRENCY_PER_HOST: z.coerce.number().int().positive().default(6),
  AVATAR_VERIFY_NFT_OWNER: bool.default(true),
  PROFILE_RECORDS: z.string().optional(),
  MULTICOIN_CHAINS: z.string().optional(),
});

export type Config = {
  chain: 'mainnet' | 'sepolia';
  rpcUrls: string[];
  chainRpcs: Record<number, string[]>;
  port: number;
  redisUrl?: string;
  profileCacheTtl: number;
  notFoundCacheTtl: number;
  maxBulkSize: number;
  ipfsGateway: string;
  arweaveGateway: string;
  ccipConcurrencyPerHost: number;
  verifyNftOwner: boolean;
  recordKeys: string[];
  coinTypes: number[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = schema.parse(env);
  const chainRpcs: Record<number, string[]> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^CHAIN_RPC_(\d+)$/.exec(k);
    if (m && v) chainRpcs[Number(m[1])] = list(v) ?? [];
  }
  return {
    chain: e.CHAIN,
    rpcUrls: list(e.RPC_URL) ?? [],
    chainRpcs,
    port: e.PORT,
    redisUrl: e.REDIS_URL,
    profileCacheTtl: e.PROFILE_CACHE_TTL,
    notFoundCacheTtl: e.NOT_FOUND_CACHE_TTL,
    maxBulkSize: e.MAX_BULK_SIZE,
    ipfsGateway: e.IPFS_GATEWAY.endsWith('/') ? e.IPFS_GATEWAY : `${e.IPFS_GATEWAY}/`,
    arweaveGateway: e.ARWEAVE_GATEWAY.endsWith('/') ? e.ARWEAVE_GATEWAY : `${e.ARWEAVE_GATEWAY}/`,
    ccipConcurrencyPerHost: e.CCIP_CONCURRENCY_PER_HOST,
    verifyNftOwner: e.AVATAR_VERIFY_NFT_OWNER,
    recordKeys: list(e.PROFILE_RECORDS) ?? DEFAULT_RECORD_KEYS,
    coinTypes: list(e.MULTICOIN_CHAINS)?.map(Number) ?? DEFAULT_COIN_TYPES,
  };
}
