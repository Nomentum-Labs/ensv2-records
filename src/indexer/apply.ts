import { concat, keccak256, pad, toHex, zeroAddress, zeroHash, type Hex } from 'viem';
import type { Tx } from '../db/pool.js';

/** A decoded log, already sorted by (block, logIndex). */
export type DecodedLog = {
  address: string; // lowercase emitter
  block: number;
  logIndex: number;
  eventName: string;
  args: Record<string, unknown>;
};

/** What changed in a batch, so the API cache can drop stale profiles. */
export type Invalidations = { names: Set<string>; addresses: Set<string> };

const VERSION_MASK = (1n << 32n) - 1n;
const hex32 = (v: bigint) => pad(toHex(v), { size: 32 }).toLowerCase();
/** Token ids carry a 32-bit version in the low bits; zeroing it gives the stable per-label key. */
export const labelKeyOf = (tokenId: bigint) => hex32(tokenId & ~VERSION_MASK);
const lc = (a: unknown) => String(a).toLowerCase();
const nullIfZeroAddr = (a: unknown) => (a && lc(a) !== zeroAddress ? lc(a) : null);
const childNode = (parentNode: string, labelhash: string) => keccak256(concat([parentNode as Hex, labelhash as Hex]));
const childName = (label: string, parentName: string) => (parentName ? `${label}.${parentName}` : label);

/** DNS wire format → dotted name (labels are length-prefixed; terminated by a zero byte). */
export function dnsDecode(hex: Hex): string {
  const b = Buffer.from(hex.slice(2), 'hex');
  const labels: string[] = [];
  for (let i = 0; i < b.length && b[i]; i += b[i]! + 1) labels.push(b.subarray(i + 1, i + 1 + b[i]!).toString('utf8'));
  return labels.join('.');
}

type Path = { name: string; node: string; parent: string | null; parentKey: string | null };
export type Paths = { root: string; byRegistry: Map<string, Path> };

/**
 * Applies decoded logs to the tables inside one transaction. Registry paths (the name of each
 * registry reachable from the root) are cached in memory; the cache is rebuilt on startup and
 * after a failed batch.
 *
 * Path rules: a registry keeps the first path it was reached through for as long as that parent
 * label still points at it; a registry can never sit under itself (ETHRegistry on Sepolia has
 * labels whose subregistry is ETHRegistry); when its parent link goes away it is re-attached
 * through another reachable parent if one exists.
 */
export class Applier {
  readonly inv: Invalidations = { names: new Set(), addresses: new Set() };
  /** Highest block per emitter for PermissionedResolver events, written by flushActivity. */
  private readonly activity = new Map<string, number>();

  constructor(
    private readonly tx: Tx,
    private readonly paths: Paths,
  ) {}

  static async loadPaths(tx: Tx | { query: Tx['query'] }, rootRegistry: string): Promise<Paths> {
    const rows = (
      await tx.query<{ registry: string; name: string; node: string; parent: string | null; parent_label_key: string | null }>(
        'SELECT registry, name, node, parent, parent_label_key FROM registry_paths',
      )
    ).rows;
    const root = rootRegistry.toLowerCase();
    const byRegistry = new Map(rows.map((r) => [r.registry, { name: r.name, node: r.node, parent: r.parent, parentKey: r.parent_label_key }]));
    byRegistry.set(root, { name: '', node: zeroHash, parent: null, parentKey: null });
    return { root, byRegistry };
  }

  /** True if `registry` is `start` or one of its ancestors. */
  private isAncestorOrSelf(registry: string, start: string): boolean {
    for (let r: string | null = start, hops = 0; r && hops < 256; hops++) {
      if (r === registry) return true;
      r = this.paths.byRegistry.get(r)?.parent ?? null;
    }
    return false;
  }

