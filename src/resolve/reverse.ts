import type { Address, PublicClient } from 'viem';
import { universalResolverAbi } from '../abis.js';
import { LOCAL_BATCH_GATEWAY, UNIVERSAL_RESOLVER } from '../chain.js';
import { ETH_COIN_TYPE } from '../records.js';
import { revertErrorName } from './forward.js';
import { normalizeName } from './name.js';

/** UR errors that mean "no valid primary name" rather than an infrastructure failure. */
const NO_PRIMARY_ERRORS = new Set([
  'ResolverNotFound',
  'ResolverNotContract',
  'ReverseAddressMismatch',
  'UnsupportedResolverProfile',
]);

/**
 * Primary name for an address (ENSIP-19) via UniversalResolver.reverse. The UR verifies the
 * forward address matches, so a returned name is always valid. This also covers names set
 * through the default reverse registrar, which enstate's addr.reverse lookup misses.
 * Returns null when the address has no primary name or its primary isn't normalized.
 */
export async function lookupPrimaryName(
  client: PublicClient,
  address: Address,
  coinType: number = ETH_COIN_TYPE,
): Promise<string | null> {
  try {
    const [primary] = await client.readContract({
      address: UNIVERSAL_RESOLVER,
      abi: universalResolverAbi,
      functionName: 'reverseWithGateways',
      args: [address, BigInt(coinType), [LOCAL_BATCH_GATEWAY]],
    });
    if (!primary) return null;
    try {
      return normalizeName(primary) === primary ? primary : null;
    } catch {
      return null;
    }
  } catch (err) {
    const name = revertErrorName(err);
    if (name && NO_PRIMARY_ERRORS.has(name)) return null;
    throw err;
  }
}
