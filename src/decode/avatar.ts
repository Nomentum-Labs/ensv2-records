import { getAddress, isAddressEqual, pad, toHex, type Address, type PublicClient } from 'viem';
import { nftAbi } from '../abis.js';
import { withTimeout } from '../util.js';

export type ImageContext = {
  /** The name's ETH address, used for the ENSIP-12 NFT ownership check. */
  owner: Address | null;
  clients: Map<number, PublicClient>;
  ipfsGateway: string;
  arweaveGateway: string;
  verifyNftOwner: boolean;
  fetch?: typeof fetch;
};

const NFT_URI = /^eip155:(\d+)\/(erc721|erc1155):(0x[0-9a-fA-F]{40})\/(\d+)$/i;
const METADATA_TIMEOUT_MS = 5_000;

/** Turns ipfs://, ipns://, ar:// and bare IPFS paths into gateway URLs; leaves http(s) and data: alone. */
export function toGatewayUrl(uri: string, ctx: Pick<ImageContext, 'ipfsGateway' | 'arweaveGateway'>): string {
  const u = uri.trim();
  if (/^(https?:|data:)/i.test(u)) return u;
  let m = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(u) ?? /^\/?ipfs\/(.+)$/i.exec(u);
  if (m) return `${ctx.ipfsGateway}${m[1]}`;
  m = /^ipns:\/\/(.+)$/i.exec(u);
  if (m) return `${ctx.ipfsGateway.replace(/ipfs\/$/, 'ipns/')}${m[1]}`;
  m = /^ar:\/\/(.+)$/i.exec(u);
  if (m) return `${ctx.arweaveGateway}${m[1]}`;
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})(\/.*)?$/.test(u)) return `${ctx.ipfsGateway}${u}`;
  return u;
}

/**
 * Resolves an avatar/header record (ENSIP-12) to a URL a browser can load.
 * eip155 NFT references are followed to the token's image.
 */
export async function resolveImage(record: string, ctx: ImageContext): Promise<string> {
  const nft = NFT_URI.exec(record.trim());
  if (!nft) return toGatewayUrl(record, ctx);

  const [, chainIdStr, standard, contractStr, tokenIdStr] = nft;
  const chainId = Number(chainIdStr);
  const client = ctx.clients.get(chainId);
  if (!client) throw new Error(`no RPC configured for chain ${chainId}`);
  const contract = getAddress(contractStr!);
  const tokenId = BigInt(tokenIdStr!);
  const is721 = standard!.toLowerCase() === 'erc721';

  if (ctx.verifyNftOwner) {
    if (!ctx.owner) throw new Error('name has no ETH address to verify NFT ownership');
    if (is721) {
      const holder = await client.readContract({ address: contract, abi: nftAbi, functionName: 'ownerOf', args: [tokenId] });
      if (!isAddressEqual(holder, ctx.owner)) throw new Error('NFT is not owned by the name');
    } else {
      const bal = await client.readContract({ address: contract, abi: nftAbi, functionName: 'balanceOf', args: [ctx.owner, tokenId] });
      if (bal === 0n) throw new Error('NFT is not owned by the name');
    }
  }

  let tokenUri = await client.readContract({
    address: contract,
    abi: nftAbi,
    functionName: is721 ? 'tokenURI' : 'uri',
    args: [tokenId],
  });
  // ERC-1155 substitutes {id} with the lowercase hex token id padded to 64 chars.
  if (!is721) tokenUri = tokenUri.replace('{id}', pad(toHex(tokenId), { size: 32 }).slice(2));

  const metadata = await fetchJson(toGatewayUrl(tokenUri, ctx), ctx.fetch ?? fetch);
  const image = metadata.image ?? metadata.image_url;
  if (typeof image === 'string' && image) return toGatewayUrl(image, ctx);
  if (typeof metadata.image_data === 'string' && metadata.image_data) {
    return `data:image/svg+xml;base64,${Buffer.from(metadata.image_data).toString('base64')}`;
  }
  throw new Error('NFT metadata has no image');
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const data = /^data:application\/json(;base64)?,(.*)$/is.exec(url);
  if (data) {
    const body = data[1] ? Buffer.from(data[2]!, 'base64').toString('utf8') : decodeURIComponent(data[2]!);
    return JSON.parse(body) as Record<string, unknown>;
  }
  const res = await withTimeout(fetchImpl(url, { headers: { accept: 'application/json' } }), METADATA_TIMEOUT_MS, 'NFT metadata fetch');
  if (!res.ok) throw new Error(`NFT metadata HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}
