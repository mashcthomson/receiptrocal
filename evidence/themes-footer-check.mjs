import { writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin = 'http://127.0.0.1:4323';
const target = await (await fetch('http://127.0.0.1:9322/json/new?' + encodeURIComponent(origin), {method:'PUT'})).json();
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
async function contrast(doc='document') {await new Promise(r=>setTimeout(r,200));const r=await js(`${contrastFunction}(${doc})`);assert.deepEqual(r.failures,[]);return r;}
const isHidden=selector=>js(`document.querySelector(${JSON.stringify(selector)}).getClientRects().length===0`);

const report={startedAt:new Date().toISOString(),views:[],checks:[]};
await cdp('Runtime.enable');await cdp('Page.enable');await cdp('Network.enable');

for(const theme of ['current','sage','colosseum']) {
 for(const width of [390,360]) {
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:origin+'/?theme='+theme});await until(`document.querySelectorAll('#demo-rows .row-btn').length===6`);
  assert.equal(await js(`getComputedStyle(document.querySelector('.theme-switch')).position`),'static');
  await click('#demo-run-all');await until(`document.querySelectorAll('#demo-rows .agree').length===6&&!document.querySelector('#demo-run-all').disabled`);
  const reason=await js(`(()=>{const picker=document.querySelector('.theme-switch').getBoundingClientRect();return {pickerTop:picker.top,mainBottom:document.querySelector('main').getBoundingClientRect().bottom,footerBottom:document.querySelector('.foot').getBoundingClientRect().bottom}})()`);
  assert.ok(reason.pickerTop>=reason.mainBottom&&reason.pickerTop>=reason.footerBottom);
  await js('scrollTo(0,document.documentElement.scrollHeight)');
  const l=await layout();assert.ok(l.scrollWidth<=width);assert.deepEqual(l.undersized,[]);
  const c=await contrast();
  await shot(`themes-${theme}-${width}-footer.png`);
  report.views.push({theme,width,layout:l,contrast:c,flow:reason});
 }
}
assert.deepEqual(exceptions,[]);report.exceptions=exceptions;report.completedAt=new Date().toISOString();
await writeFile(new URL('themes-footer-check.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));ws.close();
