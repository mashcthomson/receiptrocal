import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createApp } from '../server.mjs';

async function setup(t, fetcher) {
  const server = createApp({ fetcher });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, post: (path, data, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
  }) };
}

test('demo cases run through the verifier and are visibly synthetic', async t => {
  const { base, post } = await setup(t, () => { throw new Error('Demo must not call RPC'); });
  const fixtures = await (await fetch(base + '/api/demo')).json();
  assert.ok(fixtures.length >= 6);
  for (const sample of fixtures) {
    const response = await post('/api/demo/verify', { caseId: sample.id });
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.evidence.source, 'fixture');
    assert.equal(report.result.status, sample.expectedStatus, sample.id);
    assert.ok(report.limitations.some(text => text.includes('Synthetic')));
  }
});

test('concurrent live requests cannot settle two invoices with one signature', async t => {
  const fixtures = JSON.parse(await readFile(new URL('../fixtures/demo.json', import.meta.url)));
  const paid = fixtures.find(item => item.id === 'paid');
  let requests = 0;
  const { post } = await setup(t, async () => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { ...structuredClone(paid.evidence), source: 'rpc' };
  });
  const common = { signature: paid.evidence.signature, cluster: paid.evidence.cluster };
  const responses = await Promise.all(['invoice-a', 'invoice-b'].map(id => post('/api/verify', {
    ...common, invoice: { ...paid.invoice, id },
  })));
  const reports = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(reports.map(report => report.result.status).sort(), ['duplicate', 'matched']);
  const winner = reports.find(report => report.result.status === 'matched').invoice;
  assert.equal((await (await post('/api/verify', { ...common, invoice: winner })).json()).result.status, 'matched');
  assert.equal((await post('/api/verify', { ...common, invoice: { ...winner, amountLamports: '1' } })).status, 409);
  assert.equal(requests, 4);
});

