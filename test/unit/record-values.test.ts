import assert from 'node:assert/strict';
import { getCoderByCoinType } from '@ensdomains/address-encoder';
import { encode } from '@ensdomains/content-hash';
import { describe, it } from 'node:test';
import { bytesToHex } from 'viem';
import { describeRecord } from '../../src/record-values.js';

describe('describeRecord', () => {
  it('marks text and name records as utf8', () => {
    assert.deepEqual(describeRecord({ kind: 'text', key: 'avatar', value: 'https://a' }), { kind: 'text', key: 'avatar', value: 'https://a', encoding: 'utf8' });
    assert.equal(describeRecord({ kind: 'name', key: '', value: 'alice.eth' }).encoding, 'utf8');
  });

  it('decodes addresses into the chain format', () => {
    const eth = describeRecord({ kind: 'addr', key: '60', value: '0x00000000000000000000000000000000000000aa' });
    assert.equal(eth.encoding, 'bytes');
    assert.equal(eth.decoded, '0x00000000000000000000000000000000000000AA');
    const btcAddress = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'; // BIP-173 example
    const btc = describeRecord({ kind: 'addr', key: '0', value: bytesToHex(getCoderByCoinType(0).decode(btcAddress)) });
    assert.equal(btc.decoded, btcAddress);
  });

  it('decodes contenthash into a URI', () => {
    const cid = 'bafybeiesmy6rsaglneqxbzkbdj5degzp2izydfadhl2vu3oyrp7k52fypu';
    const r = describeRecord({ kind: 'contenthash', key: '', value: `0x${encode('ipfs', cid)}` });
    assert.equal(r.encoding, 'bytes');
    assert.equal(r.decoded, `ipfs://${cid}`);
  });

  it('leaves out decoded when the value cannot be decoded', () => {
    assert.equal(describeRecord({ kind: 'addr', key: '999999999', value: '0x01' }).decoded, undefined);
    assert.equal(describeRecord({ kind: 'contenthash', key: '', value: '0x1234' }).decoded, undefined);
    assert.equal(describeRecord({ kind: 'data', key: 'k', value: '0x1234' }).decoded, undefined);
  });

  it('interface and abi encodings', () => {
    assert.equal(describeRecord({ kind: 'interface', key: '0x01ffc9a7', value: '0x00000000000000000000000000000000000000aa' }).encoding, 'address');
    assert.equal(describeRecord({ kind: 'abi', key: '1', value: '1' }).encoding, 'flag');
  });
});
