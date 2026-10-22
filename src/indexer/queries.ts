import { namehash, pad, toHex, zeroHash, type Hex } from 'viem';
import type { Db } from '../db/pool.js';
import { describeRecord, type RecordValue, type StoredRecord } from '../record-values.js';
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
  /** PermissionedResolver record the name reads: its own link, else the resolver's default record (null = none, or a node-keyed resolver). */
  record_id: string | null;
  /** Record the name is explicitly linked to (null = no link of its own). */
  linked_record_id: string | null;
  /** True when the name has no link of its own and reads the resolver's default record. */
  uses_default: boolean;
  /** Records the indexer has seen on the name's resolver (values here may lag the chain; use /n for live values). */
  records: RecordValue[];
  updated_block: number;
};

/** When a resolver was created and last changed (records, links, roles or key grants). Times are null until looked up. */
export type ResolverSummary = {
  address: string;
  created_block: number;
  created_at: string | null;
  updated_block: number;
  updated_at: string | null;
  /** Records created on this resolver; ids run from 1 to record_count. */
  record_count: number;
};

export type ResolverRecords = {
  resolver: string;
  record_count: number;
  /** Record used by names that aren't linked to one (linked to the root node). */
  default_record_id: string | null;
  limit: number;
  offset: number;
  records: {
    record_id: string;
    is_default: boolean;
    /** First NAMES_PER_RECORD names using this record, alphabetical (see /records/:id/names for the rest). */
    names: string[];
    /** linked_name_count + inherited_name_count. */
    name_count: number;
    /** Names explicitly linked to this record. */
    linked_name_count: number;
    /** Default record only: names on this resolver with no link of their own (registered, not expired). */
    inherited_name_count: number;
    records: RecordValue[];
  }[];
};

export type RecordNames = {
  resolver: string;
  record_id: string;
  is_default: boolean;
  /** Matching names (all of them when there is no q). */
  total: number;
  limit: number;
  offset: number;
  /** linked = false: the name has no link of its own and inherits the default record. */
  names: { name: string; linked: boolean }[];
};

export type KeyRoles = DecodedRoles & { resource: Hex; arg: Hex | null } & GrantArgument;
export type ResolverAccount = { account: string } & DecodedRoles;
export type KeyGrant = { account: string } & KeyRoles;

export type ResolverInfo = ResolverSummary & {
  default_record_id: string | null;
  /** Names on this resolver with no link of their own (registered, not expired); they read the default record if there is one. */
  unlinked_name_count: number;
  /** Accounts with roles on the root resource (every key). */
  accounts: ResolverAccount[];
  /** Roles limited to one key, coin type, content type or interface. */
  key_grants: KeyGrant[];
};

/** A resolver an account holds any role on: root roles (every key) plus roles on single keys. */
export type AccountResolver = ResolverSummary &
  DecodedRoles & {
    /** Holds a role that can change records or links (not just the namer role). */
    manages_records: boolean;
    key_grants: KeyRoles[];
  };

const NAMES_PER_RECORD = 100;
const hex32 = (v: string) => pad(toHex(BigInt(v)), { size: 32 }).toLowerCase() as Hex;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const isoTime = (ts: string | null) => (ts === null ? null : new Date(Number(ts) * 1000).toISOString());

/**
 * Names on resolver `resolver` with no link of their own: the resolver is set in the registry, the
 * name is registered and not expired at `now` (an expired name's resolver reads as 0 on chain),
 * and there's no non-zero link for its node. Arguments are SQL parameter placeholders. Columns: name.
 */
const unlinkedNames = (resolver: string, now: string) => `
  SELECT DISTINCT l.name FROM registry_labels l
  WHERE l.resolver = ${resolver} AND l.name IS NOT NULL AND l.status = 'registered' AND l.expiry > ${now}
    AND NOT EXISTS (SELECT 1 FROM resolver_links k WHERE k.resolver = ${resolver} AND k.node = l.node AND k.record_id <> 0)`;

/** Names explicitly linked to a record (the root link of the default record has no name). Columns: name. */
const linkedNames = (resolver: string, recordId: string) => `
  SELECT name FROM resolver_links WHERE resolver = ${resolver} AND record_id = ${recordId} AND node <> '${zeroHash}' AND name IS NOT NULL`;

