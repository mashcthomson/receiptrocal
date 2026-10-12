import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEvidence } from '../lib/rpc.mjs';

const signature = '1'.repeat(64);
const tx = () => ({
  slot: 123, blockTime: 1700000000, meta: { err: null, innerInstructions: [] },
  transaction: { signatures: [signature], message: { instructions: [] } },
});
const envelope = result => ({ jsonrpc: '2.0', id: 1, result });
const respond = body => async () => ({ ok: true, status: 200, json: async () => body });
const rejects = (promise, code) => assert.rejects(promise, error => error instanceof Error && error.code === code);

for (const cluster of ['mainnet-beta', 'devnet']) {
  test(`fetches finalized parsed evidence from fixed ${cluster} endpoint`, async () => {
    const transaction = tx();
    const before = Date.now();
    let calls = 0;
    const evidence = await fetchEvidence(signature, { cluster, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, `https://api.${cluster}.solana.com`);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(options.signal.aborted, false);
      assert.deepEqual(JSON.parse(options.body), {
        jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, {
          encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0,
        }],
      });
      return respond(envelope(transaction))();
    } });
    assert.equal(calls, 1);
    assert.deepEqual(evidence, { source: 'rpc', cluster, signature, commitment: 'finalized',
      fetchedAt: evidence.fetchedAt, transaction });
    assert.ok(Date.parse(evidence.fetchedAt) >= before && Date.parse(evidence.fetchedAt) <= Date.now());
  });
}

test('defaults to mainnet and preserves unavailable transaction as null', async () => {
  const evidence = await fetchEvidence(signature, { fetchImpl: respond(envelope(null)) });
  assert.equal(evidence.cluster, 'mainnet-beta');
  assert.equal(evidence.transaction, null);
});

test('accepts a nonzero 64-byte signature', async () => {
  let value = (1n << 512n) - 1n;
  let encoded = '';
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  while (value) { encoded = alphabet[Number(value % 58n)] + encoded; value /= 58n; }
  const evidence = await fetchEvidence(encoded, { fetchImpl: respond(envelope(null)) });
  assert.equal(evidence.signature, encoded);
});

test('rejects invalid alphabet, type and decoded length before fetching', async () => {
  for (const input of [null, 123, {}, '', '0'.repeat(88), 'O'.repeat(64), '1'.repeat(63),
    '1'.repeat(65), 'z'.repeat(88), ` ${signature}`, signature + '\n']) {
    await rejects(fetchEvidence(input, { fetchImpl: () => assert.fail('must not fetch') }), 'INVALID_SIGNATURE');
  }
});

test('rejects non-allowlisted clusters before fetching', async () => {
  for (const cluster of ['testnet', 'https://example.com', '__proto__', 'constructor', null, {}]) {
    await rejects(fetchEvidence(signature, { cluster, fetchImpl: () => assert.fail('must not fetch') }), 'INVALID_CLUSTER');
  }
});

test('rejects invalid options with useful codes', async () => {
  for (const options of [null, [], { fetchImpl: null }, { timeoutMs: 0 }, { timeoutMs: -1 },
    { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: 1.5 }, { timeoutMs: 2147483648 }]) {
    await rejects(fetchEvidence(signature, options), 'INVALID_OPTIONS');
  }
});

test('maps network failures without leaking underlying details', async () => {
  await assert.rejects(fetchEvidence(signature, { fetchImpl: () => { throw new Error('private detail'); } }),
    error => error.code === 'RPC_NETWORK_ERROR' && !error.message.includes('private detail'));
});

test('maps HTTP failures including rate limiting without reading the body', async () => {
  for (const status of [301, 403, 429, 500]) {
    await assert.rejects(fetchEvidence(signature, { fetchImpl: async () => ({ ok: false, status,
      json: () => assert.fail('must not parse HTTP error') }) }),
    error => error.code === 'RPC_HTTP_ERROR' && error.httpStatus === status);
  }
});

test('rejects malformed HTTP and JSON responses', async () => {
  for (const response of [null, {}, { ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON'); } }]) {
    await rejects(fetchEvidence(signature, { fetchImpl: async () => response }), 'RPC_INVALID_RESPONSE');
  }
});

test('validates JSON-RPC version, request id and exclusive result/error', async () => {
  for (const body of [null, [], {}, { result: null }, { ...envelope(null), jsonrpc: '1.0' },
    { ...envelope(null), id: 2 }, { ...envelope(null), id: '1' },
    { ...envelope(null), error: { code: -1, message: 'bad' } },
    { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 1, error: null },
    { jsonrpc: '2.0', id: 1, error: { code: 'bad', message: 'bad' } }]) {
    await rejects(fetchEvidence(signature, { fetchImpl: respond(body) }), 'RPC_INVALID_RESPONSE');
  }
});

test('returns RPC failure code and provider message for unsupported versions', async () => {
  await assert.rejects(fetchEvidence(signature, { fetchImpl: respond({ jsonrpc: '2.0', id: 1,
    error: { code: -32015, message: 'Transaction version not supported' } }) }),
  error => error.code === 'RPC_ERROR' && error.rpcCode === -32015 && /version not supported/.test(error.message));
});

test('rejects malformed transaction result structures', async () => {
  for (const result of [false, [], {}, { ...tx(), slot: -1 }, { ...tx(), slot: 2 ** 53 },
    { ...tx(), blockTime: 'now' }, { ...tx(), meta: {} }, { ...tx(), transaction: 'encoded' },
    { ...tx(), transaction: { signatures: [], message: { instructions: [] } } },
    { ...tx(), transaction: { signatures: [signature], message: {} } }]) {
    await rejects(fetchEvidence(signature, { fetchImpl: respond(envelope(result)) }), 'RPC_INVALID_RESPONSE');
  }
});

test('preserves failed transactions and null metadata for verifier decisions', async () => {
  for (const meta of [null, { err: { InstructionError: [0, 'Custom'] } }]) {
    const result = { ...tx(), meta, blockTime: null };
    assert.deepEqual((await fetchEvidence(signature, { fetchImpl: respond(envelope(result)) })).transaction, result);
  }
});

test('timeout aborts fetch even if implementation ignores cancellation', async () => {
  let signal;
  await rejects(fetchEvidence(signature, { timeoutMs: 15, fetchImpl: async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } }), 'RPC_TIMEOUT');
  assert.equal(signal.aborted, true);
});

test('timeout includes response body reading', async () => {
  await rejects(fetchEvidence(signature, { timeoutMs: 15, fetchImpl: async () => ({
    ok: true, status: 200, json: () => new Promise(() => {}),
  }) }), 'RPC_TIMEOUT');
});

test('successful completion clears timeout without aborting completed request', async () => {
  let signal;
  await fetchEvidence(signature, { timeoutMs: 15, fetchImpl: async (_, options) => {
    signal = options.signal;
    return respond(envelope(null))();
  } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(signal.aborted, false);
});
