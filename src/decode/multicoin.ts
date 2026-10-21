import { getCoderByCoinType } from '@ensdomains/address-encoder';
import { hexToBytes, type Hex } from 'viem';

/** Encodes a resolver's raw multicoin bytes as the chain's native address string (ENSIP-9/11). */
export function encodeCoinAddress(coinType: number, raw: Hex): string {
  const coder = getCoderByCoinType(coinType);
  if (!coder) throw new Error(`unsupported coin type ${coinType}`);
  return coder.encode(hexToBytes(raw));
}
