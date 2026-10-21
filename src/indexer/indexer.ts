import { decodeEventLog, type Log, type PublicClient } from 'viem';
import type { Cache } from '../cache.js';
import type { Config } from '../config.js';
import { withTx, type Db } from '../db/pool.js';
import { Applier, type DecodedLog, type Invalidations } from './apply.js';
import { allTopics, topicsByEvent } from './events.js';

/** Beyond this many names in one batch, skip targeted invalidation and let the TTL expire them. */
const MAX_INVALIDATIONS = 5_000;

export type IndexerOptions = {
  db: Db;
  client: PublicClient;
  config: Config;
  cache?: Cache;
  log?: (msg: string) => void;
};

/**
 * Follows the chain `confirmations` blocks behind head (default 0: index the tip), reading every indexed event from every
 * contract with one getLogs per range. Each range is applied in one transaction together with
 * the cursor, so a crash never half-applies a range. Reorgs deeper than `confirmations` are not
 * rolled back; at 0 confirmations a reorged tip block can leave stale index rows until the
 * affected names change again (profile values still come live from the UniversalResolver).
 */
export class Indexer {
  private stopped = false;
  private range: number;
  private paths?: Awaited<ReturnType<typeof Applier.loadPaths>>;
  private readonly chain: string;
  private readonly log: (msg: string) => void;

  constructor(private readonly o: IndexerOptions) {
    const { rootRegistry, startBlock } = o.config.indexer;
    if (!rootRegistry || startBlock === undefined) {
      throw new Error(`no ENSv2 deployment configured for ${o.config.chain}; set ROOT_REGISTRY and INDEX_START_BLOCK`);
    }
    this.range = o.config.indexer.logRange;
    this.chain = o.config.chain;
    this.log = o.log ?? ((m) => console.log(`[indexer] ${m}`));
  }

  stop() {
    this.stopped = true;
  }

  async cursor(): Promise<number> {
    const r = await this.o.db.query<{ last_block: string }>('SELECT last_block FROM indexer_state WHERE chain = $1', [this.chain]);
    return r.rows[0] ? Number(r.rows[0].last_block) : this.o.config.indexer.startBlock! - 1;
  }

  /** Index until `untilBlock` (default: forever, following head). */
  async run(untilBlock?: number): Promise<void> {
    const { pollIntervalMs, confirmations } = this.o.config.indexer;
    while (!this.stopped) {
      const head = Number(await this.o.client.getBlockNumber()) - confirmations;
      const target = untilBlock !== undefined ? Math.min(untilBlock, head) : head;
      const from = (await this.cursor()) + 1;
      if (from > target) {
        if (untilBlock !== undefined && from > untilBlock) return;
        await sleep(pollIntervalMs);
        continue;
      }
      const to = Math.min(target, from + this.range - 1);
      try {
        let logs: DecodedLog[];
        try {
          logs = await this.fetchLogs(from, to);
        } catch (err) {
          if (isAheadOfHead(err)) {
            // Erigon 3.5+ reports eth_blockNumber before the block is executed, and getLogs rejects
            // it until it is. Transient; retry shortly without shrinking the range.
            await sleep(250);
            continue;
          }
          if (isRangeError(err) && this.range > 1) {
            this.range = Math.max(1, Math.floor(this.range / 2));
            this.log(`getLogs range too large, retrying with ${this.range} blocks`);
            continue;
          }
          throw err;
        }
        const inv = await this.applyRange(from, to, logs);
        await this.invalidate(inv);
        if (logs.length) this.log(`${from}-${to}: ${logs.length} logs, ${inv.names.size} names touched (head-${confirmations}=${head})`);
        if (this.range < this.o.config.indexer.logRange) this.range = Math.min(this.o.config.indexer.logRange, this.range * 2);
      } catch (err) {
        this.paths = undefined; // the in-memory path cache may hold rolled-back changes
        this.log(`error at ${from}-${to}: ${(err as Error).message.split('\n')[0]}`);
        await sleep(Math.min(pollIntervalMs, 5_000));
      }
    }
  }

  private async fetchLogs(from: number, to: number): Promise<DecodedLog[]> {
    const raw = (await this.o.client.request({
      method: 'eth_getLogs',
      params: [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [allTopics] }],
    })) as Log[];
    const out: DecodedLog[] = [];
    for (const l of raw) {
      if (l.removed) continue;
      const event = topicsByEvent.get(l.topics[0] ?? '');
      if (!event) continue;
      try {
        const d = decodeEventLog({ abi: [event], data: l.data, topics: l.topics, strict: true });
        out.push({
          address: l.address.toLowerCase(),
          block: Number(l.blockNumber),
          logIndex: Number(l.logIndex),
          eventName: d.eventName as string,
          args: d.args as Record<string, unknown>,
        });
      } catch {
        // A contract emitting an event with our topic but a different layout (e.g. no indexed
        // args). Not one of the contracts we care about.
      }
    }
    return out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  }

  private async applyRange(from: number, to: number, logs: DecodedLog[]): Promise<Invalidations> {
    return withTx(this.o.db, async (tx) => {
      this.paths ??= await Applier.loadPaths(tx, this.o.config.indexer.rootRegistry!);
      const applier = new Applier(tx, this.paths);
      for (const l of logs) await applier.apply(l);
      await tx.query(
        `INSERT INTO indexer_state (chain, last_block, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (chain) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()`,
        [this.chain, to],
      );
      return applier.inv;
    });
  }

  private async invalidate(inv: Invalidations) {
    const cache = this.o.cache;
    if (!cache || (!inv.names.size && !inv.addresses.size)) return;
    if (inv.names.size > MAX_INVALIDATIONS) {
      this.log(`${inv.names.size} names changed in one batch; leaving them to expire from the cache`);
      return;
    }
    const keys = [...[...inv.names].map((n) => `n:${n}`), ...[...inv.addresses].map((a) => `a:${a}`)];
    for (let i = 0; i < keys.length; i += 500) await cache.del(...keys.slice(i, i + 500));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const errorText = (err: unknown) => String((err as { details?: string }).details ?? (err as Error).message ?? '').toLowerCase();

function isAheadOfHead(err: unknown): boolean {
  return /beyond current head|header not found|unknown block|block not found/.test(errorText(err));
}

function isRangeError(err: unknown): boolean {
  const msg = errorText(err);
  return /block range|range is too large|limit exceeded|response size|size limit|too many (results|logs)|query returned more than/.test(msg);
}