  async apply(log: DecodedLog): Promise<void> {
    const a = log.args;
    if (RESOLVER_ACTIVITY.has(log.eventName)) this.touch(log);
    switch (log.eventName) {
      case 'LabelRegistered':
      case 'LabelReserved':
        return this.labelRegistered(log, a.tokenId as bigint, a.labelHash as string, a.label as string, a.expiry as bigint, log.eventName === 'LabelReserved');
      case 'LabelUnregistered':
        return this.updateLabel(log, a.tokenId as bigint, `status = 'unregistered'`);
      case 'ExpiryUpdated':
        return this.updateLabel(log, a.tokenId as bigint, 'expiry = $4', [String(a.newExpiry)]);
      case 'TokenRegenerated':
        return this.updateLabel(log, a.newTokenId as bigint, 'token_id = $4', [hex32(a.newTokenId as bigint)]);
      case 'ResolverUpdated':
        return this.updateLabel(log, a.tokenId as bigint, 'resolver = $4', [nullIfZeroAddr(a.resolver)]);
      case 'SubregistryUpdated':
        return this.subregistryUpdated(log, a.tokenId as bigint, nullIfZeroAddr(a.subregistry));

      case 'Linked':
        await this.bumpRecordCount(log.address, a.recordId as bigint);
        return this.linked(log, a.recordId as bigint, lc(a.node), a.name as Hex);
      case 'Cleared':
        // every value of the record is gone (not emitted by the post-audit-2 PermissionedResolver,
        // but part of IRecordResolver)
        await this.tx.query('DELETE FROM resolver_records WHERE resolver = $1 AND scope = $2', [log.address, `r:${a.recordId}`]);
        return this.invalidateScope(log.address, `r:${a.recordId}`);
      case 'ResolverCreated':
      case 'EACRolesChanged':
      case 'ResourceArgument':
        return this.applyResolverEvent(log);
      case 'TextUpdated':
        return this.record(log, `r:${a.recordId}`, 'text', a.key as string, (a.value as string) || null);
      case 'AddressUpdated':
        return this.record(log, `r:${a.recordId}`, 'addr', String(a.coinType), emptyBytesToNull(a.addressBytes));
      case 'ContenthashUpdated':
        return this.record(log, `r:${a.recordId}`, 'contenthash', '', emptyBytesToNull(a.hash));
      case 'DataUpdated':
        return this.record(log, `r:${a.recordId}`, 'data', a.key as string, emptyBytesToNull(a.value));
      case 'NameUpdated':
        return this.record(log, `r:${a.recordId}`, 'name', '', (a.primaryName as string) || null);
      case 'ABIUpdated':
        return this.record(log, `r:${a.recordId}`, 'abi', String(a.contentType), '1');
      case 'InterfaceUpdated':
        return this.record(log, `r:${a.recordId}`, 'interface', lc(a.interfaceId), nullIfZeroAddr(a.implementer));

      case 'TextChanged':
        return this.record(log, `n:${lc(a.node)}`, 'text', a.key as string, (a.value as string) || null);
      case 'AddrChanged':
        return this.record(log, `n:${lc(a.node)}`, 'addr', '60', nullIfZeroAddr(a.a));
      case 'AddressChanged':
        return this.record(log, `n:${lc(a.node)}`, 'addr', String(a.coinType), emptyBytesToNull(a.newAddress));
      case 'ContenthashChanged':
        return this.record(log, `n:${lc(a.node)}`, 'contenthash', '', emptyBytesToNull(a.hash));
      case 'NameChanged':
        await this.reverseNameChanged(lc(a.node));
        return this.record(log, `n:${lc(a.node)}`, 'name', '', (a.name as string) || null);
      case 'VersionChanged':
        // v1 resolvers clear every record of the node when its version is bumped
        await this.tx.query('DELETE FROM resolver_records WHERE resolver = $1 AND scope = $2', [log.address, `n:${lc(a.node)}`]);
        return this.invalidateScope(log.address, `n:${lc(a.node)}`);

      case 'ReverseClaimed':
        this.inv.addresses.add(lc(a.addr));
        await this.tx.query(
          'INSERT INTO reverse_nodes (node, address, block) VALUES ($1, $2, $3) ON CONFLICT (node) DO UPDATE SET address = EXCLUDED.address, block = EXCLUDED.block',
          [lc(a.node), lc(a.addr), log.block],
        );
        return;
      case 'NameForAddrChanged':
        this.inv.addresses.add(lc(a.addr));
        return;
    }
  }

  // ---- registries ----

