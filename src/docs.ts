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

const nameParam = (name: string, example: string) => ({
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
const json = (ref: string) => ({ 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } });
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
      ? { name: 'yoginth.eth', address: '0x113A0ffeADa47e110Ad01098BEBA3403060978FB', names: ['yoginth.eth', 'palau.eth'] }
      : { name: 'vitalik.eth', address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', names: ['vitalik.eth', 'nick.eth'] };

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
      ].join('\n'),
      license: { name: 'MIT' },
    },
    servers: [{ url: '/' }],
    security: [], // public, no auth
    tags: [
      { name: 'Profiles', description: 'Resolve names and addresses to profiles' },
      { name: 'Bulk', description: `Up to ${config.maxBulkSize} lookups per request` },
      { name: 'Images', description: 'Avatar and header redirects' },
      { name: 'Index', description: 'ENSv2 registry and resolver data from the records index' },
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
            'Registry, token id, status, expiry, resolver, subregistry and the records the indexer has stored. Values can lag the chain slightly; use `/n` for live record values. Returns 501 when this instance has no index.',
          parameters: [nameParam('name', examples.name)],
          responses: {
            '200': { description: 'Indexed name', content: json('IndexedName') },
            '404': { description: 'Not an ENSv2 name known to the index', content: json('Error') },
            '501': { description: 'No records index on this instance', content: json('Error') },
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
            record_id: { type: ['string', 'null'], description: 'PermissionedResolver record the name reads' },
            records: {
              type: 'array',
              items: { type: 'object', properties: { kind: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' } } },
            },
            updated_block: { type: 'integer' },
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
