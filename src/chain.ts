import { AsyncLocalStorage } from 'node:async_hooks';
import { createPublicClient, fallback, http, type Chain, type PublicClient } from 'viem';
import { ccipRequest } from 'viem/utils';
import { mainnet, sepolia } from 'viem/chains';
import type { Config } from './config.js';
import { Semaphore } from './util.js';

/** The UniversalResolver proxy ENS keeps at the same address on mainnet and Sepolia. */
export const UNIVERSAL_RESOLVER = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe' as const;
/** viem resolves batch-gateway requests locally when this URL is passed as the gateway. */
export const LOCAL_BATCH_GATEWAY = 'x-batch-gateway:true';

export const CHAINS: Record<Config['chain'], Chain> = { mainnet, sepolia };

/** Collects the CCIP-read gateway URLs touched while resolving one profile (enstate's `ccip_urls`). */
export const ccipUrlStore = new AsyncLocalStorage<Set<string>>();

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/**
 * CCIP-read requester. viem's local batch gateway fires every lookup in a batch at once, and
 * offchain gateways rate-limit that (Coinbase returns 429 from ~40 parallel calls). This caps
 * concurrency per gateway host and retries once on a retryable status.
 */
function makeCcipRequester(concurrencyPerHost: number) {
  const limits = new Map<string, Semaphore>();
  const limiter = (url: string) => {
    let host: string;
    try {
      host = new URL(url.replace('{sender}', 'x').replace('{data}', 'x')).host;
    } catch {
      host = url;
    }
    let s = limits.get(host);
    if (!s) limits.set(host, (s = new Semaphore(concurrencyPerHost)));
    return s;
  };
  return async (params: Parameters<typeof ccipRequest>[0]) => {
    const store = ccipUrlStore.getStore();
    for (const u of params.urls) store?.add(u);
    const sem = limiter(params.urls[0] ?? '');
    for (let attempt = 0; ; attempt++) {
      const release = await sem.acquire();
      try {
        return await ccipRequest(params);
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (attempt >= 1 || !status || !RETRY_STATUSES.has(status)) throw err;
      } finally {
        release();
      }
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
    }
  };
}

export function createClient(config: Config): PublicClient {
  const transports = config.rpcUrls.map((u) => http(u, { timeout: 20_000, retryCount: 2 }));
  return createPublicClient({
    chain: CHAINS[config.chain],
    transport: transports.length === 1 ? transports[0]! : fallback(transports),
    batch: { multicall: false },
    ccipRead: { request: makeCcipRequester(config.ccipConcurrencyPerHost) },
  }) as PublicClient;
}

/** Clients for other chains, used only to read eip155 NFT avatars. */
export function createAvatarClients(config: Config, main: PublicClient): Map<number, PublicClient> {
  const clients = new Map<number, PublicClient>([[main.chain!.id, main]]);
  for (const [id, urls] of Object.entries(config.chainRpcs)) {
    if (Number(id) === main.chain!.id || !urls.length) continue;
    clients.set(
      Number(id),
      createPublicClient({ transport: fallback(urls.map((u) => http(u, { timeout: 10_000 }))) }) as PublicClient,
    );
  }
  return clients;
}