  private async labelRegistered(log: DecodedLog, tokenId: bigint, labelhash: string, label: string, expiry: bigint, reserved: boolean) {
    const key = labelKeyOf(tokenId);
    const path = this.paths.byRegistry.get(log.address);
    const name = path ? childName(label, path.name) : null;
    const node = path ? childNode(path.node, labelhash) : null;
    // (Re-)registration resets resolver and subregistry; non-zero values follow as their own events.
    const prev = await this.tx.query<{ subregistry: string | null }>(
      'SELECT subregistry FROM registry_labels WHERE registry = $1 AND label_key = $2',
      [log.address, key],
    );
    await this.tx.query(
      `INSERT INTO registry_labels (registry, label_key, label, labelhash, token_id, status, expiry, resolver, subregistry, name, node, first_block, updated_block)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8, $9, $10, $10)
       ON CONFLICT (registry, label_key) DO UPDATE SET
         label = EXCLUDED.label, labelhash = EXCLUDED.labelhash, token_id = EXCLUDED.token_id, status = EXCLUDED.status,
         expiry = EXCLUDED.expiry, resolver = NULL, subregistry = NULL, name = EXCLUDED.name, node = EXCLUDED.node,
         updated_block = EXCLUDED.updated_block`,
      [log.address, key, label, lc(labelhash), hex32(tokenId), reserved ? 'reserved' : 'registered', expiry.toString(), name, node, log.block],
    );
    const oldSub = prev.rows[0]?.subregistry;
    if (oldSub) await this.detachRegistry(oldSub, log.address, key, log.block);
    if (name) this.inv.names.add(name);
  }

  /** Updates one column of an existing label (no-op for labels we never saw registered). */
  private async updateLabel(log: DecodedLog, tokenId: bigint, set: string, extra: unknown[] = []) {
    const res = await this.tx.query<{ name: string | null }>(
      `UPDATE registry_labels SET ${set}, updated_block = $3 WHERE registry = $1 AND label_key = $2 RETURNING name`,
      [log.address, labelKeyOf(tokenId), log.block, ...extra],
    );
    const name = res.rows[0]?.name;
    if (name) this.inv.names.add(name);
  }

  private async subregistryUpdated(log: DecodedLog, tokenId: bigint, subregistry: string | null) {
    const key = labelKeyOf(tokenId);
    const prev = await this.tx.query<{ subregistry: string | null; name: string | null; node: string | null }>(
      'SELECT subregistry, name, node FROM registry_labels WHERE registry = $1 AND label_key = $2',
      [log.address, key],
    );
    const row = prev.rows[0];
    if (!row) return;
    await this.tx.query('UPDATE registry_labels SET subregistry = $3, updated_block = $4 WHERE registry = $1 AND label_key = $2', [
      log.address,
      key,
      subregistry,
      log.block,
    ]);
    if (row.name) this.inv.names.add(row.name);
    if (row.subregistry && row.subregistry !== subregistry) await this.detachRegistry(row.subregistry, log.address, key, log.block);
    if (subregistry && row.name !== null && row.node !== null) {
      await this.attachRegistry(subregistry, { name: row.name, node: row.node, parent: log.address, parentKey: key }, log.block);
    }
  }

  /** Gives `registry` a path (unless it already has one through another live parent) and names every label under it. */
  private async attachRegistry(registry: string, path: Path, block: number) {
    if (registry === this.paths.root || this.isAncestorOrSelf(registry, path.parent!)) return;
    const existing = this.paths.byRegistry.get(registry);
    if (existing && (existing.parent !== path.parent || existing.parentKey !== path.parentKey)) return; // first path wins
    if (existing && existing.name === path.name && existing.node === path.node) return; // unchanged
    this.paths.byRegistry.set(registry, path);
    await this.tx.query(
      `INSERT INTO registry_paths (registry, name, node, parent, parent_label_key, updated_block) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (registry) DO UPDATE SET name = EXCLUDED.name, node = EXCLUDED.node, parent = EXCLUDED.parent,
         parent_label_key = EXCLUDED.parent_label_key, updated_block = EXCLUDED.updated_block`,
      [registry, path.name, path.node, path.parent, path.parentKey, block],
    );
    const labels = await this.tx.query<{ label_key: string; label: string | null; labelhash: string | null; subregistry: string | null }>(
      'SELECT label_key, label, labelhash, subregistry FROM registry_labels WHERE registry = $1',
      [registry],
    );
    const keys: string[] = [];
    const names: (string | null)[] = [];
    const nodes: (string | null)[] = [];
    for (const l of labels.rows) {
      keys.push(l.label_key);
      names.push(l.label !== null ? childName(l.label, path.name) : null);
      nodes.push(l.labelhash ? childNode(path.node, l.labelhash) : null);
    }
    if (keys.length) {
      await this.tx.query(
        `UPDATE registry_labels r SET name = v.name, node = v.node
         FROM unnest($2::text[], $3::text[], $4::text[]) AS v(label_key, name, node)
         WHERE r.registry = $1 AND r.label_key = v.label_key`,
        [registry, keys, names, nodes],
      );
    }
    for (const [i, l] of labels.rows.entries()) {
      if (names[i]) this.inv.names.add(names[i]!);
      if (l.subregistry && names[i] && nodes[i]) {
        await this.attachRegistry(l.subregistry, { name: names[i]!, node: nodes[i]!, parent: registry, parentKey: l.label_key }, block);
      }
    }
  }

