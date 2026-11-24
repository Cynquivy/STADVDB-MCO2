// Consistency checker (CLAUDE.md M7): do Node 2 + Node 3 still equal Node 1?
// This is the pass/fail check at the end of every test case.
//
// It runs the §3 verification query on every reachable node, whatever its status (a RECOVERING
// node is expected to differ until its missed writes are replayed), and compares each store's
// numbers on Node 1 with the same store on its home node.
import { NODES, NODE_IDS, STORE_IDS, homeNode } from '../config.js';
import { describeError } from '../db/errors.js';
import { getPool } from '../db/pools.js';
import { PAYMENT_COLUMNS } from './replicationLog.js';

const TIMEOUT_MS = 10_000;

// Count, sum and an order-independent checksum of every row, per store (CLAUDE.md §3).
const FRAGMENT_SQL = `
  SELECT store_id, COUNT(*) AS num_rows, SUM(amount) AS total,
         BIT_XOR(CRC32(CONCAT_WS('|', payment_id, customer_id, store_id, amount, payment_date))) AS checksum
    FROM payment GROUP BY store_id`;

export async function checkConsistency() {
  const started = performance.now();
  const answers = await Promise.all(NODE_IDS.map((id) => query(id, FRAGMENT_SQL)));
  const nodes = {};
  NODE_IDS.forEach((id, i) => {
    const a = answers[i];
    nodes[id] = a.error
      ? { reachable: false, error: a.error }
      : { reachable: true, stores: Object.fromEntries(a.rows.map((r) => [r.store_id, summarise(r)])) };
  });

  const stores = STORE_IDS.map((s) => {
    const home = homeNode(s);
    const central = storeOn(nodes[1], s);
    const fragment = storeOn(nodes[home], s);
    const match = central && fragment ? same(central, fragment) : null; // null: a copy is unreachable
    return { store: s, homeNode: home, central, fragment, match };
  });

  // A fragment must hold its own store only (e.g. no store-2 rows on Node 2).
  const misplaced = [];
  for (const id of NODE_IDS.filter((n) => NODES[n].role === 'fragment')) {
    for (const [s, numbers] of Object.entries(nodes[id].stores ?? {})) {
      if (!NODES[id].stores.includes(Number(s))) misplaced.push({ node: id, store: Number(s), rows: numbers.rows });
    }
  }

  const ok = stores.every((s) => s.match === true) && misplaced.length === 0;
  const complete = stores.every((s) => s.match !== null);
  return { ok, complete, checkedAt: new Date().toISOString(), ms: Math.round(performance.now() - started), nodes, stores, misplaced };
}

// Every copy of one payment, side by side, plus any log entries still owed for it.
export async function comparePayment(paymentId) {
  const answers = await Promise.all(
    NODE_IDS.map((id) =>
      query(
        id,
        `SELECT ${PAYMENT_COLUMNS.join(', ')} FROM payment WHERE payment_id = ?`,
        [paymentId],
      ),
    ),
  );
  const logs = await Promise.all(
    NODE_IDS.map((id) =>
      query(id, `SELECT log_id, target_node, op, last_error FROM replication_log WHERE payment_id = ? AND status = 'PENDING' ORDER BY log_id`, [paymentId]),
    ),
  );

  const copies = NODE_IDS.map((id, i) => ({
    node: id,
    reachable: !answers[i].error,
    error: answers[i].error ?? null,
    row: answers[i].rows?.[0] ?? null,
  }));
  const found = copies.find((c) => c.row)?.row;
  const storeId = found?.store_id ?? null;
  const expected = storeId ? [1, homeNode(storeId)] : null; // the nodes that should hold it

  // Same when both expected copies agree (both have the identical row, or both have none) and no
  // other node has it. null when a copy couldn't be read.
  let match = null;
  const relevant = copies.filter((c) => !expected || expected.includes(c.node));
  if (relevant.every((c) => c.reachable)) {
    const rows = relevant.map((c) => (c.row ? JSON.stringify(PAYMENT_COLUMNS.map((k) => String(c.row[k]))) : null));
    const misplaced = expected ? copies.some((c) => !expected.includes(c.node) && c.row) : false;
    match = rows.every((r) => r === rows[0]) && !misplaced;
  }

  const pending = NODE_IDS.flatMap((id, i) =>
    (logs[i].rows ?? []).map((e) => ({ logId: e.log_id, onNode: id, forNode: e.target_node, op: e.op, lastError: e.last_error })),
  );
  return { paymentId, storeId, expectedNodes: expected, copies, match, pending };
}

async function query(nodeId, sql, params = []) {
  try {
    const [rows] = await getPool(nodeId, 'meta').query({ sql, timeout: TIMEOUT_MS }, params);
    return { rows };
  } catch (err) {
    return { error: describeError(err) };
  }
}

function summarise(r) {
  return { rows: Number(r.num_rows), total: Number(r.total ?? 0).toFixed(2), checksum: Number(r.checksum ?? 0) };
}

// A reachable node with no rows for a store reports zeros, so it still compares.
function storeOn(node, s) {
  if (!node.reachable) return null;
  return node.stores[s] ?? { rows: 0, total: '0.00', checksum: 0 };
}

const same = (a, b) => a.rows === b.rows && a.total === b.total && a.checksum === b.checksum;
