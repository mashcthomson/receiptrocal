import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer, serveStdio, createLedger, DEFAULT_FIXTURE_PATH } from '../agent/mcp.mjs';
import {
  createMerchant, resolveConfig, parseArgs, walkthrough, PAID_PATH, INVOICE_HEADER, SIGNATURE_HEADER,
} from '../agent/merchant-demo.mjs';

const fixtures = JSON.parse(await readFile(DEFAULT_FIXTURE_PATH, 'utf8'));
const byId = id => fixtures.find(item => item.id === id);
const paid = byId('paid');
const sig = id => byId(id).evidence.signature;

// Stand-in for the RPC adapter: returns fixture transactions as if read from RPC. Test-only.
function fakeFetcher({ calls = [], fail } = {}) {
  return async (signature, { cluster }) => {
    calls.push({ signature, cluster });
    if (fail) throw Object.assign(new Error('Unable to reach Solana RPC.'), { code: fail });
    const sample = fixtures.find(item => item.evidence.signature === signature);
    return {
      source: 'rpc', cluster, signature, commitment: 'finalized', fetchedAt: new Date().toISOString(),
      transaction: sample ? structuredClone(sample.evidence.transaction) : null,
    };
  };
}

async function initialized(options) {
  const server = createMcpServer(options);
  const init = await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  let next = 1;
  const call = async (name, args) => {
    const response = await server.handle({ jsonrpc: '2.0', id: next++, method: 'tools/call', params: { name, arguments: args } });
    return response.result;
  };
  return { server, call };
}

const liveArgs = (invoice, signature, extra = {}) => ({ mode: 'live', invoice, signature, cluster: 'devnet', ...extra });

test('MCP lifecycle: initialize, tools/list, errors and notifications', async () => {
  const server = createMcpServer();
  const early = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(early.error.code, -32002);
  assert.deepEqual((await server.handle({ jsonrpc: '2.0', id: 2, method: 'ping' })).result, {});
  const init = await server.handle({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'receiptrail-mcp');
  const list = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map(tool => tool.name), ['verify_invoice_payment', 'list_demo_cases']);
  for (const tool of list.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.type, 'object');
  }
  assert.ok(!('evidence' in list.result.tools[0].inputSchema.properties), 'no caller evidence parameter');
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).error.code, -32601);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'send_payment', arguments: {} } })).error.code, -32602);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_demo_cases', arguments: [] } })).error.code, -32602);
  assert.equal((await server.handle({ jsonrpc: '1.0', id: 8, method: 'ping' })).error.code, -32600);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: { bad: 1 }, method: 'ping' })).error.code, -32600);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), null);
});

test('MCP stdio framing: newline JSON on stdout only, diagnostics on stderr', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorStream = new PassThrough();
  let out = '';
  let err = '';
  output.on('data', chunk => { out += chunk; });
  errorStream.on('data', chunk => { err += chunk; });
  const done = serveStdio({ input, output, errorStream });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n\n');
  input.write('not json\n');
  input.write('[{"jsonrpc":"2.0","id":9,"method":"ping"}]\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_demo_cases","arguments":{}}}');
  input.end('\n');
  await done;
  const lines = out.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 4, 'one line per request; none for notifications');
  const byIdMap = new Map(lines.filter(line => line.id !== null).map(line => [line.id, line]));
  assert.equal(byIdMap.get(1).result.protocolVersion, '2025-03-26');
  assert.equal(byIdMap.get(2).result.isError, false);
  const errors = lines.filter(line => line.id === null).map(line => line.error.code).sort();
  assert.deepEqual(errors, [-32700, -32600].sort());
  assert.match(err, /client initialized/);
  assert.doesNotMatch(out, /receiptrail-mcp\]/);
});

