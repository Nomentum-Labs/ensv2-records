import { parseAbi, toEventSelector, type AbiEvent } from 'viem';

/**
 * Events the indexer reads, from every contract (no address filter). Signatures are from
 * ensdomains/contracts-v2 `post-audit-2` and ens-contracts `staging`; all decoded with zero
 * errors across Sepolia since the v2 deploy (phase 0 survey, 2026-10-20).
 */
export const indexedEvents = parseAbi([
  // ENSv2 registries (PermissionedRegistry, UserRegistry, WrapperRegistry)
  'event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)',
  'event LabelReserved(uint256 indexed tokenId, bytes32 indexed labelHash, string label, uint64 expiry, address indexed sender)',
  'event LabelUnregistered(uint256 indexed tokenId, address indexed sender)',
  'event ExpiryUpdated(uint256 indexed tokenId, uint64 indexed newExpiry, address indexed sender)',
  'event SubregistryUpdated(uint256 indexed tokenId, address indexed subregistry, address indexed sender)',
  'event ResolverUpdated(uint256 indexed tokenId, address indexed resolver, address indexed sender)',
  'event TokenRegenerated(uint256 indexed oldTokenId, uint256 indexed newTokenId)',
  // ENSv2 PermissionedResolver (records keyed by recordId, names attached via Linked)
  'event Linked(uint256 indexed recordId, bytes32 indexed node, bytes name)',
  'event TextUpdated(uint256 indexed recordId, string indexed keyHash, string key, string value)',
  'event AddressUpdated(uint256 indexed recordId, uint256 coinType, bytes addressBytes)',
  'event ContenthashUpdated(uint256 indexed recordId, bytes hash)',
  'event DataUpdated(uint256 indexed recordId, string indexed keyHash, string key, bytes value)',
  'event NameUpdated(uint256 indexed recordId, string primaryName)',
  'event ABIUpdated(uint256 indexed recordId, uint256 indexed contentType)',
  'event InterfaceUpdated(uint256 indexed recordId, bytes4 indexed interfaceId, address implementer)',
  // node-keyed resolvers (PublicResolverV2 and v1-style resolvers)
  'event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)',
  'event AddrChanged(bytes32 indexed node, address a)',
  'event AddressChanged(bytes32 indexed node, uint256 coinType, bytes newAddress)',
  'event ContenthashChanged(bytes32 indexed node, bytes hash)',
  'event NameChanged(bytes32 indexed node, string name)',
  'event VersionChanged(bytes32 indexed node, uint64 newVersion)',
  // reverse registrars (primary names)
  'event ReverseClaimed(address indexed addr, bytes32 indexed node)',
  'event NameForAddrChanged(address indexed addr, string name)',
]);

export type IndexedEventName = (typeof indexedEvents)[number]['name'];

export const topicsByEvent = new Map<string, AbiEvent>(indexedEvents.map((e) => [toEventSelector(e), e]));
export const allTopics = [...topicsByEvent.keys()] as `0x${string}`[];
