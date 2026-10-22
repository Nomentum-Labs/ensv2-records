-- When each PermissionedResolver last changed, and block timestamps for the /v2/resolvers routes.
-- Purely additive; existing rows get updated_block from the tables they already have when the
-- indexer starts (see Indexer.refreshResolverActivity).

-- Highest block with an event on the resolver: records, links, roles or key grants.
ALTER TABLE resolvers ADD COLUMN updated_block BIGINT NOT NULL DEFAULT 0;

-- Timestamps of the blocks that resolvers.created_block / updated_block point at.
CREATE TABLE block_times (
  block      BIGINT PRIMARY KEY,
  timestamp  BIGINT NOT NULL
);