test('MCP stdio rejects an oversized newline-terminated line in one chunk, then recovers', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', chunk => { out += chunk; });
  const done = serveStdio({ input, output, errorStream: new PassThrough() });
  const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(300 * 1024) } });
  input.write(`${huge}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n`);
  input.end();
  await done;
  const lines = out.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, null);
  assert.equal(lines[0].error.code, -32600);
  assert.match(lines[0].error.message, /exceeds/);
  assert.deepEqual(lines[1], { jsonrpc: '2.0', id: 2, result: {} });
});

test('list_demo_cases is labelled synthetic', async () => {
  const { call } = await initialized();
  const result = await call('list_demo_cases', {});
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.provenance.synthetic, true);
  assert.deepEqual(result.structuredContent.cases.map(item => item.id), fixtures.map(item => item.id));
  assert.equal(JSON.parse(result.content[0].text).cases.length, fixtures.length);
  assert.equal((await call('list_demo_cases', { x: 1 })).isError, true);
});

test('demo verification reproduces every fixture expectation with fixture provenance', async () => {
  const { call, server } = await initialized();
  for (const item of fixtures) {
    const result = await call('verify_invoice_payment', { mode: 'demo', caseId: item.id });
    assert.equal(result.isError, false);
    const out = result.structuredContent;
    assert.equal(out.result.status, item.expectedStatus, item.id);
    assert.equal(out.provenance.source, 'fixture');
    assert.equal(out.provenance.synthetic, true);
    assert.equal(out.provenance.endpoint, null);
    assert.match(out.provenance.statement, /not onchain/);
    assert.equal(out.ledger.recorded, false);
    assert.equal(out.evidence, undefined);
  }
  assert.equal(server.ledger.size, 0, 'demo never touches the live ledger');
  const withEvidence = await call('verify_invoice_payment', { mode: 'demo', caseId: 'paid', includeEvidence: true });
  assert.equal(withEvidence.structuredContent.evidence.source, 'fixture');
  const unknown = await call('verify_invoice_payment', { mode: 'demo', caseId: 'nope' });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent.error.code, 'UNKNOWN_CASE');
});

test('caller-supplied evidence or mixed-mode arguments are refused', async () => {
  const { call } = await initialized({ fetcher: fakeFetcher() });
  const attempts = [
    { mode: 'live', invoice: paid.invoice, signature: sig('paid'), cluster: 'devnet', evidence: paid.evidence },
    { mode: 'demo', caseId: 'paid', invoice: paid.invoice },
    { mode: 'demo', caseId: 'paid', evidence: paid.evidence },
    { mode: 'mainnet', caseId: 'paid' },
    {},
  ];
  for (const args of attempts) {
    const result = await call('verify_invoice_payment', args);
    assert.equal(result.isError, true, JSON.stringify(Object.keys(args)));
    assert.match(result.structuredContent.error.code, /INVALID_(ARGUMENTS|MODE)/);
  }
});

test('live input validation rejects bad invoice, signature and cluster before any fetch', async () => {
  const calls = [];
  const { call } = await initialized({ fetcher: fakeFetcher({ calls }) });
  const cases = [
    [liveArgs({ ...paid.invoice, amountLamports: '1.5' }, sig('paid')), 'INVALID_INVOICE'],
    [liveArgs({ ...paid.invoice, amountLamports: '99999999999999999999' }, sig('paid')), 'INVALID_INVOICE'],
    [liveArgs({ ...paid.invoice, recipient: 'not-an-address' }, sig('paid')), 'INVALID_INVOICE'],
    [liveArgs({ ...paid.invoice, extra: true }, sig('paid')), 'INVALID_INVOICE'],
    [liveArgs(paid.invoice, 'abc'), 'INVALID_SIGNATURE'],
    [liveArgs(paid.invoice, sig('paid'), { cluster: 'testnet' }), 'INVALID_CLUSTER'],
  ];
  for (const [args, code] of cases) {
    const result = await call('verify_invoice_payment', args);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, code);
  }
  assert.equal(calls.length, 0);
});

