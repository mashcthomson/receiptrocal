// Payment verification browser desk. Buildless ESM, no dependencies.
// The server is the authority for verdicts. This file never fabricates a match.

const PRODUCT_NAME = 'Receiptrocal';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const REQUEST_TIMEOUT_MS = 20000;
const LEDGER_KEY = 'receiptrail.ledger.v1';
const DEFAULT_LIMITATIONS = [
  'SOL transfers only. Unsupported transaction types require manual review.',
  'Live results trust the selected Solana RPC endpoint; they are not cryptographic proofs.',
  'Duplicate protection is local to this server process and this browser session.',
  'Synthetic demo fixtures do not establish any onchain payment.',
];

const STATUS_COPY = {
  matched: { label: 'Matched', title: 'Payment matched', icon: 'check', line: 'This transaction settles the invoice.' },
  mismatch: { label: 'Mismatch', title: 'Payment mismatch', icon: 'cross', line: 'This transaction does not settle the invoice.' },
  duplicate: { label: 'Duplicate', title: 'Receipt already used', icon: 'repeat', line: 'This signature already settled a different invoice.' },
  needs_review: { label: 'Needs review', title: 'Needs review', icon: 'review', line: 'The evidence needs a manual check before this invoice can be settled.' },
};

const MODE_COPY = {
  demo: { title: 'Synthetic demo', sub: 'Fixtures only. Not onchain verification.' },
  live: { title: 'Live RPC', sub: 'Read-only. Finalized Solana data.' },
};

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  mode: 'demo',
  cases: [],
  demoResults: new Map(),
  selectedCase: null,
  liveRuns: [],
  current: null,
  limitations: DEFAULT_LIMITATIONS,
  busy: false,
};

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Local, decorative SVGs. Status text carries the accessible meaning.
function icon(name) {
  const paths = {
    check: 'm5 12 4 4L19 6',
    cross: 'm6 6 12 12M6 18 18 6',
    repeat: 'M5 8h11l-3-3m3 3-3 3M19 16H8l3 3m-3-3 3-3',
    review: 'M12 7v6m0 4h.01M12 3 2 21h20L12 3Z',
    receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6m-6 4h6',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[name] || paths.review);
  svg.append(path);
  return svg;
}

function revealResult() {
  if (!window.matchMedia('(max-width: 800px)').matches) return;
  const heading = $('#result-heading');
  heading.focus({ preventScroll: true });
  heading.closest('.col-result').scrollIntoView({ behavior: 'auto', block: 'start' });
}

export function lamportsToSol(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
  const text = String(value);
  if (!/^-?\d+$/.test(text)) return null;
  const negative = text.startsWith('-');
  const digits = (negative ? text.slice(1) : text).padStart(10, '0');
  const whole = digits.slice(0, -9).replace(/^0+(?=\d)/, '');
  const frac = digits.slice(-9).replace(/0+$/, '');
  return `${negative ? '-' : ''}${Number(whole).toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
}

function groupDigits(value) {
  return /^\d+$/.test(String(value)) ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(value);
}

function short(value, head = 6, tail = 6) {
  if (typeof value !== 'string') return '';
  return value.length > head + tail + 3 ? `${value.slice(0, head)}...${value.slice(-tail)}` : value;
}

function formatTime(unix) {
  if (!Number.isFinite(unix)) return null;
  const d = new Date(unix * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${String(d.getFullYear()).slice(-2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function nowLabel() {
  return formatTime(Math.floor(Date.now() / 1000));
}

function base58Length(text) {
  if (!BASE58.test(text)) return -1;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of text) n = n * 58n + BigInt(alphabet.indexOf(ch));
  let bytes = 0;
  while (n > 0n) { n >>= 8n; bytes++; }
  for (const ch of text) { if (ch === '1') bytes++; else break; }
  return bytes;
}

function statusBadge(status, extra = '') {
  const copy = STATUS_COPY[status];
  return el('span', { class: `badge badge-${copy ? status : 'unknown'} ${extra}`.trim() }, copy ? copy.label : (status || 'Unknown'));
}

function readLedger() {
  try { return JSON.parse(sessionStorage.getItem(LEDGER_KEY) || '{}') || {}; }
  catch { return {}; }
}

function writeLedger(ledger) {
  try { sessionStorage.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch { /* storage unavailable */ }
}

// ---------- network ----------

class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new ApiError('TIMEOUT', `No response from the local server within ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    throw new ApiError('NETWORK', `Cannot reach the local ${PRODUCT_NAME} server. Is it still running?`);
  } finally {
    clearTimeout(timer);
  }
  let payload = null;
  try { payload = await response.json(); }
  catch { throw new ApiError('BAD_RESPONSE', `Server answered ${response.status} without valid JSON.`, response.status); }
  if (!response.ok || payload?.error) {
    const err = payload?.error || {};
    throw new ApiError(err.code || `HTTP_${response.status}`, err.message || `Request failed with status ${response.status}.`, response.status);
  }
  return payload;
}

