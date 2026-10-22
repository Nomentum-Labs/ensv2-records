import { hexToBigInt, hexToBytes, type Hex } from 'viem';

/**
 * PermissionedResolver roles (PermissionedResolverLib, contracts-v2 post-audit-2). Each role is
 * one bit at the start of a 4-bit nybble; its admin role (may grant/revoke it) is the same bit
 * shifted left by 128.
 */
const ROLE_BITS = [
  ['set_address', 0],
  ['set_text', 4],
  ['set_contenthash', 8],
  ['set_abi', 12],
  ['set_interface', 16],
  ['set_name', 20],
  ['set_data', 24],
  ['link', 28],
  ['can_name', 120],
  ['upgrade', 124],
] as const;

export type RoleName = (typeof ROLE_BITS)[number][0];

export type DecodedRoles = { roles: RoleName[]; admin_roles: RoleName[]; role_bitmap: Hex };

export function decodeRoles(bitmap: bigint): DecodedRoles {
  const roles: RoleName[] = [];
  const admin: RoleName[] = [];
  for (const [name, bit] of ROLE_BITS) {
    if ((bitmap >> BigInt(bit)) & 1n) roles.push(name);
    if ((bitmap >> BigInt(bit + 128)) & 1n) admin.push(name);
  }
  return { roles, admin_roles: admin, role_bitmap: `0x${bitmap.toString(16)}` };
}

/**
 * The deployer grants CAN_NAME (and its admin) to the namer contract; holding only those
 * doesn't let an account manage the resolver's records.
 */
const NAMER_ONLY = (1n << 120n) | (1n << 248n);
export const canManage = (bitmap: bigint): boolean => (bitmap & ~NAMER_ONLY) !== 0n;

export type GrantArgument = { key?: string; coin_type?: string; content_type?: string; interface_id?: Hex };

/**
 * A per-key grant's setter argument, decoded for the roles it was granted with: the key for
 * set_text / set_data, the coin type for set_address, the content type for set_abi and the
 * interface id for set_interface.
 */
export function describeArgument(arg: Hex, roles: RoleName[]): GrantArgument {
  const bytes = hexToBytes(arg);
  const out: GrantArgument = {};
  if (roles.includes('set_text') || roles.includes('set_data')) {
    try {
      out.key = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // not a UTF-8 key; the raw argument is still returned
    }
  }
  if (bytes.length === 32 && roles.includes('set_address')) out.coin_type = hexToBigInt(arg).toString();
  if (bytes.length === 32 && roles.includes('set_abi')) out.content_type = hexToBigInt(arg).toString();
  if (bytes.length === 4 && roles.includes('set_interface')) out.interface_id = arg;
  return out;
}