test('live mode uses RPC evidence, honest provenance and process replay protection', async () => {
  const calls = [];
  const { call, server } = await initialized({ fetcher: fakeFetcher({ calls }) });
  const invoiceA = { ...paid.invoice, id: 'A-1' };
  const first = (await call('verify_invoice_payment', liveArgs(invoiceA, sig('paid')))).structuredContent;
  assert.equal(first.result.status, 'matched');
  assert.equal(first.result.source, 'rpc');
  assert.deepEqual(calls[0], { signature: sig('paid'), cluster: 'devnet' });
  assert.equal(first.provenance.source, 'rpc');
  assert.equal(first.provenance.synthetic, false);
  assert.equal(first.provenance.endpoint, 'https://api.devnet.solana.com');
  assert.equal(first.ledger.recorded, true);
  assert.equal(server.ledger.size, 1);

  const again = (await call('verify_invoice_payment', liveArgs(invoiceA, sig('paid')))).structuredContent;
  assert.equal(again.result.status, 'matched', 'same invoice and receipt stays matched');

  const reuse = (await call('verify_invoice_payment', liveArgs({ ...paid.invoice, id: 'B-2' }, sig('paid')))).structuredContent;
  assert.equal(reuse.result.status, 'duplicate');
  assert.equal(reuse.result.code, 'SIGNATURE_ALREADY_USED');
  assert.equal(reuse.ledger.recorded, false);
  assert.match(reuse.ledger.note, /A-1/);

  const changed = await call('verify_invoice_payment', liveArgs({ ...invoiceA, amountLamports: '1' }, sig('paid')));
  assert.equal(changed.structuredContent.error.code, 'INVOICE_CHANGED');
  const otherSig = await call('verify_invoice_payment', liveArgs(invoiceA, sig('underpaid')));
  assert.equal(otherSig.structuredContent.error.code, 'INVOICE_ALREADY_SETTLED');

  // Ledger keys include the cluster.
  const mainnet = (await call('verify_invoice_payment', liveArgs({ ...paid.invoice, id: 'B-2' }, sig('paid'), { cluster: 'mainnet-beta' }))).structuredContent;
  assert.equal(mainnet.result.status, 'matched');
  assert.equal(mainnet.provenance.endpoint, 'https://api.mainnet-beta.solana.com');
});

test('live mode refuses non-RPC evidence and surfaces RPC failures without recording', async () => {
  const relabel = async signature => ({ ...paid.evidence, signature });
  const { call: callFixture, server: a } = await initialized({ fetcher: relabel });
  const refused = await callFixture('verify_invoice_payment', liveArgs(paid.invoice, sig('paid')));
  assert.equal(refused.structuredContent.error.code, 'RPC_INVALID_EVIDENCE');
  assert.equal(a.ledger.size, 0);

  const { call, server } = await initialized({ fetcher: fakeFetcher({ fail: 'RPC_NETWORK_ERROR' }) });
  const failed = await call('verify_invoice_payment', liveArgs(paid.invoice, sig('paid')));
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.error.code, 'RPC_NETWORK_ERROR');
  assert.equal(server.ledger.size, 0);

  const { call: callNull } = await initialized({ fetcher: fakeFetcher() });
  const missing = (await callNull('verify_invoice_payment', liveArgs({ ...paid.invoice, id: 'X' }, '1'.repeat(64)))).structuredContent;
  assert.equal(missing.result.status, 'needs_review', 'null transaction is never a match');
  assert.equal(missing.evidenceSummary.transactionAvailable, false);
});

test('concurrent live claims of one receipt settle only one invoice', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const inner = fakeFetcher();
  const { call } = await initialized({ fetcher: async (...args) => { await gate; return inner(...args); } });
  const pending = ['C-1', 'C-2', 'C-3'].map(id => call('verify_invoice_payment', liveArgs({ ...paid.invoice, id }, sig('paid'))));
  release();
  const statuses = (await Promise.all(pending)).map(result => result.structuredContent.result.status).sort();
  assert.deepEqual(statuses, ['duplicate', 'duplicate', 'matched']);
});