// ---------- mode switching ----------

function setMode(mode, { focus = false } = {}) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  for (const tab of document.querySelectorAll('[data-mode-tab]')) {
    const active = tab.dataset.modeTab === mode;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  }
  $('#panel-demo').hidden = mode !== 'demo';
  $('#panel-live').hidden = mode !== 'live';
  $('#mode-title').textContent = MODE_COPY[mode].title;
  $('#mode-sub').textContent = MODE_COPY[mode].sub;
  // Never leave a receipt from the other mode on screen without its own banner.
  if (state.current && state.current.mode !== mode) renderPlaceholder();
  else if (state.current) renderResult(state.current);
  else renderPlaceholder();
  const back = $('.back-to-input');
  back.href = mode === 'demo' ? '#panel-demo' : '#panel-live';
  back.textContent = mode === 'demo' ? 'Back to cases' : 'Back to payment details';
}

function initTabs() {
  const tabs = [...document.querySelectorAll('[data-mode-tab]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => setMode(tab.dataset.modeTab));
    tab.addEventListener('keydown', event => {
      const i = tabs.indexOf(tab);
      let next = null;
      if (event.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      else if (event.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (event.key === 'Home') next = tabs[0];
      else if (event.key === 'End') next = tabs[tabs.length - 1];
      if (next) { event.preventDefault(); setMode(next.dataset.modeTab, { focus: true }); }
    });
  }
}

// ---------- error rendering ----------

function renderError(slot, error, context) {
  const target = $(slot);
  target.replaceChildren(
    el('div', { class: 'error-card', role: 'alert' },
      el('p', { class: 'error-title' }, el('span', { class: 'code' }, error.code || 'ERROR'), ' ', context),
      el('p', {}, error.message || 'Unknown error.'),
      el('p', { class: 'muted' }, 'No verdict was recorded. Nothing has been marked as paid.'),
    ),
  );
}

function clearError(slot) {
  $(slot).replaceChildren();
}

// ---------- demo ----------

async function loadDemo() {
  clearError('#demo-error');
  try {
    const cases = await api('/api/demo');
    if (!Array.isArray(cases)) throw new ApiError('BAD_RESPONSE', 'Demo endpoint did not return a list.');
    state.cases = cases;
    renderDemoRows();
  } catch (error) {
    $('#demo-rows').replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Demo cases unavailable.')));
    renderError('#demo-error', error, 'Could not load demo cases.');
  }
}

function renderDemoRows() {
  const focusedCase = document.activeElement?.closest('[data-case]')?.dataset.case;
  const rows = state.cases.map(item => {
    const inv = item.invoice || {};
    const outcome = state.demoResults.get(item.id);
    const selected = state.selectedCase === item.id;
    let resultCell;
    if (outcome?.pending) resultCell = el('span', { class: 'muted' }, 'Running...');
    else if (outcome?.error) resultCell = el('span', { class: 'badge badge-error' }, 'Error');
    else if (outcome?.result) {
      const agrees = outcome.result.status === item.expectedStatus;
      resultCell = el('span', { class: 'result-cell' },
        statusBadge(outcome.result.status),
        el('span', { class: agrees ? 'agree' : 'disagree', title: agrees ? 'Matches expected status' : 'Differs from expected status' }, agrees ? 'as expected' : 'unexpected'));
    } else resultCell = el('span', { class: 'muted' }, 'Not run');

    return el('tr', { class: selected ? 'selected' : '', 'data-case': item.id },
      el('th', { scope: 'row', 'data-label': 'Case' },
        el('button', {
          class: 'row-btn', type: 'button', 'aria-pressed': String(selected),
          onclick: () => runDemoCase(item.id, { reveal: true }),
        }, el('span', { class: 'row-title' }, item.title || item.id), el('span', { class: 'row-id mono' }, item.id))),
      el('td', { 'data-label': 'Invoice', class: 'mono' }, inv.id || ''),
      el('td', { 'data-label': 'Recipient', class: 'mono', title: inv.recipient || '' }, short(inv.recipient || '', 4, 4)),
      el('td', { 'data-label': 'Amount', class: 'num mono' }, `${lamportsToSol(inv.amountLamports) ?? '?'} SOL`),
      el('td', { 'data-label': 'Expected' }, statusBadge(item.expectedStatus, 'badge-outline')),
      el('td', { 'data-label': 'Result' }, resultCell),
    );
  });
  $('#demo-rows').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No demo cases found.'))]));
  if (focusedCase) $(`[data-case="${CSS.escape(focusedCase)}"] .row-btn`)?.focus({ preventScroll: true });
}

async function runDemoCase(caseId, { show = true, reveal = false } = {}) {
  if (show) {
    state.selectedCase = caseId;
    if (state.mode === 'demo') renderPlaceholder('Checking the synthetic fixture…');
  }
  state.demoResults.set(caseId, { pending: true });
  renderDemoRows();
  clearError('#demo-error');
  try {
    const payload = await api('/api/demo/verify', { method: 'POST', body: { caseId } });
    if (!payload?.result) throw new ApiError('BAD_RESPONSE', 'Server returned no verification result.');
    if (Array.isArray(payload.limitations) && payload.limitations.length) state.limitations = payload.limitations;
    const fixture = state.cases.find(c => c.id === caseId);
    const record = {
      mode: 'demo',
      caseId,
      title: fixture?.title || caseId,
      expectedStatus: fixture?.expectedStatus,
      invoice: payload.invoice || fixture?.invoice,
      evidence: payload.evidence ?? null,
      result: payload.result,
      limitations: state.limitations,
      checkedAt: new Date().toISOString(),
    };
    state.demoResults.set(caseId, { result: payload.result, record });
    if (show && state.mode === 'demo' && state.selectedCase === caseId) {
      state.current = record;
      renderResult(record);
      if (reveal) revealResult();
    }
  } catch (error) {
    state.demoResults.set(caseId, { error });
    renderError('#demo-error', error, `Demo case "${caseId}" failed.`);
    if (show && state.selectedCase === caseId && state.mode === 'demo') renderPlaceholder('The fixture check failed. See the error beside the case list.', 'No verdict recorded.');
  }
  renderDemoRows();
}

async function runAllDemo() {
  const button = $('#demo-run-all');
  button.disabled = true;
  try {
    for (const [index, item] of state.cases.entries()) {
      button.textContent = `Running ${index + 1} / ${state.cases.length}`;
      await runDemoCase(item.id, { show: false });
    }
    const first = state.selectedCase || state.cases[0]?.id;
    if (first) await runDemoCase(first, { reveal: true });
  } finally {
    button.disabled = false;
    button.textContent = 'Run all cases';
  }
}

// ---------- live ----------

function validateLive(form) {
  const errors = [];
  const id = form.id.value.trim();
  const recipient = form.recipient.value.trim();
  const amount = form.amountLamports.value.trim().replace(/[,_\s]/g, '');
  const notBeforeRaw = form.notBefore.value.trim();
  const signature = form.signature.value.trim();
  const cluster = form.cluster.value;

  if (!id) errors.push(['id', 'Invoice ID is required.']);
  else if (id.length > 120) errors.push(['id', 'Invoice ID must be 120 characters or fewer.']);
  if (base58Length(recipient) !== 32) errors.push(['recipient', 'Recipient must be a base58 Solana address (32 bytes).']);
  if (!/^[1-9]\d{0,19}$/.test(amount)) errors.push(['amountLamports', 'Amount must be a positive whole number of lamports.']);
  let notBefore;
  if (notBeforeRaw) {
    if (!/^\d{1,15}$/.test(notBeforeRaw)) errors.push(['notBefore', 'Not before must be Unix seconds, or left blank.']);
    else notBefore = Number(notBeforeRaw);
  }
  if (base58Length(signature) !== 64) errors.push(['signature', 'Signature must be base58 and decode to 64 bytes.']);
  if (!['mainnet-beta', 'devnet'].includes(cluster)) errors.push(['cluster', 'Choose mainnet-beta or devnet.']);

  const invoice = { id, recipient, amountLamports: amount };
  if (notBefore !== undefined) invoice.notBefore = notBefore;
  return { errors, invoice, signature, cluster };
}

function showFormErrors(form, errors) {
  for (const input of form.querySelectorAll('input, select')) {
    input.removeAttribute('aria-invalid');
  }
  const box = $('#live-form-errors');
  if (!errors.length) { box.replaceChildren(); return; }
  for (const [name] of errors) form[name]?.setAttribute('aria-invalid', 'true');
  box.replaceChildren(el('ul', {}, errors.map(([, msg]) => el('li', {}, msg))));
  form[errors[0][0]]?.focus();
}

function updateHints(form) {
  const amount = form.amountLamports.value.trim().replace(/[,_\s]/g, '');
  $('#f-amount-hint').textContent = /^[1-9]\d{0,19}$/.test(amount)
    ? `= ${lamportsToSol(amount)} SOL (${groupDigits(amount)} lamports)`
    : 'Whole lamports. 1 SOL = 1,000,000,000.';
  const nb = form.notBefore.value.trim();
  $('#f-notbefore-hint').textContent = /^\d{1,15}$/.test(nb)
    ? `Rejects payments before ${formatTime(Number(nb))} (your local time).`
    : 'Payments earlier than this are rejected.';
}

async function submitLive(event) {
  event.preventDefault();
  if (state.busy) return;
  const form = event.currentTarget;
  const { errors, invoice, signature, cluster } = validateLive(form);
  showFormErrors(form, errors);
  clearError('#live-error');
  if (errors.length) return;

  // Browser session ledger: one matched signature settles one invoice in this tab session.
  const ledger = readLedger();
  const key = `${cluster}:${signature}`;
  if (ledger[key] && ledger[key] !== invoice.id) {
    renderPlaceholder('This receipt was already used. See the duplicate warning beside the form.', 'Receipt already used.');
    renderError('#live-error',
      new ApiError('BROWSER_DUPLICATE', `This signature already settled invoice "${ledger[key]}" in this browser session on ${cluster}.`),
      'Duplicate receipt blocked locally.');
    addLiveRun({ invoice, signature, cluster, status: 'duplicate', note: 'browser ledger' });
    return;
  }

  const button = $('#live-submit');
  renderPlaceholder('Reading finalized evidence from the selected Solana RPC endpoint…');
  state.busy = true;
  button.disabled = true;
  button.textContent = 'Querying RPC...';
  form.setAttribute('aria-busy', 'true');
  try {
    const payload = await api('/api/verify', { method: 'POST', body: { invoice, signature, cluster } });
    if (!payload?.result) throw new ApiError('BAD_RESPONSE', 'Server returned no verification result.');
    if (Array.isArray(payload.limitations) && payload.limitations.length) state.limitations = payload.limitations;
    if (payload.result.status === 'matched') {
      ledger[key] = invoice.id;
      writeLedger(ledger);
    }
    const record = {
      mode: 'live',
      invoice: payload.invoice || invoice,
      evidence: payload.evidence ?? null,
      result: payload.result,
      limitations: state.limitations,
      checkedAt: new Date().toISOString(),
    };
    addLiveRun({ invoice, signature, cluster, status: payload.result.status, record });
    if (state.mode === 'live') {
      state.current = record;
      renderResult(record);
      revealResult();
    }
  } catch (error) {
    renderError('#live-error', error, 'Live check failed.');
    addLiveRun({ invoice, signature, cluster, status: 'error', note: error.code });
    if (state.mode === 'live') renderPlaceholder('The live check failed. See the RPC error beside the form. No payment verdict was produced.', 'No verdict recorded.');
  } finally {
    state.busy = false;
    button.disabled = false;
    button.textContent = 'Verify against RPC';
    form.removeAttribute('aria-busy');
  }
}

function addLiveRun(run) {
  state.liveRuns.unshift({ ...run, at: nowLabel() });
  const rows = state.liveRuns.map(item => el('tr', {},
    el('td', { 'data-label': 'Time', class: 'mono' }, item.at),
    el('th', { scope: 'row', 'data-label': 'Invoice', class: 'mono' },
      item.record
        ? el('button', { class: 'row-btn', type: 'button', onclick: () => { state.current = item.record; renderResult(item.record); } }, item.invoice.id)
        : item.invoice.id),
    el('td', { 'data-label': 'Signature', class: 'mono', title: item.signature }, short(item.signature)),
    el('td', { 'data-label': 'Cluster' }, item.cluster),
    el('td', { 'data-label': 'Result' },
      item.status === 'error'
        ? el('span', { class: 'badge badge-error', title: item.note || '' }, 'Error')
        : statusBadge(item.status),
      item.note && item.status !== 'error' ? el('span', { class: 'muted small' }, ` ${item.note}`) : null),
  ));
  $('#live-rows').replaceChildren(...rows);
}

// ---------- receipt rendering ----------

function renderPlaceholder(message, title = 'Waiting for a verdict.') {
  state.current = null;
  $('#result').replaceChildren(el('div', { class: 'placeholder' },
    el('div', { class: 'placeholder-icon' }, icon('receipt')),
    el('h3', {}, message ? title : 'Clarity starts with the evidence.'),
    el('p', {}, message || (state.mode === 'demo'
      ? 'Choose a synthetic case to see exactly why a payment matches, fails, or needs a closer look.'
      : 'Enter an invoice and transaction signature to check finalized, read-only Solana data.')),
    el('ol', { class: 'placeholder-steps' },
      el('li', {}, el('span', {}, '01'), el('div', {}, el('strong', {}, 'Compare the payment'), el('p', {}, 'Recipient, amount, execution and previous use.'))),
      el('li', {}, el('span', {}, '02'), el('div', {}, el('strong', {}, 'Understand the decision'), el('p', {}, 'A clear verdict, with the reasons behind it.'))),
      el('li', {}, el('span', {}, '03'), el('div', {}, el('strong', {}, 'Keep the evidence'), el('p', {}, 'Inspect and download the full evidence JSON.'))),
    )));
}

function extractInstructions(tx) {
  const out = [];
  const outer = tx?.transaction?.message?.instructions;
  const inner = tx?.meta?.innerInstructions;
  const push = (ix, where) => {
    if (!ix || typeof ix !== 'object') return;
    const programId = typeof ix.programId === 'string' ? ix.programId : null;
    const parsed = ix.parsed && typeof ix.parsed === 'object' ? ix.parsed : null;
    const info = parsed?.info && typeof parsed.info === 'object' ? parsed.info : {};
    out.push({
      where,
      program: programId === SYSTEM_PROGRAM ? 'System Program' : (ix.program || short(programId || 'unknown', 4, 4)),
      system: programId === SYSTEM_PROGRAM,
      type: parsed?.type || (ix.data ? 'raw' : 'unknown'),
      source: typeof info.source === 'string' ? info.source : null,
      destination: typeof info.destination === 'string' ? info.destination : null,
      lamports: info.lamports !== undefined ? String(info.lamports) : null,
    });
  };
  if (Array.isArray(outer)) outer.forEach((ix, i) => push(ix, `#${i + 1}`));
  if (Array.isArray(inner)) {
    for (const group of inner) {
      if (Array.isArray(group?.instructions)) group.instructions.forEach((ix, j) => push(ix, `#${(group.index ?? 0) + 1}.${j + 1}`));
    }
  }
  return out;
}

function kv(label, value, { mono = false, copy = null } = {}) {
  const dd = el('dd', { class: mono ? 'mono' : '' }, value ?? el('span', { class: 'muted' }, 'n/a'));
  if (copy) dd.append(' ', el('button', { class: 'btn-copy', type: 'button', 'aria-label': `Copy ${label}`, onclick: e => copyText(copy, e.currentTarget) }, 'Copy'));
  return [el('dt', {}, label), dd];
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = old; }, 1200);
  } catch {
    button.textContent = 'Copy failed';
  }
}