  /** Removes the path of `registry` (and its subtree) if it was reached through (parent, parentKey), then looks for another parent. */
  private async detachRegistry(registry: string, parent: string, parentKey: string, block: number) {
    const existing = this.paths.byRegistry.get(registry);
    if (registry === this.paths.root || !existing || existing.parent !== parent || existing.parentKey !== parentKey) return;
    this.paths.byRegistry.delete(registry);
    await this.tx.query('DELETE FROM registry_paths WHERE registry = $1', [registry]);
    const labels = await this.tx.query<{ label_key: string; name: string | null; subregistry: string | null }>(
      'SELECT label_key, name, subregistry FROM registry_labels WHERE registry = $1',
      [registry],
    );
    await this.tx.query('UPDATE registry_labels SET name = NULL, node = NULL, updated_block = $2 WHERE registry = $1', [registry, block]);
    for (const l of labels.rows) {
      if (l.name) this.inv.names.add(l.name);
      if (l.subregistry) await this.detachRegistry(l.subregistry, registry, l.label_key, block);
    }
    // another reachable label may still point here
    const alt = await this.tx.query<{ registry: string; label_key: string; name: string; node: string }>(
      `SELECT registry, label_key, name, node FROM registry_labels
       WHERE subregistry = $1 AND name IS NOT NULL AND node IS NOT NULL ORDER BY updated_block, registry, label_key`,
      [registry],
    );
    for (const a of alt.rows) {
      if (!this.paths.byRegistry.has(a.registry)) continue;
      await this.attachRegistry(registry, { name: a.name, node: a.node, parent: a.registry, parentKey: a.label_key }, block);
      if (this.paths.byRegistry.has(registry)) break;
    }
  }

  // ---- resolvers ----

  /**
   * For the one-time backfill of resolver events (see Indexer.backfillResolvers): applies
   * ResolverCreated, EACRolesChanged and ResourceArgument, and uses Linked only to rebuild
   * record counts. Every write here is safe to apply out of order or twice.
   */
  async applyResolverBackfill(log: DecodedLog): Promise<void> {
    this.touch(log);
    if (log.eventName === 'Linked') return this.bumpRecordCount(log.address, log.args.recordId as bigint);
    return this.applyResolverEvent(log);
  }

  private async applyResolverEvent(log: DecodedLog): Promise<void> {
    const a = log.args;
    switch (log.eventName) {
      case 'ResolverCreated':
        await this.tx.query(
          `INSERT INTO resolvers (address, created_block) VALUES ($1, $2)
           ON CONFLICT (address) DO UPDATE SET created_block = LEAST(resolvers.created_block, EXCLUDED.created_block)`,
          [log.address, log.block],
        );
        return;
      case 'EACRolesChanged':
        if (!(await this.isResolver(log.address))) return; // registries use the same access control
        await this.tx.query(
          `INSERT INTO resolver_roles (resolver, resource, account, role_bitmap, block, log_index) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (resolver, resource, account) DO UPDATE SET
             role_bitmap = EXCLUDED.role_bitmap, block = EXCLUDED.block, log_index = EXCLUDED.log_index
           WHERE (resolver_roles.block, resolver_roles.log_index) < (EXCLUDED.block, EXCLUDED.log_index)`,
          [log.address, String(a.resource), lc(a.account), String(a.newRoleBitmap), log.block, log.logIndex],
        );
        return;
      case 'ResourceArgument':
        if (!(await this.isResolver(log.address))) return;
        await this.tx.query(
          'INSERT INTO resolver_resource_args (resolver, resource, arg) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [log.address, String(a.resource), lc(a.arg)],
        );
        return;
    }
  }

