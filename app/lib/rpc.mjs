const ENDPOINTS = Object.freeze({
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
});
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code }, details);
}

function validSignature(signature) {
  if (typeof signature !== 'string' || signature.length < 64 || signature.length > 88) return false;
  let value = 0n;
  for (const character of signature) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) return false;
    value = value * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (value > 0n) {
    bytes++;
    value >>= 8n;
  }
  let leadingZeros = 0;
  while (signature[leadingZeros] === '1') leadingZeros++;
  return bytes + leadingZeros === 64;
}

function validateEnvelope(envelope) {
  const invalid = () => failure('RPC_INVALID_RESPONSE', 'RPC returned an invalid getTransaction response.');
  if (!isObject(envelope) || envelope.jsonrpc !== '2.0' || envelope.id !== 1) throw invalid();
  const hasResult = Object.hasOwn(envelope, 'result');
  const hasError = Object.hasOwn(envelope, 'error');
  if (hasResult === hasError) throw invalid();
  if (hasError) {
    if (!isObject(envelope.error) || !Number.isInteger(envelope.error.code)
      || typeof envelope.error.message !== 'string') throw invalid();
    throw failure('RPC_ERROR', `Solana RPC error ${envelope.error.code}: ${envelope.error.message.slice(0, 500)}`,
      { rpcCode: envelope.error.code });
  }
  const tx = envelope.result;
  if (tx === null) return null;
  if (!isObject(tx) || !Number.isSafeInteger(tx.slot) || tx.slot < 0
    || !(tx.blockTime === null || Number.isSafeInteger(tx.blockTime))
    || !(tx.meta === null || (isObject(tx.meta) && Object.hasOwn(tx.meta, 'err')))
    || !isObject(tx.transaction) || !Array.isArray(tx.transaction.signatures)
    || tx.transaction.signatures.length === 0 || !tx.transaction.signatures.every(validSignature)
    || !isObject(tx.transaction.message) || !Array.isArray(tx.transaction.message.instructions)) throw invalid();
  // Payment semantics, transaction identity and instruction support belong to verifyPayment.
  return tx;
}

/** Read-only finalized evidence. Provider responses are not cryptographic proofs. */
export async function fetchEvidence(signature, options = {}) {
  if (!validSignature(signature)) throw failure('INVALID_SIGNATURE', 'Signature must be base58 encoding exactly 64 bytes.');
  if (!isObject(options)) throw failure('INVALID_OPTIONS', 'RPC options must be an object.');
  const { cluster = 'mainnet-beta', fetchImpl = globalThis.fetch, timeoutMs = 10000 } = options;
  if (typeof cluster !== 'string' || !Object.hasOwn(ENDPOINTS, cluster)) {
    throw failure('INVALID_CLUSTER', 'Cluster must be mainnet-beta or devnet.');
  }
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw failure('INVALID_OPTIONS', 'Provide a fetch function and a positive timeoutMs integer up to 2147483647.');
  }
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(failure('RPC_TIMEOUT', `Solana RPC timed out after ${timeoutMs} ms.`));
      controller.abort();
    }, timeoutMs);
  });
  const request = async () => {
    let response;
    try {
      response = await fetchImpl(ENDPOINTS[cluster], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, {
          encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0,
        }] }),
      });
    } catch {
      throw failure('RPC_NETWORK_ERROR', 'Unable to reach Solana RPC. Check network access and try again.');
    }
    if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status)) {
      throw failure('RPC_INVALID_RESPONSE', 'RPC did not return an HTTP response.');
    }
    if (!response.ok || response.status < 200 || response.status >= 300) {
      throw failure('RPC_HTTP_ERROR', `Solana RPC returned HTTP ${response.status}.`, { httpStatus: response.status });
    }
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw failure('RPC_INVALID_RESPONSE', 'Unable to read a JSON response from Solana RPC.');
    }
    return {
      source: 'rpc', cluster, signature, commitment: 'finalized',
      fetchedAt: new Date().toISOString(), transaction: validateEnvelope(envelope),
    };
  };
  try {
    // Race also bounds injected fetch implementations that ignore AbortSignal.
    return await Promise.race([request(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
