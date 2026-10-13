import { writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin = 'http://127.0.0.1:4322';
const pages = await (await fetch('http://127.0.0.1:9322/json')).json();
const target = pages.find(p => p.type === 'page' && p.url.startsWith(origin));
assert.ok(target, 'Isolated local preview tab exists');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let next = 0;
const pending = new Map();
const exceptions = [];
const requests = [];
let simulateRpcFailure = false;
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
  }
  if (msg.method === 'Fetch.requestPaused' && simulateRpcFailure) {
    cdp('Fetch.fulfillRequest', { requestId: msg.params.requestId, responseCode: 502, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: { code: 'RPC_NETWORK_ERROR', message: 'Simulated RPC failure for browser validation.' } })).toString('base64') });
  }
  if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails);
  if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
};
function cdp(method, params = {}) { return new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function until(expression) {
  for (let i = 0; i < 100; i++) { if (await js(expression)) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`Timed out: ${expression}`);
}
async function click(selector) { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function shot(name) { const r = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(new URL(name, import.meta.url), Buffer.from(r.data, 'base64')); }
async function layout() { return js(`(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, resultLive: document.querySelector('#result').getAttribute('aria-live'), undersized: [...document.querySelectorAll('button,input,select,summary,a')].filter(e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden' && !e.classList.contains('skip')).map(e=>({text: e.textContent.trim().slice(0,70), width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})).filter(e=>e.width<44 || e.height<44) }))()`); }
const report = { startedAt: new Date().toISOString(), checks: [], layouts: [] };
await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable');
await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/home/mash/mac/laptop-work/rr-redesign-astra/evidence', eventsEnabled: true });
for (const [width, height] of [[1440,900],[390,844],[360,800]]) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: origin });
  await until(`document.querySelectorAll('#demo-rows .row-btn').length === 6`);
  assert.equal(await js('document.title'), 'Receiptrocal');
  let measurements = await layout(); assert.ok(measurements.scrollWidth <= measurements.width); assert.deepEqual(measurements.undersized, []);
  report.layouts.push({ view:'initial', ...measurements });
  if (width===1440) await shot('redesign-astra-initial-desktop.png');
  if (width===390) await shot('redesign-astra-mobile.png');
  await click('#demo-run-all');
  await until(`document.querySelectorAll('#demo-rows .agree').length===6 && !document.querySelector('#demo-run-all').disabled && !!document.querySelector('.verdict-matched')`);
  assert.match(await js(`document.querySelector('#result').innerText`), /SYNTHETIC FIXTURE/);
  if(width===1440) { await js('scrollTo(0,0)'); await shot('redesign-astra-desktop.png'); }
  if(width===390) await shot('redesign-astra-mobile-result.png');
  for(const [id,status] of [['underpaid','mismatch'],['wrong-recipient','mismatch'],['duplicate','duplicate'],['failed','mismatch'],['unavailable','needs_review'],['paid','matched']]) {
    await click(`[data-case="${id}"] .row-btn`);
    await until(`!!document.querySelector('.verdict-${status}')`);
    assert.match(await js(`document.querySelector('#result').innerText`), /SYNTHETIC FIXTURE/);
    const m=await layout();assert.ok(m.scrollWidth<=m.width);assert.deepEqual(m.undersized,[]);
    if(id==='underpaid') {
      assert.match(await js(`document.querySelector('.amounts').innerText`), /0\.499999999 SOL/);
      if(width===1440) {await js('scrollTo(0,0)');await shot('redesign-astra-desktop-mismatch.png');}
    }
  }
  await click('.raw summary');
  let m=await layout();assert.ok(m.scrollWidth<=m.width); report.layouts.push({view:'expanded evidence',...m});
  await click('.raw summary');
  if(width===1440) {
    await click('#result .actions .btn-primary');
    await until(`document.querySelector('.verdict-matched')!==null`);
    await cdp('Browser.grantPermissions', { permissions:['clipboardReadWrite','clipboardSanitizedWrite'], origin });
    await click('#result .actions .btn-ghost');
    const copied=await js('navigator.clipboard.readText()');
    const exported=JSON.parse(copied);assert.equal(exported.synthetic,true);assert.equal(exported.result.status,'matched');assert.equal(exported.tool,'Receiptrocal');
    report.checks.push('Evidence copy JSON contains synthetic notice and unchanged machine verdict');
  }
  await click('#tab-live');
  assert.equal(await js(`document.querySelector('#panel-demo').hidden`),true);
  assert.equal(await js(`document.querySelector('.verdict')===null`),true);
  await click('#live-submit');
  await until(`document.querySelectorAll('[aria-invalid="true"]').length===4`);
  assert.equal(await js('document.activeElement.id'),'f-id');
  await click('#live-clear');
  await until(`document.querySelectorAll('[aria-invalid="true"]').length===0`);
  m=await layout();assert.ok(m.scrollWidth<=m.width);assert.deepEqual(m.undersized,[]);report.layouts.push({view:'live form',...m});
  await js('scrollTo(0,0)');
  if(width===390) await shot('redesign-astra-mobile-live.png');
  if(width===1440) await shot('redesign-astra-desktop-live.png');
  report.checks.push(`${width}x${height}: six demo verdicts, run all, exact lamport display, raw evidence, mode isolation, empty form validation, reset, overflow and touch targets`);
}
// Keyboard navigation and deterministic error rendering. No external RPC request is made.
await cdp('Emulation.setDeviceMetricsOverride', { width:1440, height:900, deviceScaleFactor:1, mobile:false });
await cdp('Page.navigate', { url: origin });
await until(`document.querySelectorAll('#demo-rows .row-btn').length === 6`);
await js(`document.querySelector('#tab-demo').focus()`);
await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowRight',code:'ArrowRight'});
assert.equal(await js('document.activeElement.id'),'tab-live');
assert.equal(await js(`document.querySelector('#tab-live').getAttribute('aria-selected')`),'true');
await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:'Home',code:'Home'});
assert.equal(await js('document.activeElement.id'),'tab-demo');
await js(`document.querySelector('[data-case="paid"] .row-btn').focus()`);
await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
await cdp('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
await until(`!!document.querySelector('.verdict-matched')`);
assert.equal(await js(`document.activeElement.closest('[data-case]')?.dataset.case`),'paid');
report.checks.push('Keyboard arrows/Home switch tabs; Enter selects a case and focus survives async rerender');
const download=JSON.parse(await readFile(new URL('receiptrocal-DEMO-INV-1001.json',import.meta.url)));
assert.equal(download.synthetic,true);assert.equal(download.result.status,'matched');
report.checks.push('Actual evidence download saved and parsed, with synthetic notice');
// Measure text contrast against composited solid ancestor backgrounds.
const contrast = await js(`(() => {
 const rgba=c=>c.match(/[\\d.]+/g).map(Number);
 const blend=(front,back)=>{ const a=front[3]??1;return front.slice(0,3).map((v,i)=>v*a+back[i]*(1-a)); };
 const luminance=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const output=[];
 for(const e of document.querySelectorAll('body *')) {
  if(!e.getClientRects().length || e.closest('.sr-only') || ![...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())) continue;
  const st=getComputedStyle(e);if(st.visibility==='hidden')continue;
  const chain=[];for(let n=e;n;n=n.parentElement)chain.unshift(n);
  let bg=[255,255,255];for(const n of chain)bg=blend(rgba(getComputedStyle(n).backgroundColor),bg);
  const fg=blend(rgba(st.color),bg);const l=[luminance(fg),luminance(bg)].sort((a,b)=>b-a);const ratio=(l[0]+.05)/(l[1]+.05);
  const large=parseFloat(st.fontSize)>=24 || (parseFloat(st.fontSize)>=18.66 && parseInt(st.fontWeight)>=700);
  const required=large?3:4.5;
  output.push({text:e.textContent.trim().slice(0,60),ratio:Number(ratio.toFixed(2)),required});
 }
 return {checked:output.length,failures:output.filter(r=>r.ratio<r.required),minimum:Math.min(...output.map(r=>r.ratio))};
})()`);
assert.deepEqual(contrast.failures,[]);report.contrast=contrast;
await click('#tab-live');
const fixtures=JSON.parse(await readFile(new URL('../app/fixtures/demo.json',import.meta.url)));const paid=fixtures.find(f=>f.id==='paid');
await js(`(() => {const f=document.querySelector('#live-form'); f.id.value=${JSON.stringify(paid.invoice.id)}; f.recipient.value=${JSON.stringify(paid.invoice.recipient)}; f.amountLamports.value=${JSON.stringify(paid.invoice.amountLamports)}; f.signature.value=${JSON.stringify(paid.evidence.signature)}; f.cluster.value='devnet'; f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
simulateRpcFailure=true;
await cdp('Fetch.enable',{patterns:[{urlPattern:origin+'/api/verify',requestStage:'Request'}]});
await click('#live-submit');
await until(`document.querySelector('#live-error').innerText.includes('RPC_NETWORK_ERROR')`);
assert.equal(await js(`document.querySelector('.verdict')===null`),true);
assert.match(await js(`document.querySelector('#result').innerText`),/No verdict recorded/);
assert.match(await js(`document.querySelector('#live-rows').innerText`),/Error/);
await cdp('Fetch.disable');simulateRpcFailure=false;
report.checks.push('Simulated RPC 502 remains an error in form and history, with no verdict and no fixture fallback');
await js('scrollTo(0,0)');await shot('redesign-astra-live-error.png');
assert.deepEqual(exceptions,[]);
assert.ok(requests.every(url=>url.startsWith(origin)||url.startsWith('blob:'+origin)||url.startsWith('data:')), 'No external page network requests');
report.exceptions=exceptions;report.pageRequestOrigins=[...new Set(requests.filter(u=>!u.startsWith('data:')).map(u=>new URL(u).origin))];report.completedAt=new Date().toISOString();
await writeFile(new URL('astra-browser-check.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));ws.close();
