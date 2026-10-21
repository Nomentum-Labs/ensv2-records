import assert from 'node:assert/strict';
import { getCoderByCoinType } from '@ensdomains/address-encoder';
import { describe, it } from 'node:test';
import { encodeErrorResult, encodeFunctionResult, parseAbi, type Hex } from 'viem';
import { resolverAbi } from '../../src/abis.js';
import { toGatewayUrl } from '../../src/decode/avatar.js';
import { decodeContenthash } from '../../src/decode/contenthash.js';
import { encodeCoinAddress } from '../../src/decode/multicoin.js';
import { DEFAULT_COIN_TYPES, coinDisplayName } from '../../src/records.js';
import { decodeAnswer } from '../../src/resolve/forward.js';
import { guessLookup, InvalidInputError, normalizeName } from '../../src/resolve/name.js';

const gw = { ipfsGateway: 'https://ipfs.io/ipfs/', arweaveGateway: 'https://arweave.net/' };

describe('decodeAnswer', () => {
  it('decodes text, treats empty string as unset', () => {
    const data = encodeFunctionResult({ abi: resolverAbi, functionName: 'text', result: 'hello' });
    assert.deepEqual(decodeAnswer({ kind: 'text', key: 'x' }, data), { ok: true, value: 'hello' });
    const empty = encodeFunctionResult({ abi: resolverAbi, functionName: 'text', result: '' });
    assert.deepEqual(decodeAnswer({ kind: 'text', key: 'x' }, empty), { ok: true, value: null });
  });

  it('treats the zero address as unset', () => {
    const data = encodeFunctionResult({
      abi: parseAbi(['function addr(bytes32) view returns (address)']),
      functionName: 'addr',
      result: '0x0000000000000000000000000000000000000000',
    });
    assert.deepEqual(decodeAnswer({ kind: 'addr' }, data), { ok: true, value: null });
  });

  it('recognises gateway errors inside a multicall answer', () => {
    const data = encodeErrorResult({
      abi: parseAbi(['error HttpError(uint16 status, string message)']),
      errorName: 'HttpError',
      args: [429, 'HTTP request failed.'],
    });
    assert.deepEqual(decodeAnswer({ kind: 'text', key: 'x' }, data), { ok: false, error: 'HTTP 429: HTTP request failed.' });
  });

  it('treats empty return data as unset', () => {
    assert.deepEqual(decodeAnswer({ kind: 'contenthash' }, '0x'), { ok: true, value: null });
  });
});

describe('decodeContenthash', () => {
  it('handles ipfs, ipns and swarm (enstate only did ipfs)', () => {
    // On-chain values for vitalik.eth, nick.eth, ens.eth (mainnet, 2026-10-20)
    assert.equal(
      decodeContenthash('0xe3010170122092663d1900cb692170e5411a7a321b2fd2338194033af55a6dd88bfeaee8b87d' as Hex),
      'ipfs://bafybeiesmy6rsaglneqxbzkbdj5degzp2izydfadhl2vu3oyrp7k52fypu',
    );
    assert.equal(
      decodeContenthash('0xe5010172002408011220066e20f72cc583d769bc8df5fedff24942b3b8941e827f023d306bdc7aecf5ac' as Hex),
      'ipns://k51qzi5uqu5dgccx524mfjv7znyfsa6g013o6v4yvis9dxnrjbwojc62pt0430',
    );
    assert.equal(
      decodeContenthash('0xe40101fa011b20f8ca7745ece023a874567ce6b41508fe4d80e965cc9948dbdd39d1d3de741958' as Hex),
      'bzz://f8ca7745ece023a874567ce6b41508fe4d80e965cc9948dbdd39d1d3de741958',
    );
  });

  it('rejects unknown codecs', () => {
    assert.throws(() => decodeContenthash('0xdeadbeef' as Hex));
  });
});

describe('encodeCoinAddress', () => {
  it('encodes bitcoin segwit', () => {
    // bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 is the BIP-173 test vector
    assert.equal(encodeCoinAddress(0, '0x0014751e76e8199196d454941c45d1b3a323f1433bd6'), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  });

  it('every default coin type has a coder and a display name', () => {
    for (const ct of DEFAULT_COIN_TYPES) {
      assert.notEqual(coinDisplayName(ct), String(ct), `coin ${ct} has no display name`);
      assert.ok(getCoderByCoinType(ct), `coin ${ct} has no address coder`);
    }
  });
});

describe('toGatewayUrl', () => {
  it('rewrites ipfs, ipns, ar and bare CIDs; leaves https and data alone', () => {
    assert.equal(toGatewayUrl('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', gw), 'https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
    assert.equal(toGatewayUrl('ipfs://ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', gw), 'https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
    assert.equal(toGatewayUrl('ipns://example.eth', gw), 'https://ipfs.io/ipns/example.eth');
    assert.equal(toGatewayUrl('ar://abc', gw), 'https://arweave.net/abc');
    assert.equal(toGatewayUrl('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/1.png', gw), 'https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/1.png');
    assert.equal(toGatewayUrl('https://euc.li/vitalik.eth', gw), 'https://euc.li/vitalik.eth');
    assert.equal(toGatewayUrl('data:image/png;base64,AAAA', gw), 'data:image/png;base64,AAAA');
  });
});

describe('names', () => {
  it('normalizes per ENSIP-15', () => {
    assert.equal(normalizeName('Vitalik.ETH'), 'vitalik.eth');
  });

  it('rejects garbage with InvalidInputError', () => {
    assert.throws(() => normalizeName('not a name'), InvalidInputError);
    assert.throws(() => normalizeName('nodot'), InvalidInputError);
  });

  it('guesses address vs name', () => {
    assert.equal(guessLookup('0xd8da6bf26964af9d7eed9e03e53415d37aa96045').type, 'address');
    assert.equal(guessLookup('nick.eth').type, 'name');
  });
});
