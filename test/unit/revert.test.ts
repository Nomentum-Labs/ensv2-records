import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, parseAbi, toHex, type Hex } from 'viem';
import { packetToBytes } from 'viem/ens';
import { universalResolverAbi } from '../../src/abis.js';
import { classifyRevert } from '../../src/resolve/forward.js';

const inner = parseAbi(['error UnreachableName(bytes name)', 'error Error(string message)']);

/** Wraps UR revert data the way viem's readContract surfaces it. */
const revert = (data: Hex) =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: universalResolverAbi, data, functionName: 'resolveWithGateways' }),
    { abi: universalResolverAbi, functionName: 'resolveWithGateways', args: [] },
  );
const resolverError = (innerData: Hex) =>
  revert(encodeErrorResult({ abi: universalResolverAbi, errorName: 'ResolverError', args: [innerData] }));

describe('classifyRevert', () => {
  it('UnreachableName inside ResolverError is not found (gregskril.com on Sepolia, 2026-10-21)', () => {
    const data = encodeErrorResult({ abi: inner, errorName: 'UnreachableName', args: [toHex(packetToBytes('gregskril.com'))] });
    assert.deepEqual(classifyRevert(resolverError(data)), { kind: 'not_found' });
  });

  it('ResolverNotFound from the UR is not found', () => {
    const data = encodeErrorResult({ abi: universalResolverAbi, errorName: 'ResolverNotFound', args: [toHex(packetToBytes('x.eth'))] });
    assert.deepEqual(classifyRevert(revert(data)), { kind: 'not_found' });
  });

  it('other resolver errors are resolver failures with a readable detail', () => {
    const data = encodeErrorResult({ abi: inner, errorName: 'Error', args: ['boom'] });
    assert.deepEqual(classifyRevert(resolverError(data)), { kind: 'resolver_failed', detail: 'resolver error: boom' });
    assert.equal(classifyRevert(resolverError('0xdeadbeef')).kind, 'resolver_failed');
  });

  it('non-revert errors are left alone', () => {
    assert.deepEqual(classifyRevert(new Error('socket hang up')), { kind: 'other' });
  });
});
