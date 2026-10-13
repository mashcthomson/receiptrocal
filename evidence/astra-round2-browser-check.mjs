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
const report = { startedAt: new Date().toISOString(), checks: [], views: [], preview: [] };
const storageKey = 'payment-desk.display-view.v1';
await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable');
const contrastFunction = `(function(doc) {
 const style=e=>doc.defaultView.getComputedStyle(e);
 const rgba=c=>c.match(/[\\d.]+/g).map(Number);
 const blend=(front,back)=>{ const a=front[3]??1;return front.slice(0,3).map((v,i)=>v*a+back[i]*(1-a)); };
 const luminance=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const output=[];
 for(const e of doc.querySelectorAll('body *')) {
  if(!e.getClientRects().length || e.closest('.sr-only') || ![...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())) continue;
  const st=style(e);if(st.visibility==='hidden')continue;
  const chain=[];for(let n=e;n;n=n.parentElement)chain.unshift(n);
  let bg=[255,255,255];for(const n of chain)bg=blend(rgba(style(n).backgroundColor),bg);
  const fg=blend(rgba(st.color),bg);const l=[luminance(fg),luminance(bg)].sort((a,b)=>b-a);const ratio=(l[0]+.05)/(l[1]+.05);
  const large=parseFloat(st.fontSize)>=24 || (parseFloat(st.fontSize)>=18.66 && parseInt(st.fontWeight)>=700);
  const required=large?3:4.5;
  output.push({text:e.textContent.trim().slice(0,60),ratio:Number(ratio.toFixed(2)),required});
 }
 return {checked:output.length,failures:output.filter(r=>r.ratio<r.required),minimum:Math.min(...output.map(r=>r.ratio))};
})`;
async function contrast(doc='document') {const r=await js(`${contrastFunction}(${doc})`);assert.deepEqual(r.failures,[]);return r;}
const isHidden=selector=>js(`document.querySelector(${JSON.stringify(selector)}).getClientRects().length===0`);
for (const theme of ['light','dark']) {
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
  for(const [width,height] of [[1440,900],[390,844],[360,800]]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await js(`localStorage.removeItem(${JSON.stringify(storageKey)})`);
    await cdp('Page.navigate',{url:origin});
    await until(`document.querySelectorAll('#demo-rows .row-btn').length===6`);
    assert.equal(await js(`matchMedia('(prefers-color-scheme: dark)').matches`),theme==='dark');
    assert.equal(await isHidden('.view-switch'),width<=600);
    assert.equal(await js(`document.querySelectorAll('[data-mode-tab]').length`),2,'Only original two mode tabs');
    const l=await layout();assert.ok(l.scrollWidth<=width);assert.deepEqual(l.undersized,[]);
    assert.equal(await js(`document.querySelector('.footer-links a').href`),'https://github.com/mashcthomson/receiptrocal');
    assert.equal(await js(`document.querySelector('.how-it-works').children.length`),3);
    await shot(`round2-astra-${theme}-${width}-initial.png`);
    await click('#demo-run-all');
    await until(`document.querySelectorAll('#demo-rows .agree').length===6&&!document.querySelector('#demo-run-all').disabled&&!!document.querySelector('.verdict-matched')`);
    if(width>600) await js('scrollTo(0,0)');
    await shot(`round2-astra-${theme}-${width}-result.png`);
    const c=await contrast();
    for(const [id,status] of [['underpaid','mismatch'],['duplicate','duplicate'],['unavailable','needs_review']]) {
      await click(`[data-case="${id}"] .row-btn`);await until(`!!document.querySelector('.verdict-${status}')`);await contrast();
      if(id==='underpaid') { if(width>600)await js('scrollTo(0,0)');await shot(`round2-astra-${theme}-${width}-mismatch.png`); }
      const v=await layout();assert.ok(v.scrollWidth<=width);assert.deepEqual(v.undersized,[]);
    }
    await click('.raw summary');const raw=await layout();assert.ok(raw.scrollWidth<=width);
    await js('scrollTo(0,document.documentElement.scrollHeight)');await shot(`round2-astra-${theme}-${width}-footer.png`);
    await click('#tab-live');await click('#live-submit');await until(`document.querySelectorAll('[aria-invalid="true"]').length===4`);
    assert.equal(await js('document.activeElement.id'),'f-id');await contrast();
    await click('#live-clear');await until(`document.querySelectorAll('[aria-invalid="true"]').length===0`);
    await js('scrollTo(0,0)');await shot(`round2-astra-${theme}-${width}-live.png`);
    report.views.push({theme,width,height,layout:l,contrast:c,checks:['all six demo results','status contrast','exact footer link','three-step workflow','no duplicate tabs','live validation/reset','raw evidence overflow']});
  }
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:origin});await until(`document.querySelectorAll('#demo-rows .row-btn').length===6`);
  await js(`document.querySelector('[data-view="phone"]').focus()`);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(`document.querySelector('#phone-app').contentDocument?.querySelectorAll('#demo-rows .row-btn').length===6`);
  const embedded=await js(`(() => {const f=document.querySelector('#phone-app');const d=f.contentDocument;return {width:f.contentWindow.innerWidth,height:f.contentWindow.innerHeight,embed:d.body.dataset.embed,switchHidden:!d.querySelector('.view-switch').getClientRects().length,frameHidden:!d.querySelector('#phone-preview').getClientRects().length,nestedLoadedFrames:d.querySelectorAll('iframe[src]').length,mobileQueries:f.contentWindow.matchMedia('(max-width: 520px)').matches,dark:f.contentWindow.matchMedia('(prefers-color-scheme: dark)').matches,src:f.getAttribute('src'),selected:document.querySelector('[data-view="phone"]').getAttribute('aria-pressed'),websiteHidden:document.querySelector('#website-view').hidden};})()`);
  assert.equal(embedded.width,390);assert.equal(embedded.height,844);assert.equal(embedded.embed,'true');assert.equal(embedded.switchHidden,true);assert.equal(embedded.frameHidden,true);assert.equal(embedded.nestedLoadedFrames,0);assert.equal(embedded.mobileQueries,true);assert.equal(embedded.dark,theme==='dark');assert.equal(embedded.selected,'true');assert.equal(embedded.websiteHidden,true);
  await contrast(`document.querySelector('#phone-app').contentDocument`);
  await shot(`round2-astra-${theme}-phone-preview.png`);
  await js(`document.querySelector('#phone-app').contentWindow.scrollTo(0,500)`);
  assert.ok(await js(`document.querySelector('#phone-app').contentWindow.scrollY>0`),'Embedded scroll remains usable with hidden scrollbar');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:700,deviceScaleFactor:1,mobile:false});
  const shortFrame=await js(`(() => {const f=document.querySelector('.phone-frame').getBoundingClientRect();return {top:f.top,bottom:f.bottom,width:document.querySelector('#phone-app').contentWindow.innerWidth,height:document.querySelector('#phone-app').contentWindow.innerHeight};})()`);
  assert.ok(shortFrame.top>=0&&shortFrame.bottom<=700);assert.equal(shortFrame.width,390);assert.equal(shortFrame.height,644);
  await shot(`round2-astra-${theme}-phone-preview-short.png`);
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await cdp('Page.reload');await until(`document.body.dataset.preview==='phone'&&document.querySelector('#phone-app').contentDocument?.querySelectorAll('#demo-rows .row-btn').length===6`);
  assert.equal(await js(`localStorage.getItem(${JSON.stringify(storageKey)})`),'phone');
  await js(`document.querySelector('#phone-app').contentDocument.querySelector('#demo-run-all').click()`);
  await until(`!!document.querySelector('#phone-app').contentDocument.querySelector('.verdict-matched')`);
  await shot(`round2-astra-${theme}-phone-preview-result.png`);
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  await cdp('Page.reload');await until(`document.querySelectorAll('#demo-rows .row-btn').length===6`);
  assert.equal(await isHidden('.view-switch'),true);assert.equal(await js(`document.querySelector('#website-view').hidden`),false);
  assert.equal(await js(`document.querySelector('#phone-app').hasAttribute('src')`),false,'Remembered Phone choice ignored on a real phone');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await until(`document.body.dataset.preview==='phone'`);
  await click('[data-view="website"]');assert.equal(await js(`document.querySelector('#website-view').hidden`),false);
  assert.equal(await js(`localStorage.getItem(${JSON.stringify(storageKey)})`),'website');
  await cdp('Page.reload');await until(`document.body.dataset.preview==='website'`);
  report.preview.push({theme,...embedded,keyboard:'Enter',persistence:'both choices reload correctly',realPhone:'switch hidden; remembered Phone ignored; no iframe load',iframeDemo:'matched synthetic verdict rendered inside frame',shortViewport:'390x644 iframe fits 700px window',scrollbar:'hidden in embed; scrolling verified'});
}
// Simulate storage denial on every new document without modifying product code.
const injection=await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`Storage.prototype.getItem=function(){throw new DOMException('Test storage denial','SecurityError')};Storage.prototype.setItem=function(){throw new DOMException('Test storage denial','SecurityError')};`});
await cdp('Page.navigate',{url:origin});await until(`document.querySelectorAll('#demo-rows .row-btn').length===6`);
await click('[data-view="phone"]');await until(`document.querySelector('#phone-app').contentDocument?.querySelectorAll('#demo-rows .row-btn').length===6`);
await click('[data-view="website"]');assert.equal(await js(`document.body.dataset.preview`),'website');
await cdp('Page.removeScriptToEvaluateOnNewDocument',{identifier:injection.identifier});
report.checks.push('Storage denial does not break Website/Phone switching or embedded boot');
assert.deepEqual(exceptions,[]);report.exceptions=exceptions;
assert.ok(requests.every(url=>url.startsWith(origin)||url.startsWith('blob:'+origin)||url.startsWith('data:')));
report.pageRequestOrigins=[...new Set(requests.filter(u=>!u.startsWith('data:')).map(u=>new URL(u).origin))];
report.completedAt=new Date().toISOString();
await writeFile(new URL('astra-round2-browser-check.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));ws.close();
