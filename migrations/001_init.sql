-- ensv2-records indexer schema.
-- Addresses are lowercase hex. uint256 ids (token ids, label keys, nodes) are 0x-prefixed 64-char hex.

CREATE TABLE indexer_state (
  chain        TEXT PRIMARY KEY,
  last_block   BIGINT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every label seen in any contract that emits ENSv2 registry events. Only labels in registries
-- reachable from the root registry get a name/node (see registry_paths).
CREATE TABLE registry_labels (
  registry       TEXT NOT NULL,
  label_key      TEXT NOT NULL,            -- token id with the 32 version bits zeroed (stable across regenerations)
  label          TEXT,                     -- plaintext label from LabelRegistered/LabelReserved
  labelhash      TEXT,
  token_id       TEXT,                     -- current ERC1155 token id
  status         TEXT NOT NULL DEFAULT 'registered',  -- registered | reserved | unregistered
  expiry         NUMERIC(20, 0),           -- unix seconds (uint64; max value = never expires)
  resolver       TEXT,
  subregistry    TEXT,
  name           TEXT,                     -- full name, when the registry is reachable from the root
  node           TEXT,                     -- namehash(name)
  first_block    BIGINT NOT NULL,
  updated_block  BIGINT NOT NULL,
  PRIMARY KEY (registry, label_key)
);
CREATE INDEX registry_labels_node_idx ON registry_labels (node);
CREATE INDEX registry_labels_name_idx ON registry_labels (name text_pattern_ops);
CREATE INDEX registry_labels_resolver_idx ON registry_labels (resolver);
CREATE INDEX registry_labels_subregistry_idx ON registry_labels (subregistry) WHERE subregistry IS NOT NULL;

-- Name of each registry reachable from the root. The root itself has name '' and node 0x00…00.
CREATE TABLE registry_paths (
  registry          TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  node              TEXT NOT NULL,
  parent            TEXT,
  parent_label_key  TEXT,
  updated_block     BIGINT NOT NULL
);
CREATE INDEX registry_paths_parent_idx ON registry_paths (parent, parent_label_key);

-- PermissionedResolver: which record each name reads (Linked events). record_id 0 = unlinked.
-- A name with no link (or record 0) falls back to the default record, linked to node 0x00…00.
CREATE TABLE resolver_links (
  resolver   TEXT NOT NULL,
  node       TEXT NOT NULL,
  record_id  NUMERIC(78, 0) NOT NULL,
  name       TEXT,
  block      BIGINT NOT NULL,
  PRIMARY KEY (resolver, node)
);
CREATE INDEX resolver_links_record_idx ON resolver_links (resolver, record_id);

-- Record values. scope is 'r:<recordId>' for PermissionedResolver records and 'n:<node>' for
-- node-keyed resolvers (PublicResolverV2 and v1-style resolvers).
-- kind: text | addr | contenthash | data | name | abi | interface. key: text/data key, coin type,
-- ABI content type or interface id ('' for contenthash/name). value NULL = cleared.
CREATE TABLE resolver_records (
  resolver   TEXT NOT NULL,
  scope      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT,
  block      BIGINT NOT NULL,
  log_index  INT NOT NULL,
  PRIMARY KEY (resolver, scope, kind, key)
);
CREATE INDEX resolver_records_scope_idx ON resolver_records (scope, kind);

-- addr.reverse nodes claimed through the v1 ReverseRegistrar, to map NameChanged(node) to an address.
CREATE TABLE reverse_nodes (
  node     TEXT PRIMARY KEY,
  address  TEXT NOT NULL,
  block    BIGINT NOT NULL
);
