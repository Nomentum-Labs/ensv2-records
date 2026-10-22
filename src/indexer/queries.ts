import { namehash, pad, toHex, zeroHash, type Hex } from 'viem';
import type { Db } from '../db/pool.js';
import { canManage, decodeRoles, describeArgument, type DecodedRoles, type GrantArgument } from '../roles.js';

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

export type StoredRecord = { kind: string; key: string; value: string };

export type ResolverRecords = {
  resolver: string;
  /** Records created on this resolver; ids run from 1 to record_count. */
  record_count: number;
  /** Record used by names that aren't linked to one (linked to the root node). */
  default_record_id: string | null;
  limit: number;
  offset: number;
  records: {
    record_id: string;
    /** Names linked to this record (first NAMES_PER_RECORD, alphabetical). */
    names: string[];
    name_count: number;
    records: StoredRecord[];
  }[];
};

export type ResolverAccount = { account: string } & DecodedRoles;
export type KeyGrant = ResolverAccount & { resource: Hex; arg: Hex | null } & GrantArgument;

export type ResolverInfo = {
  address: string;
  created_block: number;
  record_count: number;
  default_record_id: string | null;
  /** Accounts with roles on the root resource (every key). */
  accounts: ResolverAccount[];
  /** Roles limited to one key, coin type, content type or interface. */
  key_grants: KeyGrant[];
};

export type AccountResolver = { address: string; created_block: number; record_count: number } & DecodedRoles;

const NAMES_PER_RECORD = 100;
const hex32 = (v: string) => pad(toHex(BigInt(v)), { size: 32 }).toLowerCase() as Hex;

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

  private async resolverRow(address: string) {
    const r = await this.db.query<{ created_block: string; record_count: string }>(
      'SELECT created_block, record_count FROM resolvers WHERE address = $1',
      [address],
    );
    return r.rows[0];
  }

  private async defaultRecordId(address: string): Promise<string | null> {
    const r = await this.db.query<{ record_id: string }>(
      'SELECT record_id::text FROM resolver_links WHERE resolver = $1 AND node = $2 AND record_id <> 0',
      [address, zeroHash],
    );
    return r.rows[0]?.record_id ?? null;
  }

  /** Records on a PermissionedResolver, with the names linked to each. Null if not a known resolver. */
  async resolverRecords(resolver: string, limit: number, offset: number): Promise<ResolverRecords | null> {
    const address = resolver.toLowerCase();
    const row = await this.resolverRow(address);
    if (!row) return null;
    const count = Number(row.record_count);
    const ids: string[] = [];
    for (let id = offset + 1; id <= Math.min(count, offset + limit); id++) ids.push(String(id));

    const recs = await this.db.query<{ scope: string } & StoredRecord>(
      `SELECT scope, kind, key, value FROM resolver_records
       WHERE resolver = $1 AND scope = ANY($2::text[]) AND value IS NOT NULL
       ORDER BY kind, key`,
      [address, ids.map((id) => `r:${id}`)],
    );
    const links = await this.db.query<{ record_id: string; name: string; name_count: string }>(
      `SELECT record_id, name, name_count FROM (
         SELECT record_id::text, name, count(*) OVER (PARTITION BY record_id) AS name_count,
                row_number() OVER (PARTITION BY record_id ORDER BY name) AS n
         FROM resolver_links
         WHERE resolver = $1 AND record_id = ANY($2::numeric[]) AND name IS NOT NULL
       ) l WHERE n <= $3`,
      [address, ids, NAMES_PER_RECORD],
    );

    const byId = new Map(ids.map((id) => [id, { record_id: id, names: [] as string[], name_count: 0, records: [] as StoredRecord[] }]));
    for (const r of recs.rows) byId.get(r.scope.slice(2))?.records.push({ kind: r.kind, key: r.key, value: r.value });
    for (const l of links.rows) {
      const rec = byId.get(l.record_id);
      if (!rec) continue;
      rec.names.push(l.name);
      rec.name_count = Number(l.name_count);
    }
    return {
      resolver: address,
      record_count: count,
      default_record_id: await this.defaultRecordId(address),
      limit,
      offset,
      records: [...byId.values()],
    };
  }

  /** A PermissionedResolver and every account holding roles on it. Null if not a known resolver. */
  async resolver(resolver: string): Promise<ResolverInfo | null> {
    const address = resolver.toLowerCase();
    const row = await this.resolverRow(address);
    if (!row) return null;
    const roles = await this.db.query<{ resource: string; account: string; role_bitmap: string; arg: string | null }>(
      `SELECT r.resource::text, r.account, r.role_bitmap::text, a.arg
       FROM resolver_roles r
       LEFT JOIN resolver_resource_args a ON a.resolver = r.resolver AND a.resource = r.resource
       WHERE r.resolver = $1 AND r.role_bitmap <> 0
       ORDER BY r.resource, r.account`,
      [address],
    );
    const accounts: ResolverAccount[] = [];
    const keyGrants: KeyGrant[] = [];
    for (const r of roles.rows) {
      const decoded = decodeRoles(BigInt(r.role_bitmap));
      if (r.resource === '0') {
        accounts.push({ account: r.account, ...decoded });
      } else {
        const arg = (r.arg as Hex | null) ?? null;
        keyGrants.push({ account: r.account, ...decoded, resource: hex32(r.resource), arg, ...(arg ? describeArgument(arg, decoded.roles) : {}) });
      }
    }
    return {
      address,
      created_block: Number(row.created_block),
      record_count: Number(row.record_count),
      default_record_id: await this.defaultRecordId(address),
      accounts,
      key_grants: keyGrants,
    };
  }

  /**
   * PermissionedResolvers where `account` holds roles on the root resource, oldest first.
   * Accounts that only hold the namer role are left out.
   */
  async resolversByAccount(account: string): Promise<AccountResolver[]> {
    const r = await this.db.query<{ address: string; created_block: string; record_count: string; role_bitmap: string }>(
      `SELECT v.address, v.created_block, v.record_count, r.role_bitmap::text
       FROM resolver_roles r JOIN resolvers v ON v.address = r.resolver
       WHERE r.account = $1 AND r.resource = 0 AND r.role_bitmap <> 0
       ORDER BY v.created_block, v.address`,
      [account.toLowerCase()],
    );
    return r.rows
      .filter((row) => canManage(BigInt(row.role_bitmap)))
      .map((row) => ({
        address: row.address,
        created_block: Number(row.created_block),
        record_count: Number(row.record_count),
        ...decodeRoles(BigInt(row.role_bitmap)),
      }));
  }
}
