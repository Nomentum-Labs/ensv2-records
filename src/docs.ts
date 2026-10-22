import type { Config } from './config.js';

/**
 * API docs, like enstate's: `/` redirects to `/docs`, a Scalar API reference rendered from
 * `/docs/openapi.json`. Scalar is pinned to an exact version with an SRI hash so the page can't
 * change or be tampered with under us.
 */
const SCALAR_URL = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.4/dist/browser/standalone.js';
const SCALAR_SRI = 'sha384-omTRdD9MbjA1vm12DqRUVvqJlr3VzSixvAdF1Jruu9AJOiJKyTKraIB6DyX+m10M';

export const docsHtml = (config: Config) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ensv2-records API (${config.chain})</title>
    <meta name="description" content="ENS name resolution for ENSv1, ENSv2 and offchain names. enstate-compatible." />
  </head>
  <body>
    <div id="app"></div>
    <script src="${SCALAR_URL}" integrity="${SCALAR_SRI}" crossorigin="anonymous"></script>
    <script>
      Scalar.createApiReference('#app', {
        url: '/docs/openapi.json',
        theme: 'blue',
        // keep the "Test Request" client; drop Scalar's hosted-product extras and telemetry
        showDeveloperTools: 'never',
        agent: { disabled: true },
        mcp: { disabled: true },
        telemetry: false,
      });
    </script>
  </body>
</html>
`;

const nameParam = (name: string, example?: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' },
  example,
});
const freshParam = {
  name: 'fresh',
  in: 'query',
  required: false,
  description: 'Skip the cache read and resolve from chain (the result is still cached).',
  schema: { type: 'boolean' },
};
const json = (ref: string, example?: unknown) => ({
  'application/json': { schema: { $ref: `#/components/schemas/${ref}` }, ...(example === undefined ? {} : { example }) },
});

