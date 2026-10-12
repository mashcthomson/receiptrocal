import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
