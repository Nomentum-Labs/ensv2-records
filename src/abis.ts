import { parseAbi } from 'viem';

/** UniversalResolver (ENSv2 UniversalResolverV2 behind the 0xeEeE…EeEe proxy; also the v1 UR it replaces). */
export const universalResolverAbi = parseAbi([
  'function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes result, address resolver)',
  'function reverseWithGateways(bytes lookupAddress, uint256 coinType, string[] gateways) view returns (string primary, address resolver, address reverseResolver)',
  'error ResolverNotFound(bytes name)',
  'error ResolverNotContract(bytes name, address resolver)',
  'error UnsupportedResolverProfile(bytes4 selector)',
  'error ResolverError(bytes errorData)',
  'error ReverseAddressMismatch(string primary, bytes primaryAddress)',
  'error HttpError(uint16 status, string message)',
]);

/** Resolver profile functions, called through the UniversalResolver. */
export const resolverAbi = parseAbi([
  'function multicall(bytes[] data) returns (bytes[] results)',
  'function addr(bytes32 node) view returns (address)',
  'function addr(bytes32 node, uint256 coinType) view returns (bytes)',
  'function text(bytes32 node, string key) view returns (string)',
  'function contenthash(bytes32 node) view returns (bytes)',
]);

/** Errors that can appear inside a single multicall answer. */
export const answerErrorAbi = parseAbi([
  'error HttpError(uint16 status, string message)',
  'error Error(string message)',
  'error UnsupportedResolverProfile(bytes4 selector)',
  'error ResolverError(bytes errorData)',
]);

export const nftAbi = parseAbi([
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function uri(uint256 id) view returns (string)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
]);