function provenance(record) {
  const ev = record.evidence || {};
  if (record.mode === 'demo' || ev.source === 'fixture') {
    return el('div', { class: 'prov prov-demo' },
      el('strong', {}, 'SYNTHETIC FIXTURE'),
      el('span', {}, 'Fabricated for demonstration. This is not onchain verification and proves nothing about any real payment.'));
  }
  const host = ev.cluster === 'devnet' ? 'api.devnet.solana.com' : 'api.mainnet-beta.solana.com';
  return el('div', { class: 'prov prov-live' },
    el('strong', {}, `LIVE RPC: ${ev.cluster || 'unknown cluster'}`),
    el('span', {}, `Read from ${host} at ${ev.fetchedAt || 'unknown time'}, commitment ${ev.commitment || 'unknown'}. Evidence trusts that endpoint.`));
}

function renderResult(record) {
  const r = record.result || {};
  const inv = record.invoice || {};
  const copy = STATUS_COPY[r.status];
  const tx = record.evidence?.transaction ?? null;

  const header = el('div', { class: `verdict verdict-${copy ? r.status : 'unknown'}` },
    el('span', { class: 'verdict-icon' }, icon(copy?.icon)),
    el('div', {},
      el('p', { class: 'verdict-kicker' }, record.mode === 'demo' ? 'Synthetic demo verdict' : 'Live RPC verdict'),
      el('h3', { class: 'verdict-title' }, copy?.title || 'Unknown result'),
      el('p', { class: 'verdict-line' }, copy?.line || 'Unrecognized status from server.'),
      el('p', { class: 'verdict-code mono' }, r.code || '')),
  );

  const expected = r.expectedLamports ?? inv.amountLamports;
  const observed = r.observedLamports;
  const amounts = el('div', { class: 'amounts' },
    el('div', { class: 'amount' },
      el('span', { class: 'amount-label' }, 'Expected'),
      el('span', { class: 'amount-sol' }, `${lamportsToSol(expected) ?? '?'} SOL`),
      el('span', { class: 'amount-lamports mono' }, `${groupDigits(expected ?? '?')} lamports`)),
    el('div', { class: `amount ${observed != null && observed !== expected ? 'amount-off' : ''}` },
      el('span', { class: 'amount-label' }, 'Observed'),
      el('span', { class: 'amount-sol' }, observed != null ? `${lamportsToSol(observed) ?? '?'} SOL` : 'None'),
      el('span', { class: 'amount-lamports mono' }, observed != null ? `${groupDigits(observed)} lamports` : 'no supported transfer to recipient')),
  );

  const reasons = Array.isArray(r.reasons) && r.reasons.length
    ? el('ul', { class: 'reasons' }, r.reasons.map(reason => el('li', {}, String(reason))))
    : el('p', { class: 'muted' }, 'No reasons supplied.');

  const facts = el('dl', { class: 'facts' },
    kv('Invoice', inv.id || r.invoiceId, { mono: true }),
    kv('Recipient', r.recipient || inv.recipient, { mono: true, copy: r.recipient || inv.recipient }),
    kv('Signature', r.signature || record.evidence?.signature, { mono: true, copy: r.signature || record.evidence?.signature }),
    kv('Cluster', r.cluster || record.evidence?.cluster),
    kv('Slot', r.slot != null ? groupDigits(r.slot) : null, { mono: true }),
    kv('Block time', r.blockTime != null ? `${formatTime(r.blockTime)} (${r.blockTime})` : null, { mono: true }),
    kv('Not before', inv.notBefore != null ? `${formatTime(inv.notBefore)} (${inv.notBefore})` : null, { mono: true }),
    record.mode === 'demo' ? kv('Expected status', record.expectedStatus ? STATUS_COPY[record.expectedStatus]?.label || record.expectedStatus : null) : [],
  );

  const instructions = extractInstructions(tx);
  const ixTable = instructions.length
    ? el('div', { class: 'table-wrap' }, el('table', { class: 'ix' },
        el('caption', { class: 'sr-only' }, 'Instructions found in the transaction'),
        el('thead', {}, el('tr', {}, ['Ix', 'Program', 'Type', 'From', 'To', 'Lamports'].map(h => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, instructions.map(ix => el('tr', { class: ix.system && /^transfer/.test(ix.type) ? 'ix-transfer' : '' },
          el('td', { class: 'mono', 'data-label': 'Instruction' }, ix.where),
          el('td', { 'data-label': 'Program' }, ix.program),
          el('td', { class: 'mono', 'data-label': 'Type' }, ix.type),
          el('td', { class: 'mono', 'data-label': 'From', title: ix.source || '' }, ix.source ? short(ix.source, 4, 4) : ''),
          el('td', { class: `mono ${ix.destination && ix.destination === (r.recipient || inv.recipient) ? 'hit' : ''}`, 'data-label': 'To', title: ix.destination || '' }, ix.destination ? short(ix.destination, 4, 4) : ''),
          el('td', { class: 'mono num', 'data-label': 'Lamports' }, ix.lamports ? groupDigits(ix.lamports) : ''),
        )))))
    : el('p', { class: 'muted' }, tx ? 'No instructions in evidence.' : 'No transaction in evidence (not found, or unavailable).');

  const txMeta = tx ? el('p', { class: 'small muted' },
    `Transaction status: ${tx.meta?.err ? 'FAILED ' + JSON.stringify(tx.meta.err) : 'success'}. Signatures: ${Array.isArray(tx.transaction?.signatures) ? tx.transaction.signatures.length : 0}.`) : null;

  const raw = el('details', { class: 'raw' },
    el('summary', {}, 'Raw evidence JSON'),
    el('pre', { class: 'mono', tabindex: 0 }, JSON.stringify(record.evidence, null, 2)));

  const actions = el('div', { class: 'actions' },
    el('button', { class: 'btn btn-primary', type: 'button', onclick: () => downloadRecord(record) }, 'Download evidence JSON'),
    el('button', { class: 'btn btn-ghost', type: 'button', onclick: e => copyText(JSON.stringify(exportRecord(record), null, 2), e.currentTarget) }, 'Copy JSON'),
  );

  $('#result').replaceChildren(
    provenance(record),
    header,
    amounts,
    el('h3', {}, 'Why this verdict'),
    reasons,
    el('h3', {}, 'Receipt details'),
    facts,
    el('h3', {}, 'Transaction evidence'),
    txMeta,
    ixTable,
    el('p', { class: 'small muted' }, 'Highlighted rows are System Program transfers. The verdict above comes from the server verifier, not this table.'),
    raw,
    actions,
  );
  renderLimitations();
}

function renderLimitations() {
  $('#limitations').replaceChildren(...state.limitations.map(text => el('li', {}, text)));
}

// ---------- export ----------

function exportRecord(record) {
  const synthetic = record.mode === 'demo' || record.evidence?.source === 'fixture';
  return {
    tool: PRODUCT_NAME,
    format: 'receiptrail-evidence/v1',
    exportedAt: new Date().toISOString(),
    mode: record.mode,
    synthetic,
    notice: synthetic
      ? 'SYNTHETIC DEMO FIXTURE. Not onchain verification. Proves nothing about any real payment.'
      : 'Live read-only RPC evidence. Trusts the named Solana RPC endpoint. Not a cryptographic proof.',
    demoCase: record.caseId ?? undefined,
    invoice: record.invoice,
    result: record.result,
    evidence: record.evidence,
    limitations: record.limitations || DEFAULT_LIMITATIONS,
  };
}

function downloadRecord(record) {
  const data = exportRecord(record);
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const safeId = String(record.invoice?.id || 'invoice').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
  const a = el('a', { href: url, download: `${PRODUCT_NAME.toLowerCase()}-${data.synthetic ? 'DEMO-' : ''}${safeId}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- colour themes ----------

function initTheme() {
  const key = 'receiptrocal.theme.v1';
  const allowed = new Set(['current', 'sage', 'colosseum']);
  const url = new URL(window.location.href);
  let theme = 'current';
  try { const saved = localStorage.getItem(key); if (allowed.has(saved)) theme = saved; } catch { /* Storage is optional. */ }
  if (allowed.has(url.searchParams.get('theme'))) theme = url.searchParams.get('theme');
  const frame = $('#phone-app');
  const sendToFrame = () => frame?.contentWindow?.postMessage({ type: 'receiptrocal-theme', theme }, window.location.origin);
  const apply = (next, remember = false) => {
    if (!allowed.has(next)) return;
    theme = next;
    document.documentElement.dataset.theme = theme;
    for (const button of document.querySelectorAll('[data-theme-choice]')) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
    if (remember) {
      try { localStorage.setItem(key, theme); } catch { /* Still apply without persistence. */ }
      // A deliberate selection updates a video URL without reloading its evidence.
      const nextUrl = new URL(window.location.href);
      if (nextUrl.searchParams.has('theme')) {
        nextUrl.searchParams.set('theme', theme);
        history.replaceState(null, '', nextUrl);
      }
    }
    sendToFrame();
  };
  for (const button of document.querySelectorAll('[data-theme-choice]')) button.addEventListener('click', () => apply(button.dataset.themeChoice, true));
  frame?.addEventListener('load', sendToFrame);
  window.addEventListener('message', event => {
    if (window.parent !== window && event.source === window.parent && event.origin === window.location.origin && event.data?.type === 'receiptrocal-theme') apply(event.data.theme);
  });
  apply(theme);
}

// ---------- website / phone preview ----------

function initDisplayView() {
  // The embedded document always renders the app, never another phone frame.
  if (new URLSearchParams(window.location.search).get('embed') === '1') {
    document.body.dataset.embed = 'true';
    document.documentElement.dataset.embed = 'true';
    return;
  }
  const key = 'payment-desk.display-view.v1';
  const smallScreen = window.matchMedia('(max-width: 600px)');
  const frame = $('#phone-app');
  let preferred = 'website';
  try { if (localStorage.getItem(key) === 'phone') preferred = 'phone'; } catch { /* Storage is optional. */ }
  const apply = () => {
    const view = smallScreen.matches ? 'website' : preferred;
    const phone = view === 'phone';
    document.body.dataset.preview = view;
    $('#website-view').hidden = phone;
    $('#phone-preview').hidden = !phone;
    for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
    if (phone && !frame.hasAttribute('src')) frame.src = '/?embed=1&theme=' + encodeURIComponent(document.documentElement.dataset.theme);
  };
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => {
      preferred = button.dataset.view;
      try { localStorage.setItem(key, preferred); } catch { /* Still switch when storage is unavailable. */ }
      apply();
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  }
  smallScreen.addEventListener('change', apply);
  apply();
}

// ---------- boot ----------

function init() {
  initTheme();
  initDisplayView();
  document.title = PRODUCT_NAME;
  document.querySelectorAll('[data-product-name]').forEach(node => { node.textContent = PRODUCT_NAME; });
  const logo = document.querySelector('[data-logo]');
  logo?.addEventListener('error', () => logo.remove());
  initTabs();
  $('#demo-run-all').addEventListener('click', runAllDemo);
  const form = $('#live-form');
  form.addEventListener('submit', submitLive);
  form.addEventListener('input', () => updateHints(form));
  form.addEventListener('reset', () => {
    setTimeout(() => { updateHints(form); showFormErrors(form, []); clearError('#live-error'); }, 0);
  });
  setMode('demo');
  renderPlaceholder();
  loadDemo();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