// Example /v2/resolvers responses, from the Sepolia index (2026-10-22)
const ALL_ROLES = ['set_address', 'set_text', 'set_contenthash', 'set_abi', 'set_interface', 'set_name', 'set_data', 'link', 'can_name', 'upgrade'];
const EXAMPLE_RESOLVER = '0x72d374ff9f8600cd386e1fd4c853564836de45b1';
const resolverTimes = {
  created_block: 11908716,
  created_at: '2026-10-13T21:17:24.000Z',
  updated_block: 11970126,
  updated_at: '2026-10-22T14:26:36.000Z',
  record_count: 3,
};
const exampleGrants = [
  {
    roles: ['set_text'],
    admin_roles: [],
    role_bitmap: '0x10',
    resource: '0x1596dc38e2ac5a6ddc5e019af4adcc1e017a04f510d57e69d6879d5d2996bb8e',
    arg: '0x6465736372697074696f6e',
    key: 'description',
  },
  {
    roles: ['set_text'],
    admin_roles: [],
    role_bitmap: '0x10',
    resource: '0xb68b5f5089998f2978a1dcc681e8ef27962b90d5c26c4c0b9c1945814ffa5ef0',
    arg: '0x75726c',
    key: 'url',
  },
];
const sepoliaResolverExamples = {
  account: {
    account: '0xC9C3A4337a1bba75D0860A1A81f7B990dc607334',
    resolvers: [
      {
        address: EXAMPLE_RESOLVER,
        ...resolverTimes,
        roles: [],
        admin_roles: [],
        role_bitmap: '0x0',
        manages_records: true,
        key_grants: exampleGrants,
      },
    ],
  },
  resolver: {
    address: EXAMPLE_RESOLVER,
    ...resolverTimes,
    default_record_id: '3',
    unlinked_name_count: 5,
    accounts: [
      {
        account: '0xc983ebc9db969782d994627bdffec0ae6efee1b3',
        roles: ALL_ROLES,
        admin_roles: ALL_ROLES,
        role_bitmap: '0x1100000000000000000000001111111111000000000000000000000011111111',
      },
    ],
    key_grants: exampleGrants.map((g) => ({ account: '0xc9c3a4337a1bba75d0860a1a81f7b990dc607334', ...g })),
  },
  records: {
    resolver: EXAMPLE_RESOLVER,
    record_count: 3,
    default_record_id: '3',
    limit: 2,
    offset: 1,
    records: [
      {
        record_id: '2',
        is_default: false,
        names: ['$hila.eth'],
        name_count: 1,
        linked_name_count: 1,
        inherited_name_count: 0,
        records: [
          { kind: 'addr', key: '60', value: '0xc983ebc9db969782d994627bdffec0ae6efee1b3', encoding: 'bytes', decoded: '0xC983Ebc9dB969782D994627bdfFeC0ae6efee1b3' },
          { kind: 'text', key: 'description', value: 'test test', encoding: 'utf8' },
          { kind: 'text', key: 'status', value: 'Just testing', encoding: 'utf8' },
          { kind: 'text', key: 'url', value: 'https://grails.app', encoding: 'utf8' },
        ],
      },
      {
        record_id: '3',
        is_default: true,
        names: ['$khjkjnkjljoiu909.eth', '0000000000000000000000000000000000000000.eth', 'defaultname.eth', 'redesigned.eth', 'registration.eth'],
        name_count: 5,
        linked_name_count: 0,
        inherited_name_count: 5,
        records: [
          { kind: 'text', key: 'description', value: 'Just a default description', encoding: 'utf8' },
          { kind: 'text', key: 'location', value: 'Default resolver', encoding: 'utf8' },
          { kind: 'text', key: 'status', value: 'Being default', encoding: 'utf8' },
          { kind: 'text', key: 'url', value: 'https://grails.app', encoding: 'utf8' },
        ],
      },
    ],
  },
  names: {
    resolver: EXAMPLE_RESOLVER,
    record_id: '3',
    is_default: true,
    total: 2,
    limit: 100,
    offset: 0,
    names: [
      { name: 'redesigned.eth', linked: false },
      { name: 'registration.eth', linked: false },
    ],
  },
};
const errors = {
  '400': { description: 'Invalid name or address', content: json('Error') },
  '404': { description: 'Name has no resolver / address has no primary name', content: json('Error') },
  '502': { description: "The name's resolver or its offchain gateway failed", content: json('Error') },
};
const profileOk = { '200': { description: 'Profile', content: json('Profile') }, ...errors };
const bulkOk = {
  '200': { description: 'One entry per (deduplicated) input, in order', content: json('BulkResponse') },
  '400': { description: 'Too many inputs', content: json('Error') },
};
const bulkParam = (name: string, description: string, example: string[]) => ({
  name: `${name}[]`,
  in: 'query',
  required: true,
  description: `${description} Repeat the parameter; \`${name}=a,b\` also works.`,
  schema: { type: 'array', items: { type: 'string' } },
  style: 'form',
  explode: true,
  example,
});

