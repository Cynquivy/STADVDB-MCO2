// Tracks whether each node is UP, DOWN or RECOVERING (CLAUDE.md §5.1).
//
// Every HEALTH_INTERVAL_MS this app opens a FRESH connection to each node's database and runs
// SELECT 1. A fresh connection is used on purpose: after MySQL restarts, pooled connections are
// dead, and reusing one would make a healthy node look DOWN.
//
// In the same visit it also reads:
//   - row counts per store and the auto-increment settings, to prove the setup on the status page;
//   - the node's replication_log, to see which nodes are still owed writes.
// A reachable node that is still owed a *missed* write is RECOVERING, not UP.
//
// It also checks that the app on each VM answers /api/whoami (to prove all 3 deployments run).
// That result is only displayed; a node's status depends on its database alone.
import mysql from 'mysql2/promise';
import { config, NODES, NODE_IDS } from '../config.js';
import { getRoles, updateRoles } from '../ddb/roles.js';
import { describeError } from './errors.js';
import { connectionOptions } from './pools.js';

export const STATUS = Object.freeze({ UP: 'UP', DOWN: 'DOWN', RECOVERING: 'RECOVERING' });

const APP_CHECK_TIMEOUT_MS = 1500;

let latest = { checkedAt: null, durationMs: null, nodes: {} }; // result of the last finished check
const markedDownAt = {}; // nodeId → when a read or write saw that node fail (see markDown)
let running = null; // the check in progress, so overlapping refresh requests share it
let timer = null;
let stopped = false;

// ---------- public API (used by the routes, the read path, and later the write/recovery code) ----------

export function startHealthChecks() {
  stopped = false;
  const loop = async () => {
    try {
      await refreshNow();
    } catch (err) {
      console.error('[health] check failed:', err);
    }
    // Schedule the next check only after this one finished, so slow checks never pile up.
    if (!stopped) timer = setTimeout(loop, config.healthIntervalMs);
  };
  loop();
}

export function stopHealthChecks() {
  stopped = true;
  clearTimeout(timer);
}

// Runs a check now. If one is already running, waits for that one instead of starting another.
// With { fresh: true } (after Kill / Restore), a check that started BEFORE this call doesn't count,
// because it may have looked at the node before its state changed: wait for it, then check again.
export async function refreshNow({ fresh = false } = {}) {
  if (fresh && running) await running.catch(() => {});
  if (!running) running = runCheck().finally(() => (running = null));
  return running;
}

// Reads call this first, so a request that arrives right after the app starts waits for the
// first check (about a second) instead of finding every node "not checked yet" and failing.
export async function waitForFirstCheck() {
  if (!latest.checkedAt) await refreshNow();
}

export function getStatus(nodeId) {
  return latest.nodes[nodeId]?.status ?? STATUS.DOWN; // not checked yet → assume unavailable
}

// Only UP nodes are used for reads and direct writes (§5.1).
export function isAvailable(nodeId) {
  return getStatus(nodeId) === STATUS.UP;
}

// Called when a read or write loses its connection to a node (§5.3): the node is DOWN for this
// app right away, instead of waiting up to HEALTH_INTERVAL_MS for the next check.
// The next check that STARTS after this moment decides the node's real status again.
export function markDown(nodeId, reason) {
  markedDownAt[nodeId] = Date.now();
  const node = latest.nodes[nodeId];
  if (node && node.status !== STATUS.DOWN) {
    console.log(`[health] ${NODES[nodeId].name}: ${node.status} → DOWN (${reason})`);
    latest.nodes[nodeId] = { ...node, status: STATUS.DOWN, markedDownReason: reason };
    updateRoles(getStatus); // a fragment may take over as primary right away
  }
}

// Everything the status page shows.
export function snapshot() {
  return {
    app: { nodeId: config.nodeId, name: NODES[config.nodeId].name },
    intervalMs: config.healthIntervalMs,
    pendingGraceMs: config.pendingGraceMs,
    checkedAt: latest.checkedAt,
    durationMs: latest.durationMs,
    adminEnabled: Boolean(config.adminToken), // the Kill / Restore buttons need ADMIN_TOKEN
    roles: getRoles(),
    nodes: NODE_IDS.map((id) => latest.nodes[id] ?? { ...describeNode(id), status: 'CHECKING' }),
  };
}

// ---------- one round of checks ----------

