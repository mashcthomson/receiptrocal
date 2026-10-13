import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { verifyPayment } from './lib/verify.mjs';
import { fetchEvidence } from './lib/rpc.mjs';

const PRODUCT_NAME = 'Receiptrocal';
const PUBLIC_HOST = 'receiptrocal.monishc.com.au';

const root = dirname(fileURLToPath(import.meta.url));
const LIMIT = 16 * 1024;
const limitations = [
  'SOL transfers only. Unsupported transaction types require manual review.',
  'Live results trust the selected Solana RPC endpoint; they are not cryptographic proofs.',
  'Duplicate protection is local to this server process and resets on restart.',
  'Synthetic demo fixtures do not establish any onchain payment.',
];

function failure(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw failure('CONTENT_TYPE', 'Send application/json.', 415);
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > LIMIT) throw failure('BODY_TOO_LARGE', 'Request exceeds 16 KiB.', 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw failure('INVALID_JSON', 'Request body must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('INVALID_BODY', 'Request body must be an object.');
  }
  return value;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

export function createApp({ fetcher = fetchEvidence, fixturePath = resolve(root, 'fixtures/demo.json') } = {}) {
  // Mutation after awaiting RPC is synchronous, preventing concurrent receipt claims.
  const receipts = new Map();
  const invoices = new Map();
  let active = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      const port = server.address()?.port;
      // Exact Host-to-Origin pairs. Forwarded headers never authorize a request.
      const allowedOrigin = new Map([
        [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
        [`localhost:${port}`, `http://localhost:${port}`],
        [PUBLIC_HOST, `https://${PUBLIC_HOST}`],
      ]).get(host);
      if (!allowedOrigin) {
        throw failure('INVALID_HOST', `Use an allowed ${PRODUCT_NAME} address.`, 403);
      }
      if (req.headers.origin !== undefined && req.headers.origin !== allowedOrigin) {
        throw failure('INVALID_ORIGIN', 'Cross-origin requests are not allowed.', 403);
      }
      const url = new URL(req.url, allowedOrigin);
      const pathname = url.pathname;
      // Only the explicit app preview document is embeddable, and only by itself.
      if (req.method === 'GET' && pathname === '/' && url.searchParams.get('embed') === '1') {
        res.setHeader('Content-Security-Policy', res.getHeader('Content-Security-Policy').replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
      }
      if (req.method === 'GET' && pathname === '/api/health') {
        return json(res, 200, { ok: true, name: PRODUCT_NAME });
      }
      if (req.method === 'GET' && pathname === '/api/demo') {
        return json(res, 200, JSON.parse(await readFile(fixturePath, 'utf8')));
      }
      if (req.method === 'POST' && pathname === '/api/demo/verify') {
        const { caseId } = await body(req);
        const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
        const sample = fixtures.find(item => item.id === caseId);
        if (!sample) throw failure('UNKNOWN_CASE', 'Choose one of the supplied demo cases.', 404);
        return json(res, 200, {
          invoice: sample.invoice,
          evidence: sample.evidence,
          result: verifyPayment(sample.invoice, sample.evidence, { usedSignatures: sample.usedSignatures || [] }),
          limitations,
        });
      }
      if (req.method === 'POST' && pathname === '/api/verify') {
        const { invoice, signature, cluster = 'mainnet-beta' } = await body(req);
        if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)
          || typeof invoice.id !== 'string' || !invoice.id.trim() || invoice.id.length > 120
          || typeof invoice.recipient !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(invoice.recipient)
          || typeof invoice.amountLamports !== 'string' || !/^[1-9][0-9]{0,19}$/.test(invoice.amountLamports)
          || (invoice.notBefore !== undefined && (!Number.isSafeInteger(invoice.notBefore) || invoice.notBefore < 0))) {
          throw failure('INVALID_INVOICE', 'Provide an invoice ID, Solana recipient and positive integer lamports.');
        }
        if (!['mainnet-beta', 'devnet'].includes(cluster)) throw failure('INVALID_CLUSTER', 'Choose mainnet-beta or devnet.');
        if (active >= 4) throw failure('BUSY', 'Four RPC lookups are already in progress. Try again shortly.', 429);
        active++;
        let evidence;
        try { evidence = await fetcher(signature, { cluster }); }
        finally { active--; }
        const invoiceKey = `${cluster}:${invoice.id}`;
        const fingerprint = JSON.stringify([invoice.recipient, invoice.amountLamports, invoice.notBefore ?? null]);
        const receiptKey = `${cluster}:${signature}`;
        const previousInvoice = invoices.get(invoiceKey);
        if (previousInvoice && previousInvoice.fingerprint !== fingerprint) {
          throw failure('INVOICE_CHANGED', 'This settled invoice ID has different details. Use a new invoice ID.', 409);
        }
        if (previousInvoice && previousInvoice.signature !== signature) {
          throw failure('INVOICE_SETTLED', 'This invoice was already matched to another signature.', 409);
        }
        const owner = receipts.get(receiptKey);
        const result = verifyPayment(invoice, evidence, { usedSignatures: owner && owner !== invoiceKey ? [signature] : [] });
        if (result.status === 'matched') {
          if (!owner && receipts.size >= 10000) {
            throw failure('LEDGER_FULL', 'Local session capacity reached. Export records before restarting.', 503);
          }
          receipts.set(receiptKey, invoiceKey);
          invoices.set(invoiceKey, { fingerprint, signature });
        }
        return json(res, 200, { invoice, result, evidence, limitations });
      }
      if (req.method === 'GET') {
        const files = {
          '/': ['index.html', 'text/html; charset=utf-8'],
          '/index.html': ['index.html', 'text/html; charset=utf-8'],
          '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
          '/style.css': ['style.css', 'text/css; charset=utf-8'],
          '/logo.svg': ['logo.svg', 'image/svg+xml'],
        };
        const asset = files[pathname];
        if (asset) {
          const data = await readFile(resolve(root, 'public', asset[0]));
          res.writeHead(200, { 'Content-Type': asset[1] });
          return res.end(data);
        }
      }
      throw failure('NOT_FOUND', 'Route not found.', 404);
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status || (error.code === 'INVALID_SIGNATURE' ? 400 : 502);
      json(res, status, { error: { code: error.code || 'REQUEST_FAILED', message: error.code === 'ENOENT' ? 'Required application file is unavailable.' : error.message } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1-65535.');
  const server = createApp();
  server.on('error', error => { console.error(`${PRODUCT_NAME}: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`${PRODUCT_NAME} local desk: http://127.0.0.1:${port}\nRead-only. Demo data is synthetic. Duplicate ledger resets on restart.`));
}
