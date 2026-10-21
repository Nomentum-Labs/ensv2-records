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
  // indexer
  MODE: z.enum(['api', 'indexer', 'all']).default('api'),
  DATABASE_URL: z.string().optional(),
  ROOT_REGISTRY: z.string().optional(),
  INDEX_START_BLOCK: z.coerce.number().int().nonnegative().optional(),
  ENSV1_RESOLVER: z.string().optional(),
  CONFIRMATIONS: z.coerce.number().int().nonnegative().default(12),
  LOG_RANGE: z.coerce.number().int().positive().default(2_000),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(12_000),
});

/**
 * ENSv2 deployment per chain, from contracts-v2 `post-audit-2` contracts/docs/addresses/sepolia.md
 * (deployed 2026-10-01). Mainnet stays unset until ENS publishes final addresses; the mainnet
 * v2 contracts have been redeployed more than once before cutover.
 */
const ENSV2_PRESETS: Record<'mainnet' | 'sepolia', { rootRegistry?: string; startBlock?: number; ensV1Resolver?: string }> = {
  sepolia: {
    rootRegistry: '0xb458d6a3a77919449d03e7a6903c26827c1ec43f',
    startBlock: 11820399, // ETHRegistry deploy block; the root's first event is at 11820400
    ensV1Resolver: '0x322b7581ca210a69c6d0e0d7c88a7688d2789cb0',
  },
  mainnet: {},
};

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
  mode: 'api' | 'indexer' | 'all';
  databaseUrl?: string;
  indexer: {
    rootRegistry?: string;
    startBlock?: number;
    /** ENSv2's bridge resolver for unmigrated v1 names (the UR reports it instead of the v1 resolver). */
    ensV1Resolver?: string;
    confirmations: number;
    logRange: number;
    pollIntervalMs: number;
  };
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
    mode: e.MODE,
    databaseUrl: e.DATABASE_URL,
    indexer: {
      rootRegistry: (e.ROOT_REGISTRY ?? ENSV2_PRESETS[e.CHAIN].rootRegistry)?.toLowerCase(),
      startBlock: e.INDEX_START_BLOCK ?? ENSV2_PRESETS[e.CHAIN].startBlock,
      ensV1Resolver: (e.ENSV1_RESOLVER ?? ENSV2_PRESETS[e.CHAIN].ensV1Resolver)?.toLowerCase(),
      confirmations: e.CONFIRMATIONS,
      logRange: e.LOG_RANGE,
      pollIntervalMs: e.POLL_INTERVAL_MS,
    },
  };
}
