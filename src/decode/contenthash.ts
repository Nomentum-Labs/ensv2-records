import { decode, getCodec } from '@ensdomains/content-hash';
import type { Hex } from 'viem';

const SCHEMES: Record<string, string> = {
  ipfs: 'ipfs://',
  ipns: 'ipns://',
  swarm: 'bzz://',
  arweave: 'ar://',
  onion: 'onion://',
  onion3: 'onion3://',
  skynet: 'sia://',
};

/** ENSIP-7 contenthash bytes → URI, e.g. ipfs://bafy…. enstate only supported IPFS. */
export function decodeContenthash(raw: Hex): string {
  const codec = getCodec(raw);
  if (!codec) throw new Error('unknown contenthash codec');
  const scheme = SCHEMES[codec];
  if (!scheme) throw new Error(`unsupported contenthash codec ${codec}`);
  return `${scheme}${decode(raw)}`;
}
