import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  namehash,
  size,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { answerErrorAbi, resolverAbi, universalResolverAbi } from '../abis.js';
import { LOCAL_BATCH_GATEWAY, UNIVERSAL_RESOLVER } from '../chain.js';
import { dnsEncode } from './name.js';

export class NotFoundError extends Error {
  readonly status = 404;
}

export type RecordQuery =
  | { kind: 'addr' } // ETH address via addr(bytes32): supported by every resolver generation
  | { kind: 'coin'; coinType: number }
  | { kind: 'text'; key: string }
  | { kind: 'contenthash' };

export type Answer = { ok: true; value: string | null } | { ok: false; error: string };

export type ResolveResult = { resolver: Address; answers: Answer[] };

/** Batch size used when one big multicall fails (offchain gateways cap request bursts). */
export const FALLBACK_CHUNK_SIZE = 30;

/** UR errors that mean "this name has no resolver". */
const NOT_FOUND_ERRORS = new Set(['ResolverNotFound', 'ResolverNotContract']);

const encodeQuery = (node: Hex, q: RecordQuery): Hex => {
  switch (q.kind) {
    case 'addr':
      return encodeFunctionData({ abi: resolverAbi, functionName: 'addr', args: [node] });
    case 'coin':
      return encodeFunctionData({ abi: resolverAbi, functionName: 'addr', args: [node, BigInt(q.coinType)] });
    case 'text':
      return encodeFunctionData({ abi: resolverAbi, functionName: 'text', args: [node, q.key] });
    case 'contenthash':
      return encodeFunctionData({ abi: resolverAbi, functionName: 'contenthash', args: [node] });
  }
};

/** Answers inside a multicall are either ABI return data or 4-byte-selector error data. */
export function decodeAnswer(q: RecordQuery, data: Hex): Answer {
  if (data === '0x') return { ok: true, value: null };
  if (size(data) % 32 === 4) return { ok: false, error: describeError(data) };
  try {
    switch (q.kind) {
      case 'addr': {
        const a = decodeFunctionResult({ abi: resolverAbi, functionName: 'addr', args: ['0x' as Hex], data }) as Address;
        return { ok: true, value: a === zeroAddress ? null : a };
      }
      case 'coin': {
        const b = decodeFunctionResult({ abi: resolverAbi, functionName: 'addr', args: ['0x' as Hex, 0n], data }) as Hex;
        return { ok: true, value: b === '0x' ? null : b };
      }
      case 'text': {
        const s = decodeFunctionResult({ abi: resolverAbi, functionName: 'text', data });
        return { ok: true, value: s === '' ? null : s };
      }
      case 'contenthash': {
        const b = decodeFunctionResult({ abi: resolverAbi, functionName: 'contenthash', data });
        return { ok: true, value: b === '0x' ? null : b };
      }
    }
  } catch (err) {
    return { ok: false, error: `undecodable answer: ${(err as Error).message.split('\n')[0]}` };
  }
}

function describeError(data: Hex): string {
  try {
    const e = decodeErrorResult({ abi: answerErrorAbi, data });
    if (e.errorName === 'HttpError') return `HTTP ${e.args[0]}: ${e.args[1]}`;
    if (e.errorName === 'Error') return String(e.args[0]);
    if (e.errorName === 'UnsupportedResolverProfile') return 'Unsupported resolver profile';
    return `Resolver error ${e.args[0]}`;
  } catch {
    return `Resolver error ${data.slice(0, 10)}`;
  }
}

/** Name of the custom error a UR call reverted with, if any. */
export function revertErrorName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
}

async function callUR(client: PublicClient, name: string, node: Hex, queries: RecordQuery[]) {
  const data = encodeFunctionData({
    abi: resolverAbi,
    functionName: 'multicall',
    args: [queries.map((q) => encodeQuery(node, q))],
  });
  const [result, resolver] = await client.readContract({
    address: UNIVERSAL_RESOLVER,
    abi: universalResolverAbi,
    functionName: 'resolveWithGateways',
    args: [dnsEncode(name), data, [LOCAL_BATCH_GATEWAY]],
  });
  const raw = decodeFunctionResult({ abi: resolverAbi, functionName: 'multicall', data: result });
  return { resolver, answers: queries.map((q, i) => decodeAnswer(q, raw[i] ?? '0x')) };
}

/**
 * Resolves many records for one name with a single UniversalResolver multicall. Works for
 * ENSv1, ENSv2 and offchain (CCIP-read) names alike. Throws NotFoundError when the name has
 * no resolver (unregistered, expired or never set up).
 */
export async function resolveRecords(client: PublicClient, name: string, queries: RecordQuery[]): Promise<ResolveResult> {
  const node = namehash(name);
  try {
    return await callUR(client, name, node, queries);
  } catch (err) {
    const errorName = revertErrorName(err);
    if (errorName && NOT_FOUND_ERRORS.has(errorName)) throw new NotFoundError(`${name} has no resolver`);
    if (queries.length <= FALLBACK_CHUNK_SIZE) throw err;
  }
  // The one-shot call failed for a reason other than "no resolver". This happens with offchain
  // resolvers whose gateways reject big bursts, so retry in smaller chunks and keep what works.
  let resolver: Address | undefined;
  const answers: Answer[] = [];
  let lastError: unknown;
  for (let i = 0; i < queries.length; i += FALLBACK_CHUNK_SIZE) {
    const chunk = queries.slice(i, i + FALLBACK_CHUNK_SIZE);
    try {
      const r = await callUR(client, name, node, chunk);
      resolver = r.resolver;
      answers.push(...r.answers);
    } catch (err) {
      lastError = err;
      const msg = err instanceof BaseError ? err.shortMessage : String(err);
      answers.push(...chunk.map((): Answer => ({ ok: false, error: msg })));
    }
  }
  if (!resolver) throw lastError;
  return { resolver, answers };
}
