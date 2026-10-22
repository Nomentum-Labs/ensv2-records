-- PermissionedResolvers and who controls them, for the /v2/resolvers routes.
-- Existing indexes pick up the new events through a one-time backfill in the indexer
-- (see Indexer.backfillResolvers), so nothing here touches the existing tables.

-- Every contract that emitted ResolverCreated() (PermissionedResolver proxies and implementations).
-- record_count = highest record id seen in a Linked event (records are numbered from 1 and
-- every new record is announced with Linked).
CREATE TABLE resolvers (
  address        TEXT PRIMARY KEY,
  created_block  BIGINT NOT NULL,
  record_count   NUMERIC(78, 0) NOT NULL DEFAULT 0
);

-- EnhancedAccessControl roles per (resolver, resource, account), from EACRolesChanged.
-- resource 0 is the root resource (roles apply to every key); other resources are
-- keccak256(setter argument), e.g. a single text key. role_bitmap 0 = all roles revoked.
-- (block, log_index) is the event the row came from; older events never overwrite newer ones,
-- so the live indexer and the backfill can apply events in any order.
CREATE TABLE resolver_roles (
  resolver     TEXT NOT NULL,
  resource     NUMERIC(78, 0) NOT NULL,
  account      TEXT NOT NULL,
  role_bitmap  NUMERIC(78, 0) NOT NULL,
  block        BIGINT NOT NULL,
  log_index    INT NOT NULL,
  PRIMARY KEY (resolver, resource, account)
);
CREATE INDEX resolver_roles_account_idx ON resolver_roles (account, resource);

-- Setter argument behind each non-root resource (ResourceArgument): the key bytes for text/data,
-- a 32-byte coin type / content type, or a 4-byte interface id.
CREATE TABLE resolver_resource_args (
  resolver  TEXT NOT NULL,
  resource  NUMERIC(78, 0) NOT NULL,
  arg       TEXT NOT NULL,
  PRIMARY KEY (resolver, resource)
);

-- Progress of one-time backfills of events added after an index was built.
CREATE TABLE backfill_state (
  chain         TEXT NOT NULL,
  name          TEXT NOT NULL,
  next_block    BIGINT NOT NULL,
  target_block  BIGINT NOT NULL,
  PRIMARY KEY (chain, name)
);
