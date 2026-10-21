import { namehash } from 'viem';
import type { Db } from '../db/pool.js';

export type IndexedName = {
  name: string;
  node: string;
  registry: string;
  label: string | null;
  labelhash: string | null;
  token_id: string | null;
  status: string;
  expiry: number | null;
  resolver: string | null;
  subregistry: string | null;
  /** PermissionedResolver record the name reads (null = default record or node-keyed resolver). */
  record_id: string | null;
  /** Records the indexer has seen on the name's resolver (values here may lag the chain; use /n for live values). */
  records: { kind: string; key: string; value: string }[];
  updated_block: number;
};

/** Read side of the index, for the /v2 routes and /health. */
export class IndexQueries {
  constructor(
    private readonly db: Db,
    private readonly chain: string,
  ) {}

  async status(): Promise<{ last_block: number | null; updated_at: string | null }> {
    const r = await this.db.query<{ last_block: string; updated_at: Date }>('SELECT last_block, updated_at FROM indexer_state WHERE chain = $1', [this.chain]);
    const row = r.rows[0];
    return { last_block: row ? Number(row.last_block) : null, updated_at: row ? row.updated_at.toISOString() : null };
  }

  /** ENSv2 registry entry for a (normalized) name, or null if the index doesn't know it. */
  async name(name: string): Promise<IndexedName | null> {
    const node = namehash(name);
    const r = await this.db.query<{
      registry: string;
      label: string | null;
      labelhash: string | null;
      token_id: string | null;
      status: string;
      expiry: string | null;
      resolver: string | null;
      subregistry: string | null;
      updated_block: string;
    }>(
      `SELECT registry, label, labelhash, token_id, status, expiry, resolver, subregistry, updated_block
       FROM registry_labels WHERE node = $1 ORDER BY updated_block DESC LIMIT 1`,
      [node],
    );
    const row = r.rows[0];
    if (!row) return null;
    let recordId: string | null = null;
    let records: IndexedName['records'] = [];
    if (row.resolver) {
      const link = await this.db.query<{ id: string | null }>(
        `SELECT COALESCE(
           (SELECT NULLIF(record_id, 0) FROM resolver_links WHERE resolver = $1 AND node = $2),
           (SELECT NULLIF(record_id, 0) FROM resolver_links WHERE resolver = $1 AND node = $3)) AS id`,
        [row.resolver, node, `0x${'0'.repeat(64)}`],
      );
      recordId = link.rows[0]?.id ?? null;
      const recs = await this.db.query<{ kind: string; key: string; value: string }>(
        `SELECT kind, key, value FROM resolver_records
         WHERE resolver = $1 AND value IS NOT NULL AND (scope = $2 OR scope = $3)
         ORDER BY kind, key`,
        [row.resolver, `r:${recordId ?? 'none'}`, `n:${node}`],
      );
      records = recs.rows;
    }
    return {
      name,
      node,
      registry: row.registry,
      label: row.label,
      labelhash: row.labelhash,
      token_id: row.token_id,
      status: row.status,
      expiry: row.expiry === null ? null : Number(row.expiry), // uint64 max (never expires) loses precision but stays far in the future
      resolver: row.resolver,
      subregistry: row.subregistry,
      record_id: recordId,
      records,
      updated_block: Number(row.updated_block),
    };
  }
}