test('fixtures not marked source fixture are refused in demo mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rr-agent-'));
  try {
    const path = join(dir, 'demo.json');
    await writeFile(path, JSON.stringify([{ ...paid, evidence: { ...paid.evidence, source: 'rpc' } }]));
    const { call } = await initialized({ fixturePath: path });
    const result = await call('verify_invoice_payment', { mode: 'demo', caseId: 'paid' });
    assert.equal(result.structuredContent.error.code, 'FIXTURES_INVALID');
    const { call: callMissing } = await initialized({ fixturePath: join(dir, 'absent.json') });
    assert.equal((await callMissing('list_demo_cases', {})).structuredContent.error.code, 'FIXTURES_UNAVAILABLE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ledger conflict rules', () => {
  const ledger = createLedger({ max: 1 });
  const invoice = { id: 'L-1', recipient: paid.invoice.recipient, amountLamports: '5' };
  assert.equal(ledger.conflict('devnet', sig('paid'), invoice), null);
  ledger.record('devnet', sig('paid'), invoice);
  ledger.record('devnet', sig('paid'), invoice);
  assert.equal(ledger.size, 1);
  assert.equal(ledger.conflict('devnet', sig('paid'), { ...invoice, id: 'L-2' }).code, 'SIGNATURE_ALREADY_USED');
  assert.equal(ledger.conflict('devnet', sig('failed'), invoice).code, 'INVOICE_ALREADY_SETTLED');
  assert.equal(ledger.conflict('devnet', sig('paid'), { ...invoice, amountLamports: '6' }).code, 'INVOICE_CHANGED');
  assert.throws(() => ledger.record('devnet', sig('failed'), { ...invoice, id: 'L-3' }), { code: 'LEDGER_FULL' });
});

// ---------- merchant demo ----------

async function startMerchant(config, deps) {
  const server = createMerchant(config, deps);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (headers = {}) => {
    const response = await fetch(`${base}${PAID_PATH}`, { headers });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const pay = (invoiceId, signature) => get({ [INVOICE_HEADER]: invoiceId, [SIGNATURE_HEADER]: signature });
  return { server, base, get, pay, close: () => new Promise(resolve => server.close(resolve)) };
}

test('merchant config fails clearly when absent or inconsistent', async () => {
  await assert.rejects(resolveConfig({}), { code: 'CONFIG_MISSING' });
  await assert.rejects(resolveConfig({ mode: 'live' }), { code: 'CONFIG_MISSING' });
  await assert.rejects(resolveConfig({ mode: 'live', recipient: 'bad', amountLamports: '1' }), { code: 'INVALID_INVOICE' });
  await assert.rejects(resolveConfig({ mode: 'live', recipient: paid.invoice.recipient, amountLamports: '1', cluster: 'testnet' }), { code: 'CONFIG_INVALID' });
  await assert.rejects(resolveConfig({ mode: 'demo', recipient: paid.invoice.recipient }), { code: 'CONFIG_INVALID' });
  await assert.rejects(resolveConfig({ mode: 'demo', fixturePath: '/nonexistent/demo.json' }), { code: 'FIXTURES_UNAVAILABLE' });
  assert.throws(() => parseArgs([]), { code: 'CONFIG_MISSING' });
  assert.throws(() => parseArgs(['--demo', '--live']), { code: 'CONFIG_MISSING' });
  assert.throws(() => parseArgs(['--live', '--walkthrough']), { code: 'CONFIG_INVALID' });
  assert.throws(() => parseArgs(['--demo', '--key', 'x']), { code: 'CONFIG_INVALID' });
  assert.equal(parseArgs(['--demo']).port, 4319);
  const live = parseArgs(['--live', '--recipient', paid.invoice.recipient, '--lamports', '5', '--cluster', 'devnet']);
  assert.deepEqual([live.mode, live.cluster, live.amountLamports], ['live', 'devnet', '5']);
  assert.throws(() => createMerchant(null), { code: 'CONFIG_MISSING' });
});

test('merchant demo: 402 invoice, release on match, refuse bad payments and duplicate receipts', async () => {
  const config = await resolveConfig({ mode: 'demo' });
  assert.equal(config.recipient, paid.invoice.recipient);
  const m = await startMerchant(config);
  try {
    const health = await fetch(`${m.base}/api/health`).then(response => response.json());
    assert.equal(health.mode, 'demo');

    const first = await m.get();
    assert.equal(first.status, 402);
    assert.equal(first.body.error.code, 'PAYMENT_REQUIRED');
    assert.equal(first.headers.get('x-receiptrail-mode'), 'demo');
    const invoice = first.body.invoice;
    assert.equal(first.headers.get(INVOICE_HEADER), invoice.id);
    assert.equal(invoice.recipient, paid.invoice.recipient);
    assert.equal(invoice.amountLamports, paid.invoice.amountLamports);
    assert.match(first.body.payment.style, /not x402 protocol compatible/);
    assert.equal(first.body.data, undefined);

    for (const id of ['underpaid', 'wrong-recipient', 'failed', 'unavailable']) {
      const refused = await m.pay(invoice.id, sig(id));
      assert.equal(refused.status, 402, id);
      assert.equal(refused.body.error.code, 'PAYMENT_NOT_ACCEPTED');
      assert.notEqual(refused.body.receipt.result.status, 'matched');
      assert.equal(refused.body.receipt.provenance.synthetic, true);
      assert.equal(refused.body.invoice.id, invoice.id, 'same invoice stays payable');
      assert.equal(refused.body.data, undefined);
    }

    const ok = await m.pay(invoice.id, sig('paid'));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.receipt.result.status, 'matched');
    assert.equal(ok.body.receipt.invoice.id, invoice.id);
    assert.equal(ok.body.receipt.provenance.source, 'fixture');
    assert.match(ok.body.receipt.provenance.statement, /Not onchain/);
    assert.equal(ok.body.data.dataset, 'receiptrail-sample-report');

    assert.equal((await m.pay(invoice.id, sig('paid'))).status, 200, 'same receipt re-delivers same invoice');
    const swap = await m.pay(invoice.id, sig('underpaid'));
    assert.equal(swap.status, 409);
    assert.equal(swap.body.error.code, 'INVOICE_ALREADY_SETTLED');

    const second = await m.get();
    assert.notEqual(second.body.invoice.id, invoice.id);
    const dup = await m.pay(second.body.invoice.id, sig('paid'));
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'RECEIPT_ALREADY_USED');
    assert.equal(dup.body.receipt.result.status, 'duplicate');
    assert.equal(dup.body.data, undefined);
  } finally { await m.close(); }
});

