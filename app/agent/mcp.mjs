// ReceiptRail MCP server: read-only payment verification tools over stdio.
// Newline-delimited JSON-RPC 2.0 on stdin/stdout; diagnostics go to stderr only.
// No keys, no signing, no transaction submission. Live mode reads finalized RPC data.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { verifyPayment } from '../lib/verify.mjs';
import { fetchEvidence } from '../lib/rpc.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_FIXTURE_PATH = resolve(root, 'fixtures/demo.json');
export const SERVER_INFO = Object.freeze({ name: 'receiptrail-mcp', version: '0.1.0' });
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// Mirrors the canonical allowlist inside lib/rpc.mjs; reported as provenance only.
export const RPC_ENDPOINTS = Object.freeze({
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
});
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAX_LINE_BYTES = 256 * 1024;
const MAX_LEDGER = 10000;
const MAX_ACTIVE_RPC = 4;

export const LIMITATIONS = Object.freeze([
  'SOL System Program transfers only. Unsupported transactions return needs_review.',
  'Live results trust the canonical Solana RPC endpoint; they are not cryptographic proofs.',
  'Replay protection is local to this process and resets on restart.',
  'Demo results come from synthetic fixtures and do not establish any onchain payment.',
]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function failure(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

/** True when value is base58 that decodes to exactly `length` bytes. */
export function isBase58Bytes(value, length) {
  if (typeof value !== 'string' || value.length < 1 || value.length > Math.ceil(length * 1.38)) return false;
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    number = number * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (number > 0n) { bytes++; number >>= 8n; }
  for (const char of value) { if (char !== '1') break; bytes++; }
  return bytes === length;
}

export function validateInvoice(invoice) {
  if (!isObject(invoice)) throw failure('INVALID_INVOICE', 'invoice must be an object.');
  const extra = Object.keys(invoice).filter(key => !['id', 'recipient', 'amountLamports', 'notBefore'].includes(key));
  if (extra.length) throw failure('INVALID_INVOICE', `Unexpected invoice fields: ${extra.join(', ')}.`);
  if (typeof invoice.id !== 'string' || !/^[\x21-\x7e][\x20-\x7e]{0,119}$/.test(invoice.id)) {
    throw failure('INVALID_INVOICE', 'invoice.id must be 1 to 120 printable ASCII characters.');
  }
  if (!isBase58Bytes(invoice.recipient, 32)) {
    throw failure('INVALID_INVOICE', 'invoice.recipient must be a base58 Solana address (32 bytes).');
  }
  if (typeof invoice.amountLamports !== 'string' || !/^[1-9][0-9]{0,19}$/.test(invoice.amountLamports)
    || BigInt(invoice.amountLamports) > 18446744073709551615n) {
    throw failure('INVALID_INVOICE', 'invoice.amountLamports must be a positive integer string within u64.');
  }
  if (invoice.notBefore !== undefined && (!Number.isSafeInteger(invoice.notBefore) || invoice.notBefore < 0)) {
    throw failure('INVALID_INVOICE', 'invoice.notBefore must be a nonnegative integer Unix timestamp.');
  }
  const clean = { id: invoice.id, recipient: invoice.recipient, amountLamports: invoice.amountLamports };
  if (invoice.notBefore !== undefined) clean.notBefore = invoice.notBefore;
  return clean;
}

const fingerprint = invoice => JSON.stringify([invoice.recipient, invoice.amountLamports, invoice.notBefore ?? null]);

/**
 * Per-process replay ledger keyed by cluster+signature and cluster+invoice id.
 * Callers must run conflict() and record() synchronously after any await,
 * so concurrent claims for one signature cannot both succeed.
 */
export function createLedger({ max = MAX_LEDGER } = {}) {
  const receipts = new Map();
  const invoices = new Map();
  return {
    conflict(cluster, signature, invoice) {
      const settled = invoices.get(`${cluster}:${invoice.id}`);
      if (settled && settled.fingerprint !== fingerprint(invoice)) {
        return { code: 'INVOICE_CHANGED', message: 'This settled invoice id has different details. Use a new invoice id.' };
      }
      if (settled && settled.signature !== signature) {
        return { code: 'INVOICE_ALREADY_SETTLED', message: 'This invoice was already settled by another signature in this process.', signature: settled.signature };
      }
      const owner = receipts.get(`${cluster}:${signature}`);
      if (owner !== undefined && owner !== invoice.id) {
        return { code: 'SIGNATURE_ALREADY_USED', message: 'This signature already settled a different invoice in this process.', invoiceId: owner };
      }
      return null;
    },
    record(cluster, signature, invoice) {
      const key = `${cluster}:${signature}`;
      if (receipts.get(key) === invoice.id) return;
      if (receipts.size >= max) throw failure('LEDGER_FULL', 'Process ledger capacity reached; restart clears it.');
      receipts.set(key, invoice.id);
      invoices.set(`${cluster}:${invoice.id}`, { fingerprint: fingerprint(invoice), signature });
    },
    get size() { return receipts.size; },
  };
}

export async function loadFixtures(path = DEFAULT_FIXTURE_PATH) {
  let cases;
  try { cases = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    throw failure('FIXTURES_UNAVAILABLE', `Demo fixtures could not be read from ${path}: ${error.code || error.message}`);
  }
  if (!Array.isArray(cases)) throw failure('FIXTURES_INVALID', 'Demo fixture file must hold an array.');
  for (const item of cases) {
    // Never relabel: anything not marked as a fixture is refused in demo mode.
    if (!isObject(item) || typeof item.id !== 'string' || !isObject(item.invoice) || !isObject(item.evidence)
      || item.evidence.source !== 'fixture') {
      throw failure('FIXTURES_INVALID', 'Every demo case needs id, invoice and evidence with source "fixture".');
    }
  }
  return cases;
}

function demoProvenance(evidence) {
  return {
    source: 'fixture', synthetic: true, cluster: evidence.cluster ?? null,
    commitment: evidence.commitment ?? null, fetchedAt: evidence.fetchedAt ?? null, endpoint: null,
    statement: 'Synthetic fixture evidence. This is not onchain verification.',
  };
}

function liveProvenance(evidence) {
  return {
    source: 'rpc', synthetic: false, cluster: evidence.cluster, commitment: evidence.commitment,
    fetchedAt: evidence.fetchedAt, endpoint: RPC_ENDPOINTS[evidence.cluster] ?? null,
    statement: 'Finalized transaction read from the canonical Solana RPC endpoint; trust rests on that provider.',
  };
}

const evidenceSummary = evidence => ({
  signature: evidence.signature ?? null,
  slot: evidence.transaction?.slot ?? null,
  blockTime: evidence.transaction?.blockTime ?? null,
  transactionAvailable: evidence.transaction !== null && evidence.transaction !== undefined,
});

const TOOLS = [
  {
    name: 'verify_invoice_payment',
    title: 'Verify a Solana invoice payment (read-only)',
    description: 'Check whether a Solana transaction signature settles a specific SOL invoice. mode "demo" runs a named synthetic fixture case (caseId) and is never onchain verification. mode "live" fetches finalized evidence from the canonical Solana RPC endpoint for the given invoice and signature; caller-supplied evidence is never accepted. Signatures that settled another invoice in this process report duplicate. Never signs or sends transactions.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['demo', 'live'] },
        caseId: { type: 'string', description: 'demo mode only: a case id from list_demo_cases.' },
        invoice: {
          type: 'object', description: 'live mode only.',
          properties: {
            id: { type: 'string' }, recipient: { type: 'string', description: 'base58 Solana address' },
            amountLamports: { type: 'string', pattern: '^[1-9][0-9]*$' }, notBefore: { type: 'integer', minimum: 0 },
          },
          required: ['id', 'recipient', 'amountLamports'], additionalProperties: false,
        },
        signature: { type: 'string', description: 'live mode only: base58 transaction signature.' },
        cluster: { type: 'string', enum: ['mainnet-beta', 'devnet'], default: 'mainnet-beta' },
        includeEvidence: { type: 'boolean', default: false, description: 'Include the full evidence object.' },
      },
      required: ['mode'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'list_demo_cases',
    title: 'List synthetic demo cases',
    description: 'List the synthetic fixture cases usable with verify_invoice_payment mode "demo". Fixtures are not onchain data.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/**
 * Protocol core. handle(message) resolves to a JSON-RPC response object or null for notifications.
 * Dependencies are injectable for tests; defaults are the real verifier, RPC adapter and fixtures.
 */
export function createMcpServer({
  verify = verifyPayment, fetcher = fetchEvidence, fixturePath = DEFAULT_FIXTURE_PATH,
  ledger = createLedger(), log = () => {},
} = {}) {
  let initialized = false;
  let active = 0;

  async function listCases() {
    const cases = await loadFixtures(fixturePath);
    return {
      provenance: { source: 'fixture', synthetic: true, statement: 'Synthetic fixtures for demonstration; not onchain data.' },
      cases: cases.map(item => ({
        id: item.id, title: typeof item.title === 'string' ? item.title : item.id,
        expectedStatus: item.expectedStatus ?? null, invoice: item.invoice,
        signature: item.evidence.signature ?? null, cluster: item.evidence.cluster ?? null,
      })),
    };
  }

  async function verifyTool(args) {
    const allowed = { demo: ['mode', 'caseId', 'includeEvidence'], live: ['mode', 'invoice', 'signature', 'cluster', 'includeEvidence'] };
    if (!Object.hasOwn(allowed, args.mode)) throw failure('INVALID_MODE', 'mode must be "demo" or "live".');
    const extra = Object.keys(args).filter(key => !allowed[args.mode].includes(key));
    if (extra.length) throw failure('INVALID_ARGUMENTS', `Arguments not accepted in ${args.mode} mode: ${extra.join(', ')}.`);
    if (args.includeEvidence !== undefined && typeof args.includeEvidence !== 'boolean') {
      throw failure('INVALID_ARGUMENTS', 'includeEvidence must be a boolean.');
    }

    if (args.mode === 'demo') {
      if (typeof args.caseId !== 'string') throw failure('INVALID_ARGUMENTS', 'demo mode requires caseId.');
      const cases = await loadFixtures(fixturePath);
      const sample = cases.find(item => item.id === args.caseId);
      if (!sample) throw failure('UNKNOWN_CASE', `Unknown demo case. Choose one of: ${cases.map(item => item.id).join(', ')}.`);
      // Demo runs use the fixture's own ledger and never touch the live process ledger.
      const result = verify(sample.invoice, sample.evidence, { usedSignatures: sample.usedSignatures || [] });
      const output = {
        mode: 'demo', caseId: sample.id, invoice: sample.invoice, result,
        provenance: demoProvenance(sample.evidence), evidenceSummary: evidenceSummary(sample.evidence),
        ledger: { scope: 'fixture', recorded: false, note: 'Demo cases use fixture usedSignatures, not the live process ledger.' },
        limitations: LIMITATIONS,
      };
      if (args.includeEvidence) output.evidence = sample.evidence;
      return output;
    }

    const invoice = validateInvoice(args.invoice);
    const cluster = args.cluster ?? 'mainnet-beta';
    if (!Object.hasOwn(RPC_ENDPOINTS, cluster)) throw failure('INVALID_CLUSTER', 'cluster must be mainnet-beta or devnet.');
    if (!isBase58Bytes(args.signature, 64)) throw failure('INVALID_SIGNATURE', 'signature must be base58 encoding exactly 64 bytes.');
    const early = ledger.conflict(cluster, args.signature, invoice);
    if (early && early.code !== 'SIGNATURE_ALREADY_USED') throw failure(early.code, early.message);
    if (active >= MAX_ACTIVE_RPC) throw failure('BUSY', `${MAX_ACTIVE_RPC} RPC lookups already in progress. Try again shortly.`);
    active++;
    let evidence;
    try { evidence = await fetcher(args.signature, { cluster }); }
    finally { active--; }
    if (!isObject(evidence) || evidence.source !== 'rpc' || evidence.cluster !== cluster || evidence.signature !== args.signature) {
      throw failure('RPC_INVALID_EVIDENCE', 'RPC adapter returned evidence with unexpected provenance.');
    }
    // Synchronous from here: re-check and record without another await.
    const conflict = ledger.conflict(cluster, args.signature, invoice);
    if (conflict && conflict.code !== 'SIGNATURE_ALREADY_USED') throw failure(conflict.code, conflict.message);
    const reused = conflict?.code === 'SIGNATURE_ALREADY_USED';
    let result = verify(invoice, evidence, { usedSignatures: reused ? [args.signature] : [] });
    if (reused && result.status === 'matched') {
      // Defence in depth: the process ledger wins even if the verifier disagrees.
      result = { ...result, status: 'duplicate', code: 'SIGNATURE_ALREADY_USED', reasons: [conflict.message] };
    }
    let recorded = false;
    if (result.status === 'matched') { ledger.record(cluster, args.signature, invoice); recorded = true; }
    const output = {
      mode: 'live', invoice, result, provenance: liveProvenance(evidence), evidenceSummary: evidenceSummary(evidence),
      ledger: {
        scope: 'process', recorded,
        note: reused ? `Signature already settled invoice ${conflict.invoiceId} in this process.` : 'Process-local ledger; resets on restart.',
      },
      limitations: LIMITATIONS,
    };
    if (args.includeEvidence) output.evidence = evidence;
    return output;
  }

  async function callTool(params) {
    if (!isObject(params) || typeof params.name !== 'string') {
      throw failure('JSONRPC', 'tools/call needs params.name.', { rpcCode: -32602 });
    }
    const args = params.arguments ?? {};
    if (!isObject(args)) throw failure('JSONRPC', 'arguments must be an object.', { rpcCode: -32602 });
    let output;
    try {
      if (params.name === 'list_demo_cases') {
        if (Object.keys(args).length) throw failure('INVALID_ARGUMENTS', 'list_demo_cases takes no arguments.');
        output = await listCases();
      } else if (params.name === 'verify_invoice_payment') {
        output = await verifyTool(args);
      } else {
        throw failure('JSONRPC', `Unknown tool: ${params.name}`, { rpcCode: -32602 });
      }
    } catch (error) {
      if (error.rpcCode) throw error;
      const payload = { error: { code: error.code || 'TOOL_FAILED', message: error.message } };
      log(`tool ${params.name} failed: ${payload.error.code}`);
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output, isError: false };
  }

  async function dispatch(method, params) {
    if (method === 'initialize') {
      const requested = isObject(params) ? params.protocolVersion : undefined;
      initialized = true;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Read-only Solana invoice verification. Demo mode is synthetic fixtures; live mode reads finalized canonical RPC data. Never signs or sends transactions.',
      };
    }
    if (method === 'ping') return {};
    if (!initialized) throw failure('JSONRPC', 'Server not initialized. Send initialize first.', { rpcCode: -32002 });
    if (method === 'tools/list') return { tools: TOOLS };
    if (method === 'tools/call') return callTool(params);
    throw failure('JSONRPC', `Method not found: ${method}`, { rpcCode: -32601 });
  }

  async function handle(message) {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      const id = isObject(message) && (typeof message.id === 'string' || Number.isInteger(message.id)) ? message.id : null;
      // Responses from the client (no method) are not expected; ignore them quietly.
      if (isObject(message) && message.jsonrpc === '2.0' && message.method === undefined && id !== null) return null;
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC request.' } };
    }
    const isNotification = !Object.hasOwn(message, 'id');
    if (isNotification) {
      if (message.method === 'notifications/initialized') log('client initialized');
      return null;
    }
    const { id } = message;
    if (!(typeof id === 'string' || Number.isInteger(id))) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'id must be a string or integer.' } };
    }
    try {
      return { jsonrpc: '2.0', id, result: await dispatch(message.method, message.params) };
    } catch (error) {
      if (error.rpcCode) return { jsonrpc: '2.0', id, error: { code: error.rpcCode, message: error.message } };
      log(`internal error in ${message.method}: ${error.message}`);
      return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error.' } };
    }
  }

  return { handle, tools: TOOLS, ledger };
}

