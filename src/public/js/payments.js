// Payments page: search (GET /api/payments), add / edit / delete (POST / PATCH / DELETE), and panels
// showing which node(s) answered a search and where each write went.
// The filters are kept in the page URL, so a search survives a reload and can be shared.
const PAGE_SIZE = 50;
const FILTER_NAMES = ['store', 'id', 'customer', 'from', 'to', 'min', 'max'];
const ISOLATION_KEY = 'mco2-isolation';

const els = {
  appNode: document.getElementById('app-node'),
  isolation: document.getElementById('isolation'),
  form: document.getElementById('filters'),
  search: document.getElementById('search'),
  clear: document.getElementById('clear'),
  addForm: document.getElementById('add-form'),
  add: document.getElementById('add'),
  banner: document.getElementById('banner'),
  write: document.getElementById('write'),
  route: document.getElementById('route'),
  summary: document.getElementById('results-summary'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  rows: document.getElementById('rows'),
};

let offset = 0;
let total = 0;
let shownRows = []; // the rows in the table, so Edit can prefill its inputs
let editing = null; // payment_id of the row being edited
let confirmingDelete = null; // payment_id whose Delete asks for confirmation

// ---------- search ----------

async function search(newOffset = offset) {
  offset = newOffset;
  const params = formParams();
  if (offset > 0) params.set('offset', String(offset));
  history.replaceState(null, '', params.size ? `?${params}` : location.pathname);
  params.set('limit', String(PAGE_SIZE));
  if (els.isolation.value) params.set('isolation', els.isolation.value);

  setBusy(true);
  try {
    const res = await fetch(`/api/payments?${params}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (body.app?.name) els.appNode.textContent = `App on ${body.app.name}`;
    if (res.ok) render(body);
    else renderError(body.error || `HTTP ${res.status}`, body.skipped);
  } catch (err) {
    els.appNode.textContent = 'App not reachable';
    renderError(`Lost contact with this app (${err.message}). Is it still running?`);
  } finally {
    setBusy(false);
  }
}

function render(data) {
  total = data.total;
  shownRows = data.rows;
  renderRoute(data);
  const first = data.rows.length ? data.offset + 1 : 0;
  const last = data.offset + data.rows.length;
  els.summary.textContent = data.total === 0
    ? 'No payments match these filters.'
    : `Showing ${fmt(first)}–${fmt(last)} of ${fmt(data.total)} payment${data.total === 1 ? '' : 's'}`;
  renderRows();
  updatePager(data.rows.length);
}

function renderRows() {
  els.rows.innerHTML = shownRows.length
    ? shownRows.map((p) => (p.payment_id === editing ? editRowHtml(p) : rowHtml(p))).join('')
    : '<tr><td class="empty" colspan="7">Nothing to show.</td></tr>';
}

// "Read from Node 2 · First choice · this app's own node holds store 1", plus any skipped nodes.
function renderRoute(data) {
  const nodes = data.servedBy.map((id) => `<span class="node-pill">Node ${esc(id)}</span>`).join('<span class="plus">+</span>');
  const choice = data.firstChoice
    ? '<span class="badge badge-checking">First choice</span>'
    : '<span class="badge badge-recovering"><span class="dot"></span>Fallback</span>';
  const why = `${capitalise(data.reason)} · ${data.ms} ms · ${data.isolationLevel}`;
  els.route.innerHTML = `
    <div class="route-main">
      <span class="route-label">Read from</span>
      <span class="route-nodes">${nodes}</span>
      ${choice}
    </div>
    <p class="route-why">${esc(why)}</p>
    ${skippedList(data.skipped)}`;
  els.route.hidden = false;
}

function renderError(message, skipped = []) {
  showBanner(message);
  total = 0;
  shownRows = [];
  if (skipped.length) {
    els.route.innerHTML = `<div class="route-main"><span class="route-label">No copy available</span></div>${skippedList(skipped)}`;
    els.route.hidden = false;
  } else {
    els.route.hidden = true;
  }
  els.summary.textContent = 'No results.';
  renderRows();
  updatePager(0);
}

function skippedList(skipped) {
  if (!skipped?.length) return '';
  const items = skipped.map((s) => {
    const kind = s.status === 'RECOVERING' ? 'recovering' : 'down';
    const why = s.detail ?? (s.status === 'RECOVERING' ? 'still missing writes, so it could return old data' : 'not responding');
    return `<li><span class="badge badge-${kind}"><span class="dot"></span>${esc(s.status)}</span> ${esc(s.name)} skipped: ${esc(why)}</li>`;
  });
  return `<ul class="route-skipped">${items.join('')}</ul>`;
}

function rowHtml(p) {
  const confirming = confirmingDelete === p.payment_id;
  const actions = confirming
    ? `<button class="btn-tint btn-small btn-danger" type="button" data-act="delete-yes" data-id="${p.payment_id}">Confirm delete</button>
       <button class="btn-tint btn-small" type="button" data-act="cancel" data-id="${p.payment_id}">Cancel</button>`
    : `<button class="btn-tint btn-small" type="button" data-act="edit" data-id="${p.payment_id}">Edit</button>
       <button class="btn-tint btn-small" type="button" data-act="delete" data-id="${p.payment_id}">Delete</button>`;
  return `<tr>
    <td class="num">${esc(p.payment_id)}</td>
    <td class="num">${esc(p.customer_id)}</td>
    <td>Store ${esc(p.store_id)}</td>
    <td class="num">${Number(p.amount).toFixed(2)}</td>
    <td>${esc(p.payment_date)}</td>
    <td>Node ${esc(p.node)}</td>
    <td class="row-actions">${actions}</td>
  </tr>`;
}

// The store can't be edited: it decides which nodes hold the row.
function editRowHtml(p) {
  const id = p.payment_id;
  return `<tr class="is-editing">
    <td class="num">${esc(id)}</td>
    <td><input class="input input-cell num" id="e-customer-${id}" value="${esc(p.customer_id)}" inputmode="numeric" aria-label="Customer ID"></td>
    <td>Store ${esc(p.store_id)}</td>
    <td><input class="input input-cell num" id="e-amount-${id}" value="${Number(p.amount).toFixed(2)}" inputmode="decimal" aria-label="Amount"></td>
    <td><input class="input input-cell" id="e-date-${id}" type="datetime-local" step="1" value="${esc(String(p.payment_date).replace(' ', 'T'))}" aria-label="Paid on"></td>
    <td>Node ${esc(p.node)}</td>
    <td class="row-actions">
      <button class="btn-primary btn-small" type="button" data-act="save" data-id="${id}">Save</button>
      <button class="btn-tint btn-small" type="button" data-act="cancel" data-id="${id}">Cancel</button>
    </td>
  </tr>`;
}

// ---------- writes ----------

async function write(method, url, body, button) {
  if (button) button.disabled = true;
  showBanner(null);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, ...(els.isolation.value ? { isolation: els.isolation.value } : {}) }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      showBanner(result.error || `HTTP ${res.status}`);
      return null;
    }
    editing = null;
    confirmingDelete = null;
    await renderWrite(result);
    await search(); // show the new values in the table
    return result;
  } catch (err) {
    showBanner(`Lost contact with this app (${err.message}).`);
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

// Where the write went: committed copies, copies still owed it, the steps, and both copies now.
async function renderWrite(r) {
  const nodePills = (ids) => ids.map((id) => `<span class="node-pill">Node ${esc(id)}</span>`).join('<span class="plus">+</span>');
  const pending = r.pending.length
    ? r.pending.map((p) => `<span class="badge badge-recovering"><span class="dot"></span>Node ${esc(p.node)} · ${esc(p.why)}</span>`).join(' ')
    : '<span class="muted">none</span>';
  const steps = r.timeline.map((t) => `<li><time>${t.ms} ms</time><span class="step-node">Node ${esc(t.node)}</span>${esc(t.text)}</li>`).join('');

  els.write.innerHTML = `
    <div class="route-main">
      <span class="route-label">Last write</span>
      <strong>${esc(r.op)} payment ${esc(r.paymentId)}</strong>
      <span class="muted">store ${esc(r.storeId)}</span>
      <span id="copies-badge"></span>
    </div>
    <dl class="facts write-facts">
      <div><dt>Committed on</dt><dd><span class="route-nodes">${nodePills(r.committed)}</span></dd></div>
      <div><dt>Still owed to</dt><dd>${pending}</dd></div>
      <div><dt>Details</dt><dd>Source ${esc(`Node ${r.source} · ${r.isolationLevel} · ${r.ms} ms · txn ${r.txnId.slice(0, 8)}`)}</dd></div>
    </dl>
    <details class="steps"><summary>Steps (lock order: Node ${r.copies.join(', then Node ')})</summary><ol>${steps}</ol></details>
    <div id="copies"></div>`;
  els.write.hidden = false;
  await renderCopies(r.paymentId);
}

// Reads the payment from every node, so you can see the copies agree.
async function renderCopies(paymentId) {
  const box = document.getElementById('copies');
  const badge = document.getElementById('copies-badge');
  try {
    const res = await fetch(`/api/consistency/${paymentId}`, { cache: 'no-store' });
    const c = await res.json();
    badge.innerHTML = c.match === true
      ? '<span class="badge badge-up"><span class="dot"></span>Copies match</span>'
      : c.match === false
        ? '<span class="badge badge-down"><span class="dot"></span>Copies differ</span>'
        : '<span class="badge badge-checking">A copy is unreachable</span>';
    const shown = c.copies.filter((x) => !c.expectedNodes || c.expectedNodes.includes(x.node) || x.row);
    const cell = (x) => (!x.reachable ? `<td colspan="3" class="muted">unreachable</td>`
      : !x.row ? '<td colspan="3" class="muted">no row</td>'
      : `<td class="num">${esc(x.row.customer_id)}</td><td class="num">${Number(x.row.amount).toFixed(2)}</td><td>${esc(x.row.payment_date)}</td>`);
    box.innerHTML = `
      <div class="table-wrap copies-table">
        <table class="data">
          <thead><tr><th scope="col">Copy</th><th scope="col" class="num">Customer</th><th scope="col" class="num">Amount</th><th scope="col">Paid on</th></tr></thead>
          <tbody>${shown.map((x) => `<tr><td>Node ${x.node}</td>${cell(x)}</tr>`).join('')}</tbody>
        </table>
      </div>`;
  } catch {
    box.innerHTML = '';
  }
}

async function addPayment(e) {
  e.preventDefault();
  const f = els.addForm.elements;
  const body = { store_id: f.store_id.value, customer_id: f.customer_id.value.trim(), amount: f.amount.value.trim() };
  if (f.payment_date.value) body.payment_date = f.payment_date.value;
  const result = await write('POST', '/api/payments', body, els.add);
  if (result) {
    f.customer_id.value = '';
    f.amount.value = '';
    f.payment_date.value = '';
  }
}

async function onRowAction(e) {
  const button = e.target.closest('button[data-act]');
  if (!button) return;
  const id = Number(button.dataset.id);
  switch (button.dataset.act) {
    case 'edit':
      editing = id;
      confirmingDelete = null;
      renderRows();
      document.getElementById(`e-amount-${id}`)?.focus();
      break;
    case 'delete':
      confirmingDelete = id;
      editing = null;
      renderRows();
      break;
    case 'cancel':
      editing = null;
      confirmingDelete = null;
      renderRows();
      break;
    case 'save': {
      const body = {
        customer_id: document.getElementById(`e-customer-${id}`).value.trim(),
        amount: document.getElementById(`e-amount-${id}`).value.trim(),
        payment_date: document.getElementById(`e-date-${id}`).value,
      };
      await write('PATCH', `/api/payments/${id}`, body, button);
      break;
    }
    case 'delete-yes':
      await write('DELETE', `/api/payments/${id}`, {}, button);
      break;
  }
}

// ---------- helpers ----------

function updatePager(shown) {
  els.prev.disabled = offset === 0;
  els.next.disabled = offset + shown >= total;
}

function setBusy(busy) {
  els.search.disabled = busy;
  if (busy) {
    els.summary.textContent = 'Searching…';
    els.prev.disabled = true;
    els.next.disabled = true;
  }
}

// Only filled-in fields go into the query string.
function formParams() {
  const params = new URLSearchParams();
  for (const name of FILTER_NAMES) {
    const value = els.form.elements[name].value.trim();
    if (value) params.set(name, value);
  }
  return params;
}

function fillFormFromUrl() {
  const params = new URLSearchParams(location.search);
  for (const name of FILTER_NAMES) els.form.elements[name].value = params.get(name) ?? '';
  return Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0);
}

function showBanner(message) {
  els.banner.hidden = !message;
  els.banner.textContent = message ?? '';
}

// The isolation level is a per-browser setting, remembered across reloads.
function setUpIsolation() {
  try {
    els.isolation.value = localStorage.getItem(ISOLATION_KEY) ?? '';
  } catch {}
  els.isolation.addEventListener('change', () => {
    try {
      localStorage.setItem(ISOLATION_KEY, els.isolation.value);
    } catch {}
    search();
  });
}

const fmt = (n) => Number(n).toLocaleString('en-US');
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  search(0);
});
els.clear.addEventListener('click', () => {
  els.form.reset();
  search(0);
});
els.addForm.addEventListener('submit', addPayment);
els.rows.addEventListener('click', onRowAction);
els.prev.addEventListener('click', () => search(Math.max(0, offset - PAGE_SIZE)));
els.next.addEventListener('click', () => search(offset + PAGE_SIZE));

setUpIsolation();
search(fillFormFromUrl());
