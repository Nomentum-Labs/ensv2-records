import type { Hex } from 'viem';
import { decodeContenthash } from './decode/contenthash.js';
import { encodeCoinAddress } from './decode/multicoin.js';

/**
 * How a stored record's `value` is encoded:
 *   utf8     text and name records, as set
 *   bytes    addr, contenthash and data records: 0x-prefixed raw bytes as stored on chain
 *   address  interface records: the implementer contract
 *   flag     abi records: '1' means an ABI is set for that content type (the value itself isn't indexed)
 */
export type RecordEncoding = 'utf8' | 'bytes' | 'address' | 'flag';

export type StoredRecord = { kind: string; key: string; value: string };

export type RecordValue = StoredRecord & {
  encoding: RecordEncoding;
  /** addr: the address in the chain's own format; contenthash: a URI such as ipfs://…. Absent when it can't be decoded. */
  decoded?: string;
};

const ENCODINGS: Record<string, RecordEncoding> = {
  text: 'utf8',
  name: 'utf8',
  addr: 'bytes',
  contenthash: 'bytes',
  data: 'bytes',
  interface: 'address',
  abi: 'flag',
};

export function describeRecord(r: StoredRecord): RecordValue {
  const out: RecordValue = { ...r, encoding: ENCODINGS[r.kind] ?? 'utf8' };
  try {
    if (r.kind === 'addr' && /^\d+$/.test(r.key) && Number.isSafeInteger(Number(r.key))) {
      out.decoded = encodeCoinAddress(Number(r.key), r.value as Hex);
    } else if (r.kind === 'contenthash') {
      out.decoded = decodeContenthash(r.value as Hex);
    }
  } catch {
    // unknown coin type or codec, or malformed bytes: the raw value is still returned
  }
  return out;
}
