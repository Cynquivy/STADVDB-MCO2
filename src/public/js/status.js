// Status page. The server does the actual checking in the background; this page only shows the
// latest result, so polling it every second is cheap and the page reacts quickly in the demo.
const POLL_MS = 1000;

const els = {
  servedBy: document.getElementById('served-by'),
  interval: document.getElementById('interval'),
  checkedAt: document.getElementById('checked-at'),
  checkNow: document.getElementById('check-now'),
  banner: document.getElementById('banner'),
  nodes: document.getElementById('nodes'),
};

async function load() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
    showBanner(null);
  } catch (err) {
    showBanner(`Lost contact with this app (${err.message}). Is it still running?`);
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

function render(data) {
  els.servedBy.textContent = `Served by ${data.app.name}`;
  els.interval.textContent = String(data.intervalMs / 1000);
  els.checkedAt.textContent = data.checkedAt
    ? `Last checked ${secondsAgo(data.checkedAt)} · took ${data.durationMs} ms`
    : 'Waiting for the first check…';
  els.nodes.innerHTML = data.nodes.map(renderNode).join('');
}

function renderNode(node) {
  const status = node.status;
  const db = node.db ?? {};
  const cardClass = status === 'DOWN' ? 'node-card is-down' : 'node-card';
  const role = node.role === 'central' ? 'Central · every row' : `Fragment · store ${node.stores.join(', ')} only`;

  return `
    <article class="${cardClass}">
      <header class="node-head">
        <div>
          <h2>${esc(node.name)}${node.isThisApp ? '<span class="tag">This app</span>' : ''}</h2>
          <p class="node-role">${role}</p>
        </div>
        ${badge(status)}
      </header>
      <dl class="facts">
        <div><dt>Database</dt><dd>${esc(`${node.host}:${node.port}`)}${db.reachable ? ` · ${db.responseMs} ms` : ''}</dd></div>
        <div><dt>App</dt><dd>${appText(node)}</dd></div>
        ${db.reachable ? `<div><dt>ID settings</dt><dd>${idsText(node)}</dd></div>` : ''}
        ${db.reachable ? `<div><dt>Log on this node</dt><dd>${outgoingText(db.log)}</dd></div>` : ''}
        <div><dt>Missing writes</dt><dd>${owedText(node)}</dd></div>
      </dl>
      ${db.reachable ? rowsTable(node) : ''}
      ${problemsList(node)}
    </article>`;
}

function badge(status) {
  const kind = { UP: 'up', RECOVERING: 'recovering', DOWN: 'down' }[status] ?? 'checking';
  const label = kind === 'checking' ? 'CHECKING' : status;
  return `<span class="badge badge-${kind}"><span class="dot"></span>${label}</span>`;
}

function appText(node) {
  const app = node.app;
  if (!app) return '…';
  if (app.isThisApp) return 'Running (serving this page)';
  if (!app.reachable) return `<span class="warn">Not reachable from here</span> (${esc(app.error)})`;
  if (app.reportedNodeId !== node.id) {
    return `<span class="warn">Running, but it says it is Node ${esc(app.reportedNodeId)}</span>. Check NODE_ID in its .env`;
  }
  return '<span class="ok">Running</span>';
}

function idsText(node) {
  const ids = node.db.ids;
  if (!ids) return '<span class="warn">unknown</span>';
  const ok = ids.step === node.expectedIds.step && ids.offset === node.expectedIds.offset;
  const text = `step ${ids.step}, offset ${ids.offset}`;
  return ok
    ? `${text} <span class="ok">✓</span>`
    : `<span class="warn">${text}</span> (expected step ${node.expectedIds.step}, offset ${node.expectedIds.offset})`;
}

// Writes stored in THIS node's replication_log that other nodes still need.
function outgoingText(log) {
  if (!log) return '<span class="warn">no replication_log</span>';
  const targets = Object.entries(log);
  if (targets.length === 0) return 'Nothing pending';
  return targets
    .map(([target, c]) => `${c.pending} pending for Node ${esc(target)}${c.missed ? ` (${c.missed} missed)` : ''}`)
    .join('<br>');
}

// Writes that other nodes' logs still owe to THIS node (only logs on reachable nodes are counted).
function owedText(node) {
  const owed = node.owed;
  if (!owed) return '…';
  if (owed.pending === 0) return 'None';
  const inFlight = owed.pending - owed.missed;
  const parts = [];
  if (owed.missed) parts.push(`<span class="warn">${owed.missed} missed write${owed.missed === 1 ? '' : 's'} to replay</span>`);
  if (inFlight) parts.push(`${inFlight} in flight`);
  return parts.join(' · ');
}

function rowsTable(node) {
  const counts = node.db.rowsByStore;
  if (!counts) return '';
  const stores = [...new Set([...node.stores, ...Object.keys(counts).map(Number)])].sort((a, b) => a - b);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const rows = stores
    .map((s) => {
      const n = counts[s] ?? 0;
      const misplaced = !node.stores.includes(s) && n > 0; // e.g. store-2 rows on Node 2
      return `<tr><td>Store ${s}${misplaced ? ' <span class="warn">(should not be here)</span>' : ''}</td><td>${fmt(n)}</td></tr>`;
    })
    .join('');
  const totalRow = stores.length > 1 ? `<tr><td>Total</td><td>${fmt(total)}</td></tr>` : '';
  return `<table class="rows"><thead><tr><th>Rows</th><th>Count</th></tr></thead><tbody>${rows}${totalRow}</tbody></table>`;
}

function problemsList(node) {
  const items = [];
  if (node.db?.error) items.push(`Cannot connect: ${node.db.error}`);
  if (node.markedDownReason) items.push(`A write to this node just failed: ${node.markedDownReason}`);
  for (const p of node.db?.problems ?? []) items.push(p);
  if (items.length === 0) return '';
  return `<ul class="problems">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

function showBanner(message) {
  els.banner.hidden = !message;
  els.banner.textContent = message ?? '';
}

function secondsAgo(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s === 0 ? 'just now' : `${s} s ago`;
}

const fmt = (n) => Number(n).toLocaleString('en-US');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

els.checkNow.addEventListener('click', checkNow);
load();
setInterval(load, POLL_MS);
