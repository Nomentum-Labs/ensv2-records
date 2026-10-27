import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, parseAbi, stringToHex, type Hex } from 'viem';
import { dnsDecode, pgSafeArgs, pgSafeText } from '../../src/indexer/apply.js';

describe('pgSafeText', () => {
  it('replaces NUL (Postgres text rejects it) and leaves other strings alone', () => {
    assert.equal(pgSafeText('abc\u0000'), 'abc�');
    assert.equal(pgSafeText('a\u0000b\u0000'), 'a�b�');
    assert.equal(pgSafeText('plain ✓'), 'plain ✓');
  });

  it('never turns a NUL label into the plain label', () => {
    assert.notEqual(pgSafeText('abc\u0000'), 'abc');
  });
});

describe('pgSafeArgs', () => {
  it('cleans string args of a decoded log, keeps the rest', () => {
    const abi = parseAbi(['event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)']);
    const node = `0x${'11'.repeat(32)}` as Hex;
    const topics = encodeEventTopics({ abi, eventName: 'TextChanged', args: { node, indexedKey: 'description' } });
    const data = encodeAbiParameters([{ type: 'string' }, { type: 'string' }], ['description', 'hi\u0000there']);
    const d = decodeEventLog({ abi, data, topics: topics as [Hex, ...Hex[]], strict: true });
    const args = pgSafeArgs(d.args as Record<string, unknown>);
    assert.equal(args.value, 'hi�there');
    assert.equal(args.key, 'description');
    assert.equal(args.node, node);
  });

  it('accepts events without arguments (viem decodes ResolverCreated() to undefined args)', () => {
    const abi = parseAbi(['event ResolverCreated()']);
    const topics = encodeEventTopics({ abi, eventName: 'ResolverCreated' });
    const d = decodeEventLog({ abi, data: '0x', topics: topics as [Hex, ...Hex[]], strict: true });
    assert.deepEqual(pgSafeArgs(d.args as unknown as Record<string, unknown> | undefined), {});
  });

  it('passes bigints and arrays of non-strings through', () => {
    assert.deepEqual(pgSafeArgs({ id: 5n, ids: [1n, 2n], labels: ['a\u0000'] }), { id: 5n, ids: [1n, 2n], labels: ['a�'] });
  });
});

describe('dnsDecode', () => {
  it('cleans NUL inside a label', () => {
    // \x04 "ab\0c" \x03 "eth" \x00
    const wire = `0x04${stringToHex('ab\u0000c').slice(2)}03${stringToHex('eth').slice(2)}00` as Hex;
    assert.equal(dnsDecode(wire), 'ab�c.eth');
  });
});
