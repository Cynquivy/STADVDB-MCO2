// Payments page: search form → GET /api/payments → table, plus a panel showing which node answered.
// The filters are kept in the page URL, so a search survives a reload and can be shared.
const PAGE_SIZE = 50;
const FILTER_NAMES = ['store', 'id', 'customer', 'from', 'to', 'min', 'max'];

const els = {
  appNode: document.getElementById('app-node'),
  form: document.getElementById('filters'),
  search: document.getElementById('search'),
  clear: document.getElementById('clear'),
  banner: document.getElementById('banner'),
  route: document.getElementById('route'),
  summary: document.getElementById('results-summary'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  rows: document.getElementById('rows'),
};

let offset = 0;
let total = 0;

async function search(newOffset = 0) {
  offset = newOffset;
  const params = formParams();
  if (offset > 0) params.set('offset', String(offset));
  history.replaceState(null, '', params.size ? `?${params}` : location.pathname);
  params.set('limit', String(PAGE_SIZE));

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
  showBanner(null);
  total = data.total;
  renderRoute(data);

  const first = data.rows.length ? data.offset + 1 : 0;
  const last = data.offset + data.rows.length;
  els.summary.textContent = data.total === 0
    ? 'No payments match these filters.'
    : `Showing ${fmt(first)}–${fmt(last)} of ${fmt(data.total)} payment${data.total === 1 ? '' : 's'} · newest first`;

  els.rows.innerHTML = data.rows.length
    ? data.rows.map(rowHtml).join('')
    : '<tr><td class="empty" colspan="6">Nothing to show.</td></tr>';
  updatePager(data.rows.length);
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
  if (skipped.length) {
    els.route.innerHTML = `
      <div class="route-main"><span class="route-label">No copy available</span></div>
      ${skippedList(skipped)}`;
    els.route.hidden = false;
  } else {
    els.route.hidden = true;
  }
  els.summary.textContent = 'No results.';
  els.rows.innerHTML = '<tr><td class="empty" colspan="6">Nothing to show.</td></tr>';
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
  return `<tr>
    <td class="num">${esc(p.payment_id)}</td>
    <td class="num">${esc(p.customer_id)}</td>
    <td>Store ${esc(p.store_id)}</td>
    <td class="num">${Number(p.amount).toFixed(2)}</td>
    <td>${esc(p.payment_date)}</td>
    <td>Node ${esc(p.node)}</td>
  </tr>`;
}

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
els.prev.addEventListener('click', () => search(Math.max(0, offset - PAGE_SIZE)));
els.next.addEventListener('click', () => search(offset + PAGE_SIZE));

search(fillFormFromUrl());