/** Wire the protocol core to newline-delimited streams. Resolves when input ends and replies flush. */
export function serveStdio({ input = process.stdin, output = process.stdout, errorStream = process.stderr, ...options } = {}) {
  const log = line => errorStream.write(`[receiptrail-mcp] ${line}\n`);
  const server = createMcpServer({ log, ...options });
  const pending = new Set();
  let buffer = '';
  let discarding = false;
  const send = value => { if (value) output.write(`${JSON.stringify(value)}\n`); };
  const tooLarge = () => send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Message exceeds ${MAX_LINE_BYTES} bytes.` } });
  const onLine = line => {
    // Checked per completed line: a whole oversized line can arrive in one chunk.
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return tooLarge();
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }); }
    if (Array.isArray(message)) {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported.' } });
    }
    const task = server.handle(message).then(send, error => log(`unexpected: ${error.message}`));
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  input.setEncoding?.('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (discarding) { discarding = false; continue; }
      onLine(line);
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      buffer = '';
      if (!discarding) {
        discarding = true;
        tooLarge();
      }
    }
  });
  return new Promise(resolveDone => {
    input.on('end', async () => {
      if (buffer.trim() && !discarding) onLine(buffer);
      await Promise.allSettled([...pending]);
      resolveDone();
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stderr.write('[receiptrail-mcp] stdio server ready (read-only; demo = synthetic fixtures, live = canonical RPC)\n');
  serveStdio();
}
