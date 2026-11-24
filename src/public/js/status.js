// Status page. The server does the checking in the background; this page shows the latest result
// every second, so it reacts quickly during the demo. Kill / Restore stop or start a node's MySQL.
const POLL_MS = 1000;
const CONSISTENCY_MS = 5000; // the consistency check scans every row, so it runs less often
const TOKEN_KEY = 'mco2-admin-token';

const els = {
  appNode: document.getElementById('app-node'),
  checkedAt: document.getElementById('checked-at'),
  checkNow: document.getElementById('check-now'),
  token: document.getElementById('admin-token'),
  banner: document.getElementById('banner'),
  roles: document.getElementById('roles'),
  nodes: document.getElementById('nodes'),
  events: document.getElementById('events'),
};

const busy = {}; // nodeId → 'stop' | 'start' while a Kill / Restore request runs
let adminEnabled = false;
let pointerDown = false; // see setHtml
let consistency = null; // latest GET /api/consistency result

const STATUS_HELP = {
  UP: 'Reachable and up to date',
  RECOVERING: 'Back online, but still missing writes. Not used until they are replayed.',
  DOWN: 'Not responding',
};

async function load() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
    if (els.banner.dataset.kind === 'lost') showBanner(null);
  } catch (err) {
    showBanner(`Lost contact with this app (${err.message}). Is it still running?`, 'lost');
  }
}

