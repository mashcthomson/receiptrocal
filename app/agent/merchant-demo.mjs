// ReceiptRail merchant demo: an x402-style paid endpoint on loopback.
// x402-style only; NOT compatible with the x402 protocol or its headers.
// Read-only: never creates keys, signs or sends payments. All state is in memory and resets on restart.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { verifyPayment } from '../lib/verify.mjs';
import { fetchEvidence } from '../lib/rpc.mjs';
import {
  DEFAULT_FIXTURE_PATH, RPC_ENDPOINTS, LIMITATIONS, createLedger, failure, isBase58Bytes, loadFixtures, validateInvoice,
} from './mcp.mjs';

export const DEFAULT_PORT = 4319;
export const PAID_PATH = '/api/paid/report';
export const INVOICE_HEADER = 'x-receiptrail-invoice';
export const SIGNATURE_HEADER = 'x-receiptrail-signature';
const INVOICE_TTL_MS = 15 * 60 * 1000;
const MAX_INVOICES = 1000;
const MAX_ACTIVE_RPC = 4;
const DEMO_PRICE_CASE = 'paid';

const MERCHANT_LIMITATIONS = Object.freeze([
  ...LIMITATIONS,
  'x402-style flow for demonstration; not x402 protocol compatible.',
  'Invoices, receipts and the replay ledger live in memory and reset when the merchant restarts.',
]);

// Synthetic goods. The point is the release decision, not the data.
const PAID_DATA = Object.freeze({
  dataset: 'receiptrail-sample-report',
  note: 'Synthetic sample data released after a matched payment.',
  rows: [
    { region: 'north', orders: 42, revenueLamports: '4200000000' },
    { region: 'south', orders: 17, revenueLamports: '1700000000' },
  ],
});