test('merchant rejects buyer-made invoices, malformed headers, unknown receipts and foreign hosts', async () => {
  const m = await startMerchant(await resolveConfig({ mode: 'demo' }));
  try {
    const forged = await m.pay('inv_buyer_made', sig('paid'));
    assert.equal(forged.status, 404);
    assert.equal(forged.body.error.code, 'UNKNOWN_INVOICE');
    const { body: { invoice } } = await m.get();
    assert.equal((await m.get({ [INVOICE_HEADER]: invoice.id })).body.error.code, 'MISSING_PAYMENT_HEADERS');
    assert.equal((await m.pay(invoice.id, 'xyz')).body.error.code, 'INVALID_SIGNATURE');
    const unknownSig = await m.pay(invoice.id, '1'.repeat(64));
    assert.equal(unknownSig.status, 402);
    assert.equal(unknownSig.body.error.code, 'UNKNOWN_DEMO_SIGNATURE');
    const post = await fetch(`${m.base}${PAID_PATH}`, { method: 'POST' });
    assert.equal(post.status, 405);
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: m.server.address().port, path: PAID_PATH, headers: { Host: 'evil.example' } },
        response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
  } finally { await m.close(); }
});

test('merchant state is in memory: invoices expire and vanish on restart', async () => {
  let clock = Date.parse('2026-10-13T00:00:00Z');
  const config = await resolveConfig({ mode: 'demo' });
  const a = await startMerchant(config, { now: () => clock });
  const { body: { invoice } } = await a.get();
  clock += 16 * 60 * 1000;
  const expired = await a.pay(invoice.id, sig('paid'));
  assert.equal(expired.status, 410);
  const { body: { invoice: fresh } } = await a.get();
  assert.equal((await a.pay(fresh.id, sig('paid'))).status, 200);
  await a.close();
  const b = await startMerchant(config, { now: () => clock });
  try {
    assert.equal((await b.pay(fresh.id, sig('paid'))).body.error.code, 'UNKNOWN_INVOICE');
  } finally { await b.close(); }
});