async function checkNow() {
  els.checkNow.disabled = true;
  try {
    const res = await fetch('/api/status/refresh', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    showBanner(`Check failed: ${err.message}`);
  } finally {
    els.checkNow.disabled = false;
  }
}

// Kill = systemctl stop mysql on that node; Restore = systemctl start mysql.
async function killOrRestore(nodeId, action) {
  const token = els.token.value.trim();
  if (!token) {
    showBanner('Enter the admin token (top right) first.');
    els.token.focus();
    return;
  }
  busy[nodeId] = action;
  showBanner(null);
  load();
  try {
    const res = await fetch(`/api/admin/nodes/${nodeId}/mysql/${action}`, {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) showBanner(body.error || `HTTP ${res.status}`);
  } catch (err) {
    showBanner(`Request failed: ${err.message}`);
  } finally {
    delete busy[nodeId];
    load();
  }
}

// ---------- rendering ----------

function render(data) {
  els.appNode.textContent = `App on ${data.app.name}`;
  els.checkedAt.textContent = data.checkedAt ? `Checked ${secondsAgo(data.checkedAt)}` : 'Checking…';
  adminEnabled = data.adminEnabled;
  els.token.hidden = !adminEnabled;

  setHtml(els.roles, data.roles ? Object.entries(data.roles.stores).map(([s, r]) => storeCard(s, r, data.nodes)).join('') : '');
  setHtml(els.nodes, data.nodes.map((n) => nodeCard(n, data.roles?.nodes[n.id])).join(''));
  renderEvents(data.roles?.events ?? []);
}

// The page redraws every second. Redrawing a button between mouse-down and mouse-up would swallow
// the click, so redraws wait while a mouse button is held; unchanged HTML isn't redrawn at all.
function setHtml(el, html) {
  if (pointerDown || el.dataset.html === html) return;
  el.innerHTML = html;
  el.dataset.html = html;
}

// "Store 1 · Primary Node 1 · Secondary Node 2"; during a failover a fragment is primary.
function storeCard(store, r, nodes) {
  const statusOf = (id) => nodes.find((n) => n.id === id)?.status;
  const copy = (id, fallbackText) => (id ? `Node ${id}` : `<span class="muted">${fallbackText}</span>`);
  const missing = r.copies.filter((id) => statusOf(id) !== 'UP').map((id) => `Node ${id} is ${statusOf(id)}`);
  return `
    <article class="store-card">
      <header class="store-head">
        <h2>Store ${esc(store)}</h2>
        ${r.failover ? '<span class="badge badge-recovering" title="Node 1 is unavailable, so the fragment leads"><span class="dot"></span>Failover</span>' : ''}
      </header>
      <dl class="facts">
        <div><dt>Primary</dt><dd>${copy(r.primary, 'none: no copy is UP')}</dd></div>
        <div><dt>Secondary</dt><dd>${copy(r.secondary, `none (${esc(missing.join(', '))})`)}</dd></div>
        <div><dt>Copies</dt><dd>${copiesText(Number(store))}</dd></div>
      </dl>
    </article>`;
}

// Node 1's rows for this store vs the home node's: count, sum and checksum must all agree.
function copiesText(store) {
  const s = consistency?.stores?.find((x) => x.store === store);
  if (!s) return '<span class="muted">checking…</span>';
  if (s.match === null) return '<span class="muted">not compared: a copy is unreachable</span>';
  if (s.match) return `<span class="ok">Match ✓</span> · ${fmt(s.central.rows)} rows`;
  return `<span class="warn">Different</span> · Node 1 ${fmt(s.central.rows)} rows, Node ${s.homeNode} ${fmt(s.fragment.rows)}`;
}

async function loadConsistency() {
  try {
    const res = await fetch('/api/consistency', { cache: 'no-store' });
    if (res.ok) consistency = await res.json();
  } catch {}
}

function nodeCard(node, role) {
  const db = node.db ?? {};
  const cardClass = node.status === 'DOWN' ? 'node-card is-down' : 'node-card';
  return `
    <article class="${cardClass}">
      <header class="node-head">
        <div>
          <h2>${esc(node.name)}${node.isThisApp ? '<span class="tag">This app</span>' : ''}</h2>
          ${roleChip(node, role)}
        </div>
        ${badge(node.status)}
      </header>
      <dl class="facts">
        <div><dt>Database</dt><dd>${db.reachable ? `${db.responseMs} ms` : node.status === 'CHECKING' ? '…' : '<span class="warn">Not reachable</span>'}</dd></div>
        <div><dt>App</dt><dd>${appText(node)}</dd></div>
        ${db.reachable ? `<div><dt>Rows</dt><dd>${rowsText(node)}</dd></div>` : ''}
        <div><dt>Missed writes</dt><dd>${owedText(node)}</dd></div>
        ${logText(db.log)}
      </dl>
      ${actionButton(node)}
      ${problemsList(node)}
    </article>`;
}

function roleChip(node, role) {
  if (!role) return '';
  const stores = (list) => `store${list.length > 1 ? 's' : ''} ${list.join(' & ')}`;
  if (role.role === 'PRIMARY') return `<span class="role role-primary">Primary · ${stores(role.primaryFor)}</span>`;
  if (role.role === 'SECONDARY') return `<span class="role role-secondary">Secondary · ${stores(role.secondaryFor)}</span>`;
  const why = node.status === 'RECOVERING' ? 'catching up' : 'down';
  return `<span class="role role-none">No role · ${why}</span>`;
}

function badge(status) {
  const kind = { UP: 'up', RECOVERING: 'recovering', DOWN: 'down' }[status] ?? 'checking';
  const label = kind === 'checking' ? 'CHECKING' : status;
  return `<span class="badge badge-${kind}" title="${esc(STATUS_HELP[status] ?? '')}"><span class="dot"></span>${label}</span>`;
}

function appText(node) {
  const app = node.app;
  if (!app) return '…';
  if (app.isThisApp || (app.reachable && app.reportedNodeId === node.id)) return 'Running';
  if (!app.reachable) return `<span class="warn">Not reachable</span> (${esc(app.error)})`;
  return `<span class="warn">Says it is Node ${esc(app.reportedNodeId)}</span>: check NODE_ID in its .env`;
}

function rowsText(node) {
  const counts = node.db.rowsByStore;
  if (!counts) return '<span class="warn">unknown</span>';
  const stores = [...new Set([...node.stores, ...Object.keys(counts).map(Number)])].sort((a, b) => a - b);
  return stores
    .map((s) => {
      const text = `Store ${s}: ${fmt(counts[s] ?? 0)}`;
      const misplaced = !node.stores.includes(s) && counts[s] > 0; // e.g. store-2 rows on Node 2
      return misplaced ? `<span class="warn">${text} (should not be here)</span>` : text;
    })
    .join(' · ');
}

// Writes that other nodes' logs still owe THIS node (only logs on reachable nodes are counted).
function owedText(node) {
  const owed = node.owed;
  if (!owed) return '…';
  if (owed.pending === 0) return 'None';
  const inFlight = owed.pending - owed.missed;
  const parts = [];
  if (owed.missed) parts.push(`<span class="warn">${owed.missed} to replay</span>`);
  if (inFlight) parts.push(`${inFlight} in flight`);
  return parts.join(' · ');
}

// Writes stored in THIS node's replication_log that other nodes still need. Shown only if any.
function logText(log) {
  const targets = Object.entries(log ?? {}).filter(([, c]) => c.pending > 0);
  if (targets.length === 0) return '';
  const text = targets.map(([target, c]) => `${c.pending} for Node ${esc(target)}`).join(' · ');
  return `<div><dt>Log</dt><dd>${text}</dd></div>`;
}

function actionButton(node) {
  if (!adminEnabled || node.status === 'CHECKING') return '';
  const action = busy[node.id] ?? (node.status === 'DOWN' ? 'start' : 'stop');
  const label = busy[node.id] ? (action === 'stop' ? 'Killing…' : 'Restoring…') : action === 'stop' ? 'Kill' : 'Restore';
  const title = action === 'stop' ? `Stop MySQL on ${node.name} (systemctl stop mysql)` : `Start MySQL on ${node.name} (systemctl start mysql)`;
  return `<div class="node-actions">
    <button class="btn-tint btn-small" type="button" data-node="${node.id}" data-action="${action}"
            title="${esc(title)}" ${busy[node.id] ? 'disabled' : ''}>${label}</button>
  </div>`;
}

function problemsList(node) {
  const items = [];
  if (node.db?.error) items.push(`Cannot connect: ${node.db.error}`);
  if (node.markedDownReason) items.push(`This app just lost contact with it: ${node.markedDownReason}`);
  const ids = node.db?.ids;
  if (ids && (ids.step !== node.expectedIds.step || ids.offset !== node.expectedIds.offset)) {
    items.push(`ID settings are step ${ids.step}, offset ${ids.offset}; expected step ${node.expectedIds.step}, offset ${node.expectedIds.offset}`);
  }
  for (const p of node.db?.problems ?? []) items.push(p);
  if (items.length === 0) return '';
  return `<ul class="problems">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

function renderEvents(events) {
  els.events.hidden = events.length === 0;
  setHtml(els.events, `
    <h2 class="section-label">Role changes</h2>
    <ol class="event-list">
      ${events.slice(0, 6).map((e) => `<li><time>${esc(clock(e.at))}</time>${esc(e.message)}</li>`).join('')}
    </ol>`);
}

// ---------- helpers ----------

function showBanner(message, kind = 'error') {
  els.banner.hidden = !message;
  els.banner.textContent = message ?? '';
  els.banner.dataset.kind = message ? kind : '';
}

function secondsAgo(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s === 0 ? 'just now' : `${s} s ago`;
}

const clock = (iso) => new Date(iso).toLocaleTimeString('en-GB');
const fmt = (n) => Number(n).toLocaleString('en-US');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// The token is kept in this browser only, so it needn't be retyped after a reload.
function rememberToken() {
  try {
    els.token.value = localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {}
  els.token.addEventListener('change', () => {
    try {
      localStorage.setItem(TOKEN_KEY, els.token.value.trim());
    } catch {}
  });
}

els.checkNow.addEventListener('click', checkNow);
document.addEventListener('pointerdown', () => (pointerDown = true));
document.addEventListener('pointerup', () => setTimeout(() => (pointerDown = false))); // after the click event
els.nodes.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-action]');
  if (button && !button.disabled) killOrRestore(Number(button.dataset.node), button.dataset.action);
});
rememberToken();
load();
setInterval(load, POLL_MS);
loadConsistency().then(load);
setInterval(loadConsistency, CONSISTENCY_MS);