function httpError(code, message, status, extra = {}) {
  return failure(code, message, { status, ...extra });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Configuration is explicit: mode "demo" (synthetic fixtures) or "live" (canonical RPC, merchant-set price).
 * Throws CONFIG_* errors when anything required is missing; never falls back silently.
 */
export async function resolveConfig({ mode, recipient, amountLamports, cluster = 'mainnet-beta', notBefore, fixturePath = DEFAULT_FIXTURE_PATH } = {}) {
  if (mode === 'demo') {
    if (recipient !== undefined || amountLamports !== undefined || notBefore !== undefined) {
      throw failure('CONFIG_INVALID', 'Demo mode takes its price from the synthetic "paid" fixture; do not pass --recipient, --lamports or --not-before.');
    }
    const cases = await loadFixtures(fixturePath);
    const sample = cases.find(item => item.id === DEMO_PRICE_CASE);
    if (!sample) throw failure('CONFIG_MISSING', `Demo fixtures lack the "${DEMO_PRICE_CASE}" case used for pricing.`);
    const price = validateInvoice({ id: 'price', recipient: sample.invoice.recipient, amountLamports: sample.invoice.amountLamports });
    return { mode, cluster: sample.evidence.cluster, recipient: price.recipient, amountLamports: price.amountLamports, cases };
  }
  if (mode === 'live') {
    if (recipient === undefined || amountLamports === undefined) {
      throw failure('CONFIG_MISSING', 'Live mode needs --recipient <base58 address> and --lamports <positive integer>.');
    }
    const price = validateInvoice({ id: 'price', recipient, amountLamports, ...(notBefore !== undefined ? { notBefore } : {}) });
    if (!Object.hasOwn(RPC_ENDPOINTS, cluster)) throw failure('CONFIG_INVALID', 'Cluster must be mainnet-beta or devnet.');
    return { mode, cluster, recipient: price.recipient, amountLamports: price.amountLamports, notBefore: price.notBefore };
  }
  throw failure('CONFIG_MISSING', 'Choose exactly one of --demo or --live.');
}

/** Builds the merchant HTTP server from a resolved config. Dependencies are injectable for tests. */
export function createMerchant(config, { verify = verifyPayment, fetcher = fetchEvidence, now = () => Date.now(), log = () => {} } = {}) {
  if (!config || !['demo', 'live'].includes(config.mode)) throw failure('CONFIG_MISSING', 'createMerchant needs a resolved config.');
  const invoices = new Map();
  const ledger = createLedger();
  let active = 0;

  function prune() {
    const time = now();
    for (const [id, entry] of invoices) {
      if (!entry.settledBy && entry.expiresAt <= time) invoices.delete(id);
    }
  }

  function issueInvoice() {
    prune();
    if (invoices.size >= MAX_INVOICES) throw httpError('MERCHANT_BUSY', 'Too many open invoices. Try again later.', 503);
    const issuedAt = now();
    const invoice = { id: `inv_${randomBytes(12).toString('base64url')}`, recipient: config.recipient, amountLamports: config.amountLamports };
    if (config.mode === 'live') {
      // Bind live payments to this invoice's lifetime: older transactions cannot settle it.
      invoice.notBefore = config.notBefore ?? Math.floor(issuedAt / 1000);
    }
    invoices.set(invoice.id, { invoice, expiresAt: issuedAt + INVOICE_TTL_MS, settledBy: null });
    return invoice;
  }

  function paymentRequired(invoice) {
    return {
      error: { code: 'PAYMENT_REQUIRED', message: 'Pay the invoice in SOL, then retry with the invoice id and transaction signature headers.' },
      invoice,
      payment: {
        style: 'x402-style (not x402 protocol compatible)', asset: 'SOL', cluster: config.cluster, mode: config.mode,
        retryHeaders: { invoice: INVOICE_HEADER, signature: SIGNATURE_HEADER },
        expiresAt: new Date(invoices.get(invoice.id).expiresAt).toISOString(),
      },
      limitations: MERCHANT_LIMITATIONS,
    };
  }

  function provenance(evidence) {
    return config.mode === 'demo'
      ? { source: 'fixture', synthetic: true, cluster: evidence.cluster, fetchedAt: evidence.fetchedAt, statement: 'Synthetic fixture evidence. Not onchain verification.' }
      : { source: 'rpc', synthetic: false, cluster: evidence.cluster, fetchedAt: evidence.fetchedAt, endpoint: RPC_ENDPOINTS[evidence.cluster], statement: 'Finalized transaction from the canonical Solana RPC endpoint; trust rests on that provider.' };
  }

  async function obtainEvidence(signature) {
    if (config.mode === 'demo') {
      const sample = config.cases.find(item => item.evidence.signature === signature);
      if (!sample) throw httpError('UNKNOWN_DEMO_SIGNATURE', 'Demo mode only knows signatures from the synthetic fixtures.', 402);
      return sample.evidence;
    }
    if (active >= MAX_ACTIVE_RPC) throw httpError('BUSY', 'RPC lookups already in progress. Try again shortly.', 429);
    active++;
    try {
      const evidence = await fetcher(signature, { cluster: config.cluster });
      if (!evidence || evidence.source !== 'rpc' || evidence.cluster !== config.cluster || evidence.signature !== signature) {
        throw httpError('RPC_INVALID_EVIDENCE', 'RPC adapter returned evidence with unexpected provenance.', 502);
      }
      return evidence;
    } catch (error) {
      if (error.status) throw error;
      throw httpError(error.code || 'RPC_FAILED', error.message, error.code === 'INVALID_SIGNATURE' ? 400 : 502);
    } finally { active--; }
  }

  async function redeem(invoiceId, signature) {
    const entry = invoices.get(invoiceId);
    if (!entry) throw httpError('UNKNOWN_INVOICE', 'Invoice was not issued by this merchant process (or was lost on restart). Request a new one.', 404);
    if (!entry.settledBy && entry.expiresAt <= now()) {
      invoices.delete(invoiceId);
      throw httpError('INVOICE_EXPIRED', 'Invoice expired. Request a new one.', 410);
    }
    if (!isBase58Bytes(signature, 64)) throw httpError('INVALID_SIGNATURE', 'Signature must be base58 encoding exactly 64 bytes.', 400);
    if (entry.settledBy && entry.settledBy !== signature) {
      throw httpError('INVOICE_ALREADY_SETTLED', 'This invoice was already settled by a different signature.', 409);
    }
    const evidence = await obtainEvidence(signature);
    // Synchronous from here so concurrent redemptions cannot double-claim a receipt or an invoice.
    const { invoice } = entry;
    const conflict = ledger.conflict(config.cluster, signature, invoice);
    if (conflict && conflict.code !== 'SIGNATURE_ALREADY_USED') throw httpError(conflict.code, conflict.message, 409);
    const reused = conflict?.code === 'SIGNATURE_ALREADY_USED';
    // Fixture usedSignatures are ignored here: the merchant's own ledger is the only replay source.
    let result = verify(invoice, evidence, { usedSignatures: reused ? [signature] : [] });
    if (reused && result.status === 'matched') {
      result = { ...result, status: 'duplicate', code: 'SIGNATURE_ALREADY_USED', reasons: [conflict.message] };
    }
    if (result.status === 'matched') {
      ledger.record(config.cluster, signature, invoice);
      entry.settledBy = signature;
    }
    return { invoice, result, provenance: provenance(evidence) };
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-ReceiptRail-Mode', config.mode);
    try {
      const host = req.headers.host || '';
      const port = server.address()?.port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {
        throw httpError('INVALID_HOST', 'Use the loopback address printed by the merchant demo.', 403);
      }
      const pathname = new URL(req.url, `http://${host}`).pathname;
      if (req.method === 'GET' && pathname === '/api/health') {
        return send(res, 200, { ok: true, name: 'ReceiptRail merchant demo', mode: config.mode, cluster: config.cluster, statefulness: 'in-memory, resets on restart' });
      }
      if (pathname === PAID_PATH) {
        if (req.method !== 'GET') throw httpError('METHOD_NOT_ALLOWED', 'Use GET.', 405);
        const invoiceId = req.headers[INVOICE_HEADER];
        const signature = req.headers[SIGNATURE_HEADER];
        if (invoiceId === undefined && signature === undefined) {
          const invoice = issueInvoice();
          log(`issued ${invoice.id}`);
          return send(res, 402, paymentRequired(invoice), { [INVOICE_HEADER]: invoice.id });
        }
        if (typeof invoiceId !== 'string' || typeof signature !== 'string' || invoiceId.length > 64 || signature.length > 100) {
          throw httpError('MISSING_PAYMENT_HEADERS', `Send both ${INVOICE_HEADER} and ${SIGNATURE_HEADER}, or neither to get an invoice.`, 400);
        }
        const outcome = await redeem(invoiceId, signature);
        const { result } = outcome;
        if (result.status === 'matched') {
          log(`released ${invoiceId}`);
          return send(res, 200, { data: PAID_DATA, receipt: outcome, limitations: MERCHANT_LIMITATIONS });
        }
        if (result.status === 'duplicate') {
          return send(res, 409, { error: { code: 'RECEIPT_ALREADY_USED', message: 'This payment already unlocked a different invoice.' }, receipt: outcome });
        }
        return send(res, 402, {
          ...paymentRequired(outcome.invoice),
          error: { code: 'PAYMENT_NOT_ACCEPTED', message: `Payment did not settle this invoice (${result.status}: ${result.code}). Data withheld.` },
          receipt: outcome,
        });
      }
      throw httpError('NOT_FOUND', 'Route not found.', 404);
    } catch (error) {
      if (res.headersSent) return res.end();
      if (!error.status) log(`internal: ${error.message}`);
      send(res, error.status || 500, { error: { code: error.code || 'REQUEST_FAILED', message: error.status ? error.message : 'Internal error.' } });
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return server;
}

export function parseArgs(argv) {
  const options = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--demo', '--live', '--walkthrough'].includes(arg)) { flags.add(arg); continue; }
    const key = { '--recipient': 'recipient', '--lamports': 'amountLamports', '--cluster': 'cluster', '--port': 'port', '--not-before': 'notBefore' }[arg];
    if (!key) throw failure('CONFIG_INVALID', `Unknown argument: ${arg}`);
    if (i + 1 >= argv.length) throw failure('CONFIG_MISSING', `${arg} needs a value.`);
    options[key] = argv[++i];
  }
  if (flags.has('--demo') === flags.has('--live')) throw failure('CONFIG_MISSING', 'Choose exactly one of --demo or --live.');
  if (flags.has('--walkthrough') && !flags.has('--demo')) throw failure('CONFIG_INVALID', '--walkthrough runs only with --demo.');
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw failure('CONFIG_INVALID', '--port must be 0 to 65535.');
  let notBefore;
  if (options.notBefore !== undefined) {
    if (!/^[0-9]{1,15}$/.test(options.notBefore)) throw failure('CONFIG_INVALID', '--not-before must be a Unix timestamp in seconds.');
    notBefore = Number(options.notBefore);
  }
  return {
    mode: flags.has('--demo') ? 'demo' : 'live', walkthrough: flags.has('--walkthrough'), port,
    recipient: options.recipient, amountLamports: options.amountLamports, notBefore,
    ...(options.cluster !== undefined ? { cluster: options.cluster } : {}),
  };
}

/** Scripted buyer for the demo video: walks the 402 flow against a running demo merchant. */
export async function walkthrough(baseUrl, cases, print = console.log) {
  const get = async headers => {
    const response = await fetch(`${baseUrl}${PAID_PATH}`, { headers });
    return { status: response.status, body: await response.json() };
  };
  const signatureOf = id => cases.find(item => item.id === id)?.evidence.signature;
  const steps = [];
  const step = (label, outcome) => {
    const code = outcome.body.error?.code ?? outcome.body.receipt?.result?.code ?? 'OK';
    steps.push({ label, status: outcome.status, code });
    print(`${label}: HTTP ${outcome.status} ${code}`);
  };
  const first = await get({});
  step('1 request data without payment', first);
  const invoiceA = first.body.invoice.id;
  step('2 retry with synthetic underpaid receipt', await get({ [INVOICE_HEADER]: invoiceA, [SIGNATURE_HEADER]: signatureOf('underpaid') }));
  step('3 retry with synthetic paid receipt', await get({ [INVOICE_HEADER]: invoiceA, [SIGNATURE_HEADER]: signatureOf('paid') }));
  const second = await get({});
  step('4 new invoice for a second purchase', second);
  step('5 reuse the same receipt on the new invoice', await get({ [INVOICE_HEADER]: second.body.invoice.id, [SIGNATURE_HEADER]: signatureOf('paid') }));
  return steps;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const log = line => process.stderr.write(`[merchant-demo] ${line}\n`);
  try {
    const args = parseArgs(process.argv.slice(2));
    const config = await resolveConfig(args);
    const server = createMerchant(config, { log });
    server.on('error', error => { log(`server error: ${error.message}`); process.exitCode = 1; });
    server.listen(args.walkthrough ? 0 : args.port, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      console.log(`ReceiptRail merchant demo (${config.mode === 'demo' ? 'SYNTHETIC FIXTURES' : `LIVE RPC ${config.cluster}`}): ${base}${PAID_PATH}`);
      console.log('x402-style, not x402 protocol compatible. Read-only: never signs or sends payments. State is in memory and resets on restart.');
      if (args.walkthrough) {
        try {
          await walkthrough(base, config.cases);
        } catch (error) {
          log(`walkthrough failed: ${error.message}`);
          process.exitCode = 1;
        }
        server.close();
      }
    });
  } catch (error) {
    log(`${error.code || 'ERROR'}: ${error.message}`);
    process.exitCode = 2;
  }
}