  private touch(log: DecodedLog) {
    if ((this.activity.get(log.address) ?? -1) < log.block) this.activity.set(log.address, log.block);
  }

  /**
   * Raises resolvers.updated_block for the PermissionedResolvers that had events in this batch
   * (other emitters have no resolvers row and are skipped). Call once per batch, after the logs.
   * Returns the blocks the touched resolvers now point at, for block_times.
   */
  async flushActivity(): Promise<number[]> {
    if (!this.activity.size) return [];
    const r = await this.tx.query<{ created_block: string; updated_block: string }>(
      `UPDATE resolvers v SET updated_block = GREATEST(v.updated_block, v.created_block, t.block)
       FROM unnest($1::text[], $2::bigint[]) AS t(address, block)
       WHERE v.address = t.address
       RETURNING v.created_block, v.updated_block`,
      [[...this.activity.keys()], [...this.activity.values()]],
    );
    this.activity.clear();
    return [...new Set(r.rows.flatMap((row) => [Number(row.created_block), Number(row.updated_block)]))];
  }

  private async isResolver(address: string): Promise<boolean> {
    return (await this.tx.query('SELECT 1 FROM resolvers WHERE address = $1', [address])).rows.length > 0;
  }

  /** Record ids are handed out in order and every new record is announced with Linked. */
  private async bumpRecordCount(resolver: string, recordId: bigint) {
    if (recordId === 0n) return;
    await this.tx.query('UPDATE resolvers SET record_count = GREATEST(record_count, $2::numeric) WHERE address = $1', [
      resolver,
      recordId.toString(),
    ]);
  }

  private async linked(log: DecodedLog, recordId: bigint, node: string, nameBytes: Hex) {
    const name = safeDnsDecode(nameBytes);
    await this.tx.query(
      `INSERT INTO resolver_links (resolver, node, record_id, name, block) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (resolver, node) DO UPDATE SET record_id = EXCLUDED.record_id, name = EXCLUDED.name, block = EXCLUDED.block`,
      [log.address, node, recordId.toString(), name, log.block],
    );
    if (name) this.inv.names.add(name);
  }

  private async record(log: DecodedLog, scope: string, kind: string, key: string, value: string | null) {
    await this.tx.query(
      `INSERT INTO resolver_records (resolver, scope, kind, key, value, block, log_index) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (resolver, scope, kind, key) DO UPDATE SET value = EXCLUDED.value, block = EXCLUDED.block, log_index = EXCLUDED.log_index`,
      [log.address, scope, kind, key, value, log.block, log.logIndex],
    );
    await this.invalidateScope(log.address, scope);
  }

  /** Names whose cached profile depends on (resolver, scope). */
  private async invalidateScope(resolver: string, scope: string) {
    if (scope.startsWith('r:')) {
      const rows = await this.tx.query<{ name: string | null }>(
        'SELECT name FROM resolver_links WHERE resolver = $1 AND record_id = $2',
        [resolver, scope.slice(2)],
      );
      for (const r of rows.rows) if (r.name) this.inv.names.add(r.name);
    } else {
      const node = scope.slice(2);
      const rows = await this.tx.query<{ name: string | null }>(
        'SELECT name FROM registry_labels WHERE node = $1 UNION SELECT name FROM resolver_links WHERE node = $1',
        [node],
      );
      for (const r of rows.rows) if (r.name) this.inv.names.add(r.name);
    }
  }

  private async reverseNameChanged(node: string) {
    const r = await this.tx.query<{ address: string }>('SELECT address FROM reverse_nodes WHERE node = $1', [node]);
    if (r.rows[0]) this.inv.addresses.add(r.rows[0].address);
  }
}

/** PermissionedResolver events that count as a change to the resolver (resolvers.updated_block). */
const RESOLVER_ACTIVITY = new Set([
  'ResolverCreated',
  'EACRolesChanged',
  'ResourceArgument',
  'Linked',
  'Cleared',
  'TextUpdated',
  'AddressUpdated',
  'ContenthashUpdated',
  'DataUpdated',
  'NameUpdated',
  'ABIUpdated',
  'InterfaceUpdated',
]);

const emptyBytesToNull = (v: unknown) => (typeof v === 'string' && v !== '0x' ? v.toLowerCase() : null);

function safeDnsDecode(hex: Hex): string | null {
  try {
    return dnsDecode(hex) || null;
  } catch {
    return null;
  }
}