test('HTTP boundary rejects cross-origin requests, malformed inputs and arbitrary files', async t => {
  let fetched = false;
  const { base, post } = await setup(t, () => { fetched = true; throw new Error('Should not fetch'); });
  assert.equal((await post('/api/demo/verify', { caseId: 'paid' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/verify', { invoice: {} })).status, 400);
  assert.equal(fetched, false);
  assert.equal((await fetch(base + '/BRIEF.md')).status, 404);
  assert.equal((await post('/api/demo/verify', { caseId: 'missing' })).status, 404);
  assert.equal((await fetch(base + '/api/health')).status, 200);
});

test('RPC failure remains an error and never becomes demo success', async t => {
  const fixtures = JSON.parse(await readFile(new URL('../fixtures/demo.json', import.meta.url)));
  const paid = fixtures.find(item => item.id === 'paid');
  const { post } = await setup(t, () => { throw Object.assign(new Error('RPC unavailable'), { code: 'RPC_NETWORK_ERROR' }); });
  const response = await post('/api/verify', { invoice: paid.invoice, signature: paid.evidence.signature });
  assert.equal(response.status, 502);
  const report = await response.json();
  assert.equal(report.error.code, 'RPC_NETWORK_ERROR');
  assert.equal(report.result, undefined);
});

// Use real HTTP requests with explicit Host headers, independently of fetch's Host handling.
function boundaryRequest(base, { host, origin, path = '/api/demo/verify', forwarded = {} }) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host, 'Content-Type': 'application/json', ...forwarded };
    if (origin !== undefined) headers.Origin = origin;
    const request = http.request(new URL(path, base), { setHost: false, method: path.startsWith('/api/demo/verify') ? 'POST' : 'GET', headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(path.startsWith('/api/demo/verify') ? JSON.stringify({ caseId: 'paid' }) : undefined);
  });
}

const PUBLIC_HOST = 'receiptrocal.monishc.com.au';

test('HTTP boundary accepts only the public HTTPS pair and each matching loopback pair', async t => {
  const { base } = await setup(t, () => { throw new Error('Boundary demo must not call RPC'); });
  const port = new URL(base).port;
  for (const [host, origin] of [
    [PUBLIC_HOST, `https://${PUBLIC_HOST}`],
    [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
    [`localhost:${port}`, `http://localhost:${port}`],
  ]) {
    await t.test(`${host} with its matching origin`, async () => {
      const response = await boundaryRequest(base, { host, origin });
      assert.equal(response.status, 200);
      const data = JSON.parse(response.body);
      assert.equal(data.evidence.source, 'fixture');
      assert.equal(data.result.status, 'matched');
      assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    });
  }
  const page = await boundaryRequest(base, { host: PUBLIC_HOST, path: '/' });
  assert.equal(page.status, 200, 'Public navigation without Origin is permitted');
  assert.match(page.body, /<title>Receiptrocal<\/title>/);
});

test('HTTP boundary rejects impostor hosts even when forwarding headers claim the public site', async t => {
  const { base } = await setup(t, () => { throw new Error('Rejected hosts must not call RPC'); });
  for (const host of [
    'evil.example', `www.${PUBLIC_HOST}`, `other.${PUBLIC_HOST}`, `${PUBLIC_HOST}.evil.example`,
    `evil-${PUBLIC_HOST}`, `${PUBLIC_HOST}:443`, `${PUBLIC_HOST}.`, '', '127.0.0.1:1',
  ]) {
    await t.test(`reject Host ${JSON.stringify(host)}`, async () => {
      const response = await boundaryRequest(base, {
        host, origin: `https://${PUBLIC_HOST}`,
        forwarded: { 'X-Forwarded-Host': PUBLIC_HOST, 'X-Forwarded-Proto': 'https', Forwarded: `host=${PUBLIC_HOST};proto=https` },
      });
      assert.equal(response.status, 403);
      assert.equal(JSON.parse(response.body).error.code, 'INVALID_HOST');
    });
  }
});

test('HTTP boundary binds Origin to the actual allowed Host and exact scheme', async t => {
  const { base } = await setup(t, () => { throw new Error('Rejected origins must not call RPC'); });
  const port = new URL(base).port;
  const cases = [
    [PUBLIC_HOST, `http://${PUBLIC_HOST}`],
    [PUBLIC_HOST, `https://other.${PUBLIC_HOST}`],
    [PUBLIC_HOST, `https://${PUBLIC_HOST}.evil.example`],
    [PUBLIC_HOST, `https://${PUBLIC_HOST}:443`],
    [PUBLIC_HOST, `https://${PUBLIC_HOST}/`],
    [PUBLIC_HOST, 'https://evil.example'],
    [PUBLIC_HOST, 'null'],
    [PUBLIC_HOST, ''],
    [PUBLIC_HOST, `http://127.0.0.1:${port}`],
    [`127.0.0.1:${port}`, `https://${PUBLIC_HOST}`],
    [`localhost:${port}`, `https://${PUBLIC_HOST}`],
    [`127.0.0.1:${port}`, `http://localhost:${port}`],
    [`localhost:${port}`, `http://127.0.0.1:${port}`],
    [`127.0.0.1:${port}`, `https://127.0.0.1:${port}`],
  ];
  for (const [host, origin] of cases) {
    await t.test(`reject ${JSON.stringify(origin)} on ${host}`, async () => {
      const response = await boundaryRequest(base, { host, origin, forwarded: { 'X-Forwarded-Host': PUBLIC_HOST, 'X-Forwarded-Proto': 'https' } });
      assert.equal(response.status, 403);
      assert.equal(JSON.parse(response.body).error.code, 'INVALID_ORIGIN');
    });
  }
});

test('only the root embed document permits same-origin framing', async t => {
  const { base } = await setup(t, () => { throw new Error('Embedding must not call RPC'); });
  const host = new URL(base).host;
  for (const path of ['/', '/?embed=0', '/?embed=01', '/?embed=true', '/api/health?embed=1']) {
    const response = await boundaryRequest(base, { host, path });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(response.headers['content-security-policy'], /frame-src 'self'/);
  }
  for (const embedHost of [host, PUBLIC_HOST]) {
    const response = await boundaryRequest(base, { host: embedHost, path: '/?embed=1' });
    assert.equal(response.status, 200);
    assert.match(response.body, /id="website-view"/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'self'/);
    assert.match(response.headers['content-security-policy'], /frame-src 'self'/);
    assert.doesNotMatch(response.headers['content-security-policy'], /frame-(?:ancestors|src) [^;]*\*/);
  }
});