export function openApiSpec(config: Config, hasIndex: boolean) {
  const examples =
    config.chain === 'sepolia'
      ? {
          name: 'yoginth.eth',
          address: '0x113A0ffeADa47e110Ad01098BEBA3403060978FB',
          names: ['yoginth.eth', 'palau.eth'],
          resolver: '0x72D374Ff9f8600cd386E1Fd4C853564836De45B1',
          account: '0xC9C3A4337a1bba75D0860A1A81f7B990dc607334',
        }
      : { name: 'vitalik.eth', address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', names: ['vitalik.eth', 'nick.eth'], resolver: undefined, account: undefined };
  const resolverExamples = config.chain === 'sepolia' ? sepoliaResolverExamples : undefined;
  const resolverParam = { ...nameParam('address', examples.resolver), description: 'PermissionedResolver address' };
  const indexErrors = {
    '400': { description: 'Invalid address or query parameter', content: json('Error') },
    '501': { description: 'No records index on this instance', content: json('Error') },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: `ensv2-records (${config.chain})`,
      version: '0.1.0',
      description: [
        'ENS name resolution for **ENSv1, ENSv2 and offchain (CCIP-read) names**, through the ENS UniversalResolver.',
        '',
        'Drop-in compatible with [enstate](https://github.com/v3xlabs/enstate): same routes, field names, bulk format and error bodies.',
        '',
        '- Primary names use ENSIP-19 reverse resolution, verified forward by the UniversalResolver.',
        '- Names are ENSIP-15 normalized.',
        '- Avatars and headers follow ENSIP-12; NFT avatars are checked against the name\'s ETH address.',
        '- Offchain names only return the core records, to stay under gateway rate limits.',
        hasIndex
          ? '- This instance has the ENSv2 records index: profiles include every text key set on the name, not just the default list.'
          : '- This instance has no records index; profiles include the default key list.',
        '',
        hasIndex
          ? 'The **Index** and **Resolvers** routes (`/v2/...`) read the records index directly: registry data for a name, PermissionedResolvers and who controls them, and their records.'
          : 'The **Index** and **Resolvers** routes (`/v2/...`) need the records index and return 501 on this instance.',
      ].join('\n'),
      license: { name: 'MIT' },
    },
    servers: [{ url: '/' }],
    security: [], // public, no auth
    tags: [
      { name: 'Profiles', description: 'Resolve names and addresses to profiles' },
      { name: 'Bulk', description: `Up to ${config.maxBulkSize} lookups per request` },
      { name: 'Images', description: 'Avatar and header redirects' },
      { name: 'Index', description: 'ENSv2 registry data for a name, from the records index' },
      {
        name: 'Resolvers',
        description: [
          'ENSv2 PermissionedResolvers, from the records index.',
          '',
          '- **Records** are numbered from 1 per resolver. A record is created by the first setter call for a name, and other names can be linked to an existing record (`linkToRecord` / `linkToNode`), so several names can share one record.',
          '- Names on the resolver that aren\'t linked to a record read the **default record** (`default_record_id`, the record linked to the root node). They count towards it as *inherited* names: names whose resolver is set to this one in the ENSv2 registry, registered and not expired, with no link of their own. Names in the ENSv1 registry that point at a PermissionedResolver can only be counted once they link to a record.',
          '- Each stored value has an `encoding`: `utf8` (text, name), `bytes` (addr, contenthash, data: raw hex as stored on chain), `address` (interface implementer) or `flag` (abi: only whether an ABI is set is indexed). Addresses and contenthashes also come with `decoded`: the address in the chain\'s own format, or a URI such as `ipfs://…`.',
          '- **Roles** come from EnhancedAccessControl. Roles on the root resource apply to every key; a *key grant* is limited to one text/data key, coin type, ABI content type or interface. `admin_roles` are the roles an account may grant and revoke.',
          '- Setters take the DNS-encoded name, e.g. `setText(name, key, value)`, not the namehash.',
          '',
          'Values can lag the chain by a few blocks; use `/n` for live record values.',
        ].join('\n'),
      },
      { name: 'Meta', description: 'Health and version' },
    ],
    paths: {
      '/n/{name}': {
        get: {
          operationId: 'getProfileByName',
          tags: ['Profiles'],
          summary: 'Profile by name',
          parameters: [nameParam('name', examples.name), freshParam],
          responses: profileOk,
        },
      },
      '/a/{address}': {
        get: {
          operationId: 'getProfileByAddress',
          tags: ['Profiles'],
          summary: "Profile of an address's primary name",
          parameters: [nameParam('address', examples.address), freshParam],
          responses: profileOk,
        },
      },
      '/u/{nameOrAddress}': {
        get: {
          operationId: 'getProfile',
          tags: ['Profiles'],
          summary: 'Profile by name or address',
          parameters: [nameParam('nameOrAddress', examples.name), freshParam],
          responses: profileOk,
        },
      },
      '/bulk/n': {
        get: {
          operationId: 'getProfilesByName', tags: ['Bulk'], summary: 'Profiles by name', parameters: [bulkParam('names', 'Names.', examples.names), freshParam], responses: bulkOk },
      },
      '/bulk/a': {
        get: {
          operationId: 'getProfilesByAddress',
          tags: ['Bulk'],
          summary: 'Profiles by address',
          parameters: [bulkParam('addresses', 'Addresses.', [examples.address]), freshParam],
          responses: bulkOk,
        },
      },
      '/bulk/u': {
        get: {
          operationId: 'getProfiles',
          tags: ['Bulk'],
          summary: 'Profiles by name or address',
          parameters: [bulkParam('queries', 'Names or addresses.', [examples.name, examples.address]), freshParam],
          responses: bulkOk,
        },
      },
      '/i/{nameOrAddress}': {
        get: {
          operationId: 'getAvatar',
          tags: ['Images'],
          summary: 'Avatar image',
          description: 'Redirects (303) to the resolved avatar URL. `data:` images are served inline.',
          parameters: [nameParam('nameOrAddress', examples.name), freshParam],
          responses: { '303': { description: 'Redirect to the image' }, '200': { description: 'Inline data: image' }, '415': { description: 'data: URI is not an image' }, ...errors },
        },
      },
      '/h/{nameOrAddress}': {
        get: {
          operationId: 'getHeader',
          tags: ['Images'],
          summary: 'Header image',
          description: 'Same as /i, for the `header` record.',
          parameters: [nameParam('nameOrAddress', examples.name), freshParam],
          responses: { '303': { description: 'Redirect to the image' }, '200': { description: 'Inline data: image' }, '415': { description: 'data: URI is not an image' }, ...errors },
        },
      },
      '/v2/n/{name}': {
        get: {
          operationId: 'getIndexedName',
          tags: ['Index'],
          summary: 'Indexed ENSv2 registry data for a name',
          description:
            'Registry, token id, status, expiry, resolver, subregistry and the records the indexer has stored. On a PermissionedResolver, `record_id` is the record the name reads; `linked_record_id` and `uses_default` tell an explicit link apart from inheriting the default record. Values can lag the chain slightly; use `/n` for live record values. Returns 501 when this instance has no index.',
          parameters: [nameParam('name', examples.name)],
          responses: {
            '200': { description: 'Indexed name', content: json('IndexedName') },
            '404': { description: 'Not an ENSv2 name known to the index', content: json('Error') },
            '501': { description: 'No records index on this instance', content: json('Error') },
          },
        },
      },
      '/v2/resolvers': {
        get: {
          operationId: 'getResolversByAccount',
          tags: ['Resolvers'],
          summary: 'PermissionedResolvers an account has roles on',
          description:
            'Every resolver where `account` holds any role: `roles` apply to every key, `key_grants` to a single key, coin type, content type or interface. A resolver can appear with only key grants (empty `roles`). `manages_records` is false when the only role is `can_name` (the deployer\'s namer). Oldest first.',
          parameters: [
            { name: 'account', in: 'query', required: true, description: 'Address to list resolvers for', schema: { type: 'string' }, example: examples.account },
          ],
          responses: { '200': { description: 'Resolvers', content: json('AccountResolvers', resolverExamples?.account) }, ...indexErrors },
        },
      },
      '/v2/resolvers/{address}': {
        get: {
          operationId: 'getResolver',
          tags: ['Resolvers'],
          summary: 'A PermissionedResolver and who controls it',
          description:
            'Record count, default record, when the resolver was created and last changed, how many names have no link of their own (`unlinked_name_count`, they read the default record), accounts with root roles, and roles limited to a single key, coin type, content type or interface.',
          parameters: [resolverParam],
          responses: {
            '200': { description: 'Resolver', content: json('Resolver', resolverExamples?.resolver) },
            '404': { description: 'Not a PermissionedResolver known to the index', content: json('Error') },
            ...indexErrors,
          },
        },
      },
      '/v2/resolvers/{address}/records': {
        get: {
          operationId: 'getResolverRecords',
          tags: ['Resolvers'],
          summary: 'Records on a PermissionedResolver',
          description:
            'Each record (ids 1 to `record_count`) with its stored values and the names using it: names linked to it, plus, for the default record, names inheriting it. `names` lists the first 100; page through all of them, or search, with `/records/{id}/names`. Values can lag the chain slightly; use `/n` for live values.',
          parameters: [
            resolverParam,
            { name: 'limit', in: 'query', required: false, description: 'Records per page', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
            { name: 'offset', in: 'query', required: false, description: 'Records to skip (page through ids 1 to `record_count`)', schema: { type: 'integer', minimum: 0, default: 0 } },
          ],
          responses: {
            '200': { description: 'Records', content: json('ResolverRecords', resolverExamples?.records) },
            '404': { description: 'Not a PermissionedResolver known to the index', content: json('Error') },
            ...indexErrors,
          },
        },
      },
      '/v2/resolvers/{address}/records/{id}/names': {
        get: {
          operationId: 'getRecordNames',
          tags: ['Resolvers'],
          summary: 'Names using a record',
          description:
            'Names linked to the record, plus, when it is the default record, names inheriting it (`linked: false`). Alphabetical; `total` counts every match. Use `q` to check whether a name uses this record.',
          parameters: [
            resolverParam,
            { name: 'id', in: 'path', required: true, description: 'Record id (1 to `record_count`)', schema: { type: 'string', pattern: '^[1-9][0-9]*$' }, example: resolverExamples ? '3' : undefined },
            { name: 'q', in: 'query', required: false, description: 'Case-insensitive substring of the name (up to 255 characters)', schema: { type: 'string' }, example: resolverExamples ? 're' : undefined },
            { name: 'limit', in: 'query', required: false, description: 'Names per page', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
            { name: 'offset', in: 'query', required: false, description: 'Names to skip', schema: { type: 'integer', minimum: 0, default: 0 } },
          ],
          responses: {
            '200': { description: 'Names', content: json('RecordNames', resolverExamples?.names) },
            '404': { description: 'Not a PermissionedResolver known to the index', content: json('Error') },
            ...indexErrors,
          },
        },
      },
      '/health': {
        get: {
          operationId: 'getHealth', tags: ['Meta'], summary: 'RPC and indexer health', responses: { '200': { description: 'Healthy', content: json('Health') }, '503': { description: 'RPC unreachable' } } },
      },
      '/this': {
        get: {
          operationId: 'getVersion', tags: ['Meta'], summary: 'Version info', responses: { '200': { description: 'Version', content: json('Meta') } } },
      },
    },
    components: {
      schemas: {
        Profile: {
          type: 'object',
          required: ['name', 'display', 'records', 'chains', 'fresh', 'resolver', 'errors'],
          properties: {
            name: { type: 'string', example: examples.name },
            address: { type: 'string', description: 'ETH address (EIP-55). Omitted when the name has none.' },
            avatar: { type: 'string', description: 'Resolved avatar URL (gateway URL for ipfs/ar, image URL for NFTs).' },
            header: { type: 'string', description: 'Resolved header URL.' },
            display: { type: 'string', description: 'The `display` record if it matches the name case-insensitively, else the name.' },
            contenthash: { type: 'string', description: 'ipfs://, ipns://, bzz://, ar:// …', example: 'ipfs://bafy…' },
            records: { type: 'object', additionalProperties: { type: 'string' }, description: 'Text records that are set.' },
            chains: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Addresses by chain (eth, btc, sol, base, optimism, arbitrum, …), in each chain\'s native format.',
            },
            fresh: { type: 'integer', description: 'When this profile was resolved (ms since epoch).' },
            resolver: { type: 'string', description: 'The resolver the UniversalResolver used.' },
            ccip_urls: { type: 'array', items: { type: 'string' }, description: 'Offchain gateways contacted. Omitted for on-chain names.' },
            errors: { type: 'object', additionalProperties: { type: 'string' }, description: 'Per-record failures, e.g. `records.x`, `chains.base`, `image.avatar`.' },
          },
        },
        BulkResponse: {
          type: 'object',
          required: ['response_length', 'response'],
          properties: {
            response_length: { type: 'integer' },
            response: {
              type: 'array',
              items: {
                oneOf: [
                  { allOf: [{ type: 'object', properties: { type: { const: 'success' } }, required: ['type'] }, { $ref: '#/components/schemas/Profile' }] },
                  {
                    type: 'object',
                    required: ['type', 'status', 'error'],
                    properties: { type: { const: 'error' }, status: { type: 'integer', example: 404 }, error: { type: 'string', example: 'Not Found' } },
                  },
                ],
              },
            },
          },
        },
        IndexedName: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            node: { type: 'string', description: 'namehash' },
            registry: { type: 'string', description: 'ENSv2 registry holding the label' },
            label: { type: ['string', 'null'] },
            labelhash: { type: ['string', 'null'] },
            token_id: { type: ['string', 'null'], description: 'Current ERC1155 token id (changes on regeneration)' },
            status: { type: 'string', enum: ['registered', 'reserved', 'unregistered'] },
            expiry: { type: ['integer', 'null'], description: 'Unix seconds' },
            resolver: { type: ['string', 'null'] },
            subregistry: { type: ['string', 'null'] },
            record_id: { type: ['string', 'null'], description: 'PermissionedResolver record the name reads: its own link, else the default record' },
            linked_record_id: { type: ['string', 'null'], description: 'Record the name is explicitly linked to (null = no link of its own)' },
            uses_default: { type: 'boolean', description: 'True when the name has no link of its own and reads the default record' },
            records: { type: 'array', items: { $ref: '#/components/schemas/RecordValue' } },
            updated_block: { type: 'integer' },
          },
        },
        RecordValue: {
          type: 'object',
          required: ['kind', 'key', 'value', 'encoding'],
          properties: {
            kind: { type: 'string', enum: ['text', 'addr', 'contenthash', 'data', 'name', 'abi', 'interface'] },
            key: { type: 'string', description: 'Text/data key, coin type, ABI content type or interface id (empty for contenthash and name)' },
            value: { type: 'string' },
            encoding: {
              type: 'string',
              enum: ['utf8', 'bytes', 'address', 'flag'],
              description: '`utf8`: text and name. `bytes`: addr, contenthash and data, raw hex as stored on chain. `address`: interface implementer. `flag`: abi, `1` means an ABI is set (the ABI itself is not indexed).',
            },
            decoded: { type: 'string', description: 'addr: the address in the chain\'s own format. contenthash: a URI such as ipfs://…. Omitted when it can\'t be decoded.' },
          },
        },
        ResolverSummary: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            created_block: { type: 'integer' },
            created_at: { type: ['string', 'null'], format: 'date-time', description: 'Null until the block time has been looked up' },
            updated_block: { type: 'integer', description: 'Last block with a record, link, role or key-grant change' },
            updated_at: { type: ['string', 'null'], format: 'date-time' },
            record_count: { type: 'integer' },
          },
        },
        KeyGrant: {
          allOf: [
            {
              type: 'object',
              properties: {
                resource: { type: 'string', description: 'keccak256 of the setter argument' },
                arg: { type: ['string', 'null'], description: 'Raw setter argument (hex)' },
                key: { type: 'string', description: 'For set_text / set_data grants' },
                coin_type: { type: 'string', description: 'For set_address grants' },
                content_type: { type: 'string', description: 'For set_abi grants' },
                interface_id: { type: 'string', description: 'For set_interface grants' },
              },
            },
            { $ref: '#/components/schemas/Roles' },
          ],
        },
        RecordNames: {
          type: 'object',
          properties: {
            resolver: { type: 'string' },
            record_id: { type: 'string' },
            is_default: { type: 'boolean' },
            total: { type: 'integer', description: 'Names matching q (all names without q)' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
            names: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, linked: { type: 'boolean', description: 'False when the name inherits the default record' } },
              },
            },
          },
        },
        Roles: {
          type: 'object',
          properties: {
            roles: { type: 'array', items: { $ref: '#/components/schemas/RoleName' } },
            admin_roles: { type: 'array', items: { $ref: '#/components/schemas/RoleName' }, description: 'Roles this account may grant and revoke' },
            role_bitmap: { type: 'string', description: 'Raw EnhancedAccessControl bitmap (hex)' },
          },
        },
        RoleName: {
          type: 'string',
          enum: ['set_address', 'set_text', 'set_contenthash', 'set_abi', 'set_interface', 'set_name', 'set_data', 'link', 'can_name', 'upgrade'],
        },
        AccountResolvers: {
          type: 'object',
          properties: {
            account: { type: 'string' },
            resolvers: {
              type: 'array',
              items: {
                allOf: [
                  { $ref: '#/components/schemas/ResolverSummary' },
                  { $ref: '#/components/schemas/Roles' },
                  {
                    type: 'object',
                    properties: {
                      manages_records: { type: 'boolean', description: 'Holds a role that can change records or links (not only can_name)' },
                      key_grants: { type: 'array', items: { $ref: '#/components/schemas/KeyGrant' } },
                    },
                  },
                ],
              },
            },
          },
        },
        Resolver: {
          allOf: [
            { $ref: '#/components/schemas/ResolverSummary' },
            {
              type: 'object',
              properties: {
                default_record_id: { type: ['string', 'null'] },
                unlinked_name_count: { type: 'integer', description: 'Names on this resolver with no link of their own; they read the default record if there is one' },
                accounts: {
                  type: 'array',
                  items: { allOf: [{ type: 'object', properties: { account: { type: 'string' } } }, { $ref: '#/components/schemas/Roles' }] },
                },
                key_grants: {
                  type: 'array',
                  items: { allOf: [{ type: 'object', properties: { account: { type: 'string' } } }, { $ref: '#/components/schemas/KeyGrant' }] },
                },
              },
            },
          ],
        },
        ResolverRecords: {
          type: 'object',
          properties: {
            resolver: { type: 'string' },
            record_count: { type: 'integer' },
            default_record_id: { type: ['string', 'null'], description: 'Record read by names without a link' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
            records: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  record_id: { type: 'string' },
                  is_default: { type: 'boolean' },
                  names: { type: 'array', items: { type: 'string' }, description: 'Names using the record (first 100, alphabetical)' },
                  name_count: { type: 'integer', description: 'linked_name_count + inherited_name_count' },
                  linked_name_count: { type: 'integer', description: 'Names explicitly linked to the record' },
                  inherited_name_count: { type: 'integer', description: 'Default record only: names with no link of their own' },
                  records: { type: 'array', items: { $ref: '#/components/schemas/RecordValue' } },
                },
              },
            },
          },
        },
        Health: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            chain: { type: 'string' },
            block: { type: 'integer' },
            indexer: {
              type: 'object',
              properties: { last_block: { type: ['integer', 'null'] }, updated_at: { type: ['string', 'null'] }, lag: { type: ['integer', 'null'] } },
            },
          },
        },
        Meta: {
          type: 'object',
          properties: { name: { type: 'string' }, version: { type: 'string' }, rev: { type: 'string' }, chain: { type: 'string' } },
        },
        Error: {
          type: 'object',
          required: ['status', 'error'],
          properties: { status: { type: 'integer' }, error: { type: 'string' } },
        },
      },
    },
  };
}