async function runCheck() {
  const startedAt = Date.now();
  const [databases, apps] = await Promise.all([
    Promise.all(NODE_IDS.map(checkDatabase)),
    Promise.all(NODE_IDS.map(checkApp)),
  ]);

  // Writes still owed to each node, added up over the logs of every reachable node.
  // (A log can only be read if its node is reachable; see the "overlapping failures" limitation.)
  const owed = Object.fromEntries(NODE_IDS.map((id) => [id, { pending: 0, missed: 0 }]));
  for (const db of databases) {
    for (const [target, counts] of Object.entries(db.log ?? {})) {
      if (!owed[target]) continue;
      owed[target].pending += counts.pending;
      owed[target].missed += counts.missed;
    }
  }

  const nodes = {};
  NODE_IDS.forEach((id, i) => {
    const db = databases[i];
    let status = !db.reachable ? STATUS.DOWN : owed[id].missed > 0 ? STATUS.RECOVERING : STATUS.UP;

    // If a read or write saw this node fail after this check had already started, this check's
    // result may be stale, so keep the node DOWN until a check that started later says otherwise.
    if (markedDownAt[id] >= startedAt) status = STATUS.DOWN;
    else delete markedDownAt[id];

    nodes[id] = { ...describeNode(id), status, db, app: apps[i], owed: owed[id] };
    logChange(id, latest.nodes[id]?.status, status, db.error);
  });

  latest = { checkedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, nodes };
  updateRoles(getStatus);
}

async function checkDatabase(nodeId) {
  const started = performance.now();
  let conn;
  try {
    conn = await mysql.createConnection(connectionOptions(nodeId));
    await conn.query({ sql: 'SELECT 1', timeout: config.connectTimeoutMs });
    const responseMs = Math.round(performance.now() - started); // connect + login + SELECT 1
    return { reachable: true, responseMs, error: null, ...(await readDetails(conn)) };
  } catch (err) {
    return { reachable: false, responseMs: null, error: describeError(err) };
  } finally {
    if (conn) conn.end().catch(() => conn.destroy()); // don't wait: a dead server may never answer
  }
}

// Extra facts for the status page. Each query fails on its own, so one missing table doesn't
// hide the others (e.g. before sql/01_schema.sql has created replication_log).
async function readDetails(conn) {
  const details = { ids: null, rowsByStore: null, log: null, problems: [] };

  try {
    const [[row]] = await conn.query('SELECT @@auto_increment_increment AS step, @@auto_increment_offset AS id_offset');
    details.ids = { step: Number(row.step), offset: Number(row.id_offset) };
  } catch (err) {
    details.problems.push(`Could not read ID settings: ${describeError(err)}`);
  }

  try {
    const [rows] = await conn.query('SELECT store_id, COUNT(*) AS num_rows FROM payment GROUP BY store_id ORDER BY store_id');
    details.rowsByStore = Object.fromEntries(rows.map((r) => [r.store_id, Number(r.num_rows)]));
  } catch (err) {
    details.problems.push(`Could not read the payment table: ${describeError(err)}`);
  }

  try {
    // PENDING entries in THIS node's log, per target node. "missed" = the target is known not to
    // have the write: last_error is set, or the entry is older than the grace period (§5.1).
    // Younger entries without last_error are writes still committing, so they don't count.
    const [rows] = await conn.query(
      `SELECT target_node,
              COUNT(*) AS pending,
              SUM(last_error IS NOT NULL OR created_at < NOW(3) - INTERVAL ? MICROSECOND) AS missed
         FROM replication_log
        WHERE status = 'PENDING'
        GROUP BY target_node`,
      [config.pendingGraceMs * 1000],
    );
    details.log = Object.fromEntries(
      rows.map((r) => [r.target_node, { pending: Number(r.pending), missed: Number(r.missed) }]),
    );
  } catch (err) {
    details.problems.push(
      err.code === 'ER_NO_SUCH_TABLE'
        ? 'The replication_log table is missing. Run sql/01_schema.sql on this node.'
        : `Could not read replication_log: ${describeError(err)}`,
    );
  }

  return details;
}

async function checkApp(nodeId) {
  if (nodeId === config.nodeId) return { reachable: true, reportedNodeId: nodeId, isThisApp: true };

  const url = NODES[nodeId].appUrl;
  if (!url) return { reachable: false, error: `NODE${nodeId}_APP_URL is not set` };
  try {
    const res = await fetch(`${url}/api/whoami`, { signal: AbortSignal.timeout(APP_CHECK_TIMEOUT_MS) });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    return { reachable: true, reportedNodeId: body.nodeId };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'timed out' : err.cause?.code || err.message;
    return { reachable: false, error: reason };
  }
}

// ---------- helpers ----------

function describeNode(id) {
  const { name, role, stores, host, port } = NODES[id];
  return {
    id,
    name,
    role,
    stores,
    host,
    port,
    isThisApp: id === config.nodeId,
    expectedIds: { step: 3, offset: id }, // from zz-ddb.cnf: Node 1 → 1, Node 2 → 2, Node 3 → 3
  };
}

function logChange(id, before, after, error) {
  if (before === after) return;
  const why = after === STATUS.DOWN && error ? ` (${error})` : '';
  console.log(`[health] ${NODES[id].name}: ${before ?? 'start'} → ${after}${why}`);
}