const SUMMARY = `
  SELECT v.address, v.created_block, GREATEST(v.created_block, v.updated_block) AS updated_block, v.record_count::text,
         tc.timestamp::text AS created_ts, tu.timestamp::text AS updated_ts
  FROM resolvers v
  LEFT JOIN block_times tc ON tc.block = v.created_block
  LEFT JOIN block_times tu ON tu.block = GREATEST(v.created_block, v.updated_block)`;

type SummaryRow = { address: string; created_block: string; updated_block: string; record_count: string; created_ts: string | null; updated_ts: string | null };

const toSummary = (r: SummaryRow): ResolverSummary => ({
  address: r.address,
  created_block: Number(r.created_block),
  created_at: isoTime(r.created_ts),
  updated_block: Number(r.updated_block),
  updated_at: isoTime(r.updated_ts),
  record_count: Number(r.record_count),
});

/** Escapes LIKE wildcards so q matches literally. */
const likeContains = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

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
    let linkedId: string | null = null;
    let recordId: string | null = null;
    let records: RecordValue[] = [];
    if (row.resolver) {
      const link = await this.db.query<{ id: string }>(
        'SELECT record_id::text AS id FROM resolver_links WHERE resolver = $1 AND node = $2 AND record_id <> 0',
        [row.resolver, node],
      );
      linkedId = link.rows[0]?.id ?? null;
      recordId = linkedId ?? (await this.defaultRecordId(row.resolver));
      const recs = await this.db.query<StoredRecord>(
        `SELECT kind, key, value FROM resolver_records
         WHERE resolver = $1 AND value IS NOT NULL AND (scope = $2 OR scope = $3)
         ORDER BY kind, key`,
        [row.resolver, `r:${recordId ?? 'none'}`, `n:${node}`],
      );
      records = recs.rows.map(describeRecord);
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
      linked_record_id: linkedId,
      uses_default: linkedId === null && recordId !== null,
      records,
      updated_block: Number(row.updated_block),
    };
  }

  private async summaries(addresses: string[]): Promise<Map<string, ResolverSummary>> {
    const r = await this.db.query<SummaryRow>(`${SUMMARY} WHERE v.address = ANY($1::text[])`, [addresses]);
    return new Map(r.rows.map((row) => [row.address, toSummary(row)]));
  }

  private async defaultRecordId(address: string): Promise<string | null> {
    const r = await this.db.query<{ record_id: string }>(
      'SELECT record_id::text FROM resolver_links WHERE resolver = $1 AND node = $2 AND record_id <> 0',
      [address, zeroHash],
    );
    return r.rows[0]?.record_id ?? null;
  }

  private async unlinkedCount(address: string): Promise<number> {
    const r = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM (${unlinkedNames('$1', '$2')}) u`, [address, nowSeconds()]);
    return Number(r.rows[0]!.n);
  }

  /** Records on a PermissionedResolver, with the names using each. Null if not a known resolver. */
  async resolverRecords(resolver: string, limit: number, offset: number): Promise<ResolverRecords | null> {
    const address = resolver.toLowerCase();
    const summary = (await this.summaries([address])).get(address);
    if (!summary) return null;
    const count = summary.record_count;
    const defaultId = await this.defaultRecordId(address);
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
         WHERE resolver = $1 AND record_id = ANY($2::numeric[]) AND node <> $4 AND name IS NOT NULL
       ) l WHERE n <= $3`,
      [address, ids, NAMES_PER_RECORD, zeroHash],
    );

    const byId = new Map(
      ids.map((id) => [
        id,
        {
          record_id: id,
          is_default: id === defaultId,
          names: [] as string[],
          name_count: 0,
          linked_name_count: 0,
          inherited_name_count: 0,
          records: [] as RecordValue[],
        },
      ]),
    );
    for (const { scope, ...r } of recs.rows) byId.get(scope.slice(2))?.records.push(describeRecord(r));
    for (const l of links.rows) {
      const rec = byId.get(l.record_id);
      if (!rec) continue;
      rec.names.push(l.name);
      rec.linked_name_count = Number(l.name_count);
    }
    const def = defaultId ? byId.get(defaultId) : undefined;
    if (def) {
      // the default record's names include those inheriting it, so take its preview from the combined list
      const page = await this.namesPage(address, defaultId!, true, NAMES_PER_RECORD, 0);
      def.names = page.names.map((n) => n.name);
      def.inherited_name_count = page.inherited;
    }
    for (const rec of byId.values()) rec.name_count = rec.linked_name_count + rec.inherited_name_count;
    return { resolver: address, record_count: count, default_record_id: defaultId, limit, offset, records: [...byId.values()] };
  }

  /** Names using one record of a PermissionedResolver, alphabetical. Null if not a known resolver. */
  async recordNames(resolver: string, recordId: string, limit: number, offset: number, q?: string): Promise<RecordNames | null> {
    const address = resolver.toLowerCase();
    if (!(await this.summaries([address])).has(address)) return null;
    const isDefault = (await this.defaultRecordId(address)) === recordId;
    const page = await this.namesPage(address, recordId, isDefault, limit, offset, q);
    return { resolver: address, record_id: recordId, is_default: isDefault, total: page.total, limit, offset, names: page.names };
  }

  private async namesPage(address: string, recordId: string, isDefault: boolean, limit: number, offset: number, q?: string) {
    // $1 resolver, $2 record id, $3 search pattern or null, $4 now (default record only)
    const params: unknown[] = [address, recordId, q ? likeContains(q.toLowerCase()) : null];
    if (isDefault) params.push(nowSeconds());
    const names = `
      SELECT name, true AS linked FROM (${linkedNames('$1', '$2')}) k
      ${isDefault ? `UNION ALL SELECT name, false FROM (${unlinkedNames('$1', '$4')}) u` : ''}`;
    const where = 'WHERE $3::text IS NULL OR name LIKE $3';
    const counts = await this.db.query<{ total: string; inherited: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE NOT linked) AS inherited FROM (${names}) n ${where}`,
      params,
    );
    const n = params.length;
    const rows = await this.db.query<{ name: string; linked: boolean }>(
      `SELECT name, linked FROM (${names}) n ${where} ORDER BY name LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...params, limit, offset],
    );
    return { total: Number(counts.rows[0]!.total), inherited: Number(counts.rows[0]!.inherited), names: rows.rows };
  }

  /** A PermissionedResolver and every account holding roles on it. Null if not a known resolver. */
  async resolver(resolver: string): Promise<ResolverInfo | null> {
    const address = resolver.toLowerCase();
    const summary = (await this.summaries([address])).get(address);
    if (!summary) return null;
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
      if (r.resource === '0') accounts.push({ account: r.account, ...decodeRoles(BigInt(r.role_bitmap)) });
      else keyGrants.push({ account: r.account, ...keyRoles(r) });
    }
    return {
      ...summary,
      default_record_id: await this.defaultRecordId(address),
      unlinked_name_count: await this.unlinkedCount(address),
      accounts,
      key_grants: keyGrants,
    };
  }

  /**
   * PermissionedResolvers where `account` holds any role, on every key or on a single key, oldest
   * first.
   */
  async resolversByAccount(account: string): Promise<AccountResolver[]> {
    const r = await this.db.query<{ resolver: string; resource: string; role_bitmap: string; arg: string | null }>(
      `SELECT r.resolver, r.resource::text, r.role_bitmap::text, a.arg
       FROM resolver_roles r
       LEFT JOIN resolver_resource_args a ON a.resolver = r.resolver AND a.resource = r.resource
       WHERE r.account = $1 AND r.role_bitmap <> 0
       ORDER BY r.resource`,
      [account.toLowerCase()],
    );
    const byResolver = new Map<string, { root: bigint; grants: KeyRoles[] }>();
    for (const row of r.rows) {
      const entry = byResolver.get(row.resolver) ?? { root: 0n, grants: [] };
      byResolver.set(row.resolver, entry);
      if (row.resource === '0') entry.root = BigInt(row.role_bitmap);
      else entry.grants.push(keyRoles(row));
    }
    const summaries = await this.summaries([...byResolver.keys()]); // role rows only exist for known resolvers
    return [...byResolver.entries()]
      .filter(([address]) => summaries.has(address))
      .map(([address, { root, grants }]) => ({
        ...summaries.get(address)!,
        ...decodeRoles(root),
        manages_records: canManage(root) || grants.some((g) => canManage(BigInt(g.role_bitmap))),
        key_grants: grants,
      }))
      .sort((a, b) => a.created_block - b.created_block || a.address.localeCompare(b.address));
  }
}

function keyRoles(r: { resource: string; role_bitmap: string; arg: string | null }): KeyRoles {
  const decoded = decodeRoles(BigInt(r.role_bitmap));
  const arg = (r.arg as Hex | null) ?? null;
  return { ...decoded, resource: hex32(r.resource), arg, ...(arg ? describeArgument(arg, decoded.roles) : {}) };
}
