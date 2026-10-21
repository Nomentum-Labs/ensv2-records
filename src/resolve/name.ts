import { getAddress, isAddress, toHex, type Address, type Hex } from 'viem';
import { normalize, packetToBytes } from 'viem/ens';

export class InvalidInputError extends Error {
  readonly status = 400;
}

export type Lookup = { type: 'name'; name: string } | { type: 'address'; address: Address };

/** ENSIP-15 normalize. Throws InvalidInputError for names that can't be normalized. */
export function normalizeName(input: string): string {
  const raw = input.trim();
  if (!raw || !raw.includes('.')) throw new InvalidInputError(`invalid name: ${input}`);
  try {
    return normalize(raw);
  } catch (err) {
    throw new InvalidInputError(`invalid name: ${input} (${(err as Error).message.split('\n')[0]})`);
  }
}

export function parseAddress(input: string): Address {
  const raw = input.trim();
  if (!isAddress(raw, { strict: false })) throw new InvalidInputError(`invalid address: ${input}`);
  return getAddress(raw);
}

/** `/u/:query` accepts either form, like enstate's LookupInfo::guess. */
export function guessLookup(input: string): Lookup {
  const raw = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return { type: 'address', address: parseAddress(raw) };
  return { type: 'name', name: normalizeName(raw) };
}

/** DNS wire-format encoding used by the UniversalResolver. Labels over 255 bytes become [labelhash]. */
export const dnsEncode = (name: string): Hex => toHex(packetToBytes(name));
