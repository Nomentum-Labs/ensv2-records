import { namehash } from 'viem';
import type { Db } from './db/pool.js';

/**
 * Where to learn which text-record keys a name actually has. The UniversalResolver can't
 * enumerate keys, so without this only the default key list is fetched.
 */
export interface KeySource {
  /** `resolver` is the resolver the UniversalResolver used for the name. */
  keysFor(name: string, resolver: string): Promise<string[]>;
}

export const noExtraKeys: KeySource = {
  async keysFor() {
    return [];
  },
};

/**
 * Keys from the records indexer. PermissionedResolver names read the record linked to their
 * node, falling back to the default record (node 0x00…00). Node-keyed resolvers store records
 * by node. For unmigrated v1 names the UR reports ENSv2's bridge resolver, so the name's
 * node-keyed records from any resolver are used (keys only add lookups; values still come from
 * the UniversalResolver, so stale keys are harmless).
 */
export class IndexedKeySource implements KeySource {
  constructor(
    private readonly db: Db,
    private readonly ensV1Resolver?: string,
  ) {}

  async keysFor(name: string, resolver: string): Promise<string[]> {
    const node = namehash(name);
    const r = resolver.toLowerCase();
    const bridge = this.ensV1Resolver !== undefined && r === this.ensV1Resolver;
    const rows = await this.db.query<{ key: string }>(
      `WITH rec AS (
         SELECT COALESCE(
           (SELECT NULLIF(record_id, 0) FROM resolver_links WHERE resolver = $1 AND node = $2),
           (SELECT NULLIF(record_id, 0) FROM resolver_links WHERE resolver = $1 AND node = $3)
         ) AS id
       )
       SELECT DISTINCT key FROM resolver_records
       WHERE kind = 'text' AND value IS NOT NULL AND (
         (resolver = $1 AND scope = 'r:' || (SELECT id FROM rec)::text)
         OR (resolver = $1 AND scope = 'n:' || $2)
         OR ($4 AND scope = 'n:' || $2)
       )
       LIMIT 500`,
      [r, node, `0x${'0'.repeat(64)}`, bridge],
    );
    return rows.rows.map((x) => x.key);
  }
}
