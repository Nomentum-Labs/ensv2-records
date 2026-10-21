import { coinNameToTypeMap } from '@ensdomains/address-encoder';
import { evmChainIdToCoinType } from '@ensdomains/address-encoder/utils';

/**
 * Text records fetched for every profile. Union of enstate's defaults, the keys
 * EFP deploys with (adds `status`) and the keys Grails reads.
 * Names on indexed resolvers also get every key they actually have set (see KeySource).
 */
export const DEFAULT_RECORD_KEYS = [
  'avatar',
  'header',
  'display',
  'name',
  'description',
  'url',
  'email',
  'mail',
  'location',
  'timezone',
  'language',
  'pronouns',
  'status',
  'keywords',
  'notice',
  'phone',
  'com.twitter',
  'com.github',
  'com.discord',
  'com.reddit',
  'com.linkedin',
  'org.telegram',
  'org.matrix',
  'io.keybase',
  'xyz.farcaster',
  'social.bsky',
  'social.mastodon',
  'network.dm3.profile',
  'network.dm3.deliveryService',
];

/**
 * The records fetched first for every name, and the only ones fetched for offchain (CCIP-read)
 * names. Each offchain lookup is a separate HTTP request to the name's gateway, and gateways
 * rate-limit hard (Coinbase's 429s at ~40 requests), so offchain profiles stay small.
 * These are the keys EFP, EIK and Grails display.
 */
export const CORE_RECORD_KEYS = [
  'avatar',
  'header',
  'display',
  'name',
  'description',
  'url',
  'email',
  'location',
  'status',
  'com.twitter',
  'com.github',
  'com.discord',
  'org.telegram',
];

const coin = (name: string): number => {
  const t = (coinNameToTypeMap as Record<string, number>)[name];
  if (t === undefined) throw new Error(`unknown coin name ${name}`);
  return t;
};

/**
 * Display names for the `chains` map. Names match enstate where enstate had the coin,
 * so existing consumers keep working.
 */
export const COIN_DISPLAY_NAMES: Record<number, string> = {
  [coin('eth')]: 'eth',
  [coin('btc')]: 'btc',
  [coin('ltc')]: 'ltc',
  [coin('doge')]: 'doge',
  [coin('bch')]: 'bch',
  [coin('etc')]: 'etc',
  [coin('xmr')]: 'xmr',
  [coin('xrp')]: 'ripple',
  [coin('xlm')]: 'stellar',
  [coin('xtz')]: 'tezos',
  [coin('hbar')]: 'hedera',
  [coin('ada')]: 'cardano',
  [coin('mona')]: 'mona',
  [coin('rbtc')]: 'rootstock',
  [coin('bnb')]: 'bnb',
  [coin('sol')]: 'sol',
  [coin('dot')]: 'dot',
  [evmChainIdToCoinType(10)]: 'optimism',
  [evmChainIdToCoinType(56)]: 'bsc',
  [evmChainIdToCoinType(100)]: 'gnosis',
  [evmChainIdToCoinType(137)]: 'polygon',
  [evmChainIdToCoinType(250)]: 'fantom',
  [evmChainIdToCoinType(324)]: 'zksync',
  [evmChainIdToCoinType(1284)]: 'moonbeam',
  [evmChainIdToCoinType(8453)]: 'base',
  [evmChainIdToCoinType(42161)]: 'arbitrum',
  [evmChainIdToCoinType(42220)]: 'celo',
  [evmChainIdToCoinType(43114)]: 'avalanche',
  [evmChainIdToCoinType(59144)]: 'linea',
  [evmChainIdToCoinType(534352)]: 'scroll',
};

export const ETH_COIN_TYPE = 60;
export const DEFAULT_COIN_TYPES = Object.keys(COIN_DISPLAY_NAMES).map(Number);

export const coinDisplayName = (coinType: number): string => COIN_DISPLAY_NAMES[coinType] ?? String(coinType);