test('merchant live mode: RPC evidence, notBefore binding and RPC failure withholds data', async () => {
  const calls = [];
  const old = await resolveConfig({ mode: 'live', recipient: paid.invoice.recipient, amountLamports: paid.invoice.amountLamports, cluster: 'devnet', notBefore: 0 });
  const m = await startMerchant(old, { fetcher: fakeFetcher({ calls }) });
  try {
    const { body: first } = await m.get();
    assert.equal(first.invoice.notBefore, 0);
    assert.equal(first.payment.mode, 'live');
    const ok = await m.pay(first.invoice.id, sig('paid'));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.receipt.provenance.source, 'rpc');
    assert.equal(ok.body.receipt.provenance.synthetic, false);
    assert.equal(ok.body.receipt.provenance.endpoint, 'https://api.devnet.solana.com');
    assert.deepEqual(calls.at(-1), { signature: sig('paid'), cluster: 'devnet' });
    const { body: second } = await m.get();
    assert.equal((await m.pay(second.invoice.id, sig('paid'))).status, 409);
  } finally { await m.close(); }

  const current = await resolveConfig({ mode: 'live', recipient: paid.invoice.recipient, amountLamports: paid.invoice.amountLamports, cluster: 'devnet' });
  const issuedAfterPayment = (paid.evidence.transaction.blockTime + 3600) * 1000;
  const n = await startMerchant(current, { fetcher: fakeFetcher(), now: () => issuedAfterPayment });
  try {
    const { body } = await n.get();
    assert.ok(body.invoice.notBefore > paid.evidence.transaction.blockTime, 'invoice starts at issue time');
    const early = await n.pay(body.invoice.id, sig('paid'));
    assert.equal(early.status, 402);
    assert.equal(early.body.receipt.result.code, 'PAYMENT_TOO_EARLY');
  } finally { await n.close(); }

  const f = await startMerchant(current, { fetcher: fakeFetcher({ fail: 'RPC_TIMEOUT' }) });
  try {
    const { body } = await f.get();
    const failed = await f.pay(body.invoice.id, sig('paid'));
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error.code, 'RPC_TIMEOUT');
    assert.equal(failed.body.data, undefined);
  } finally { await f.close(); }

  const fixtureSourced = await startMerchant(current, { fetcher: async signature => ({ ...paid.evidence, signature }) });
  try {
    const { body } = await fixtureSourced.get();
    assert.equal((await fixtureSourced.pay(body.invoice.id, sig('paid'))).body.error.code, 'RPC_INVALID_EVIDENCE');
  } finally { await fixtureSourced.close(); }
});

test('scripted walkthrough produces the demo story', async () => {
  const config = await resolveConfig({ mode: 'demo' });
  const m = await startMerchant(config);
  try {
    const steps = await walkthrough(m.base, config.cases, () => {});
    assert.deepEqual(steps.map(step => step.status), [402, 402, 200, 402, 409]);
  } finally { await m.close(); }
});
