// The replication log (CLAUDE.md §5.5) and the idempotent "apply a row" step.
//
// Each node's replication_log is its to-do list: writes that committed on this node and still
// have to reach the row's other copy. The write path (writes.js) adds entries; the recovery worker
// (step 5) replays them. Both use applyRow, so a write and its replay do exactly the same thing.
export const PAYMENT_COLUMNS = ['payment_id', 'customer_id', 'store_id', 'amount', 'payment_date'];

/**
 * Makes `row` the current version of the payment on this connection's node. Idempotent: applying
 * the same entry twice gives the same result, so a replay after a crash can never do harm.
 *   INSERT / UPDATE → upsert the FULL row (absolute values, never "amount + 1")
 *   DELETE          → delete by id (deleting a missing row is fine)
 */
export async function applyRow(conn, op, row, { paymentId = row?.payment_id, timeout } = {}) {
  if (op === 'DELETE') {
    const [result] = await conn.query({ sql: 'DELETE FROM payment WHERE payment_id = ?', timeout }, [paymentId]);
    return result.affectedRows;
  }
  const [result] = await conn.query(
    {
      sql: `INSERT INTO payment (${PAYMENT_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?) AS new
            ON DUPLICATE KEY UPDATE customer_id = new.customer_id, store_id = new.store_id,
                                    amount = new.amount, payment_date = new.payment_date`,
      timeout,
    },
    PAYMENT_COLUMNS.map((c) => row[c]),
  );
  return result.affectedRows;
}

// Inserts one entry. Called inside the source node's write transaction, so the entry commits
// together with the write or not at all (transactional outbox).
export async function insertLogEntry(conn, { txnId, source, target, op, paymentId, payload, lastError, timeout }) {
  const [result] = await conn.query(
    {
      sql: `INSERT INTO replication_log (txn_id, source_node, target_node, op, payment_id, payload, last_error)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      timeout,
    },
    [txnId, source, target, op, paymentId, payload ? JSON.stringify(payload) : null, lastError],
  );
  return result.insertId;
}

// Entries are updated by primary key only, which locks just those rows (no gap locks), so these
// small updates never block or deadlock with other writers' log inserts.
export async function markApplied(db, logIds) {
  const ids = [].concat(logIds);
  if (ids.length === 0) return;
  await db.query(
    `UPDATE replication_log SET status = 'APPLIED', applied_at = NOW(3), last_error = NULL
      WHERE log_id IN (?) AND status = 'PENDING'`,
    [ids],
  );
}

export async function markMissed(db, logId, error) {
  await db.query(
    `UPDATE replication_log SET last_error = ?, attempts = attempts + 1 WHERE log_id = ? AND status = 'PENDING'`,
    [String(error).slice(0, 255), logId],
  );
}

// PENDING entries for one row aimed at one node, oldest first.
export async function pendingFor(db, paymentId, targetNode, { timeout } = {}) {
  const [rows] = await db.query(
    {
      sql: `SELECT log_id, op, payload, last_error FROM replication_log
             WHERE payment_id = ? AND target_node = ? AND status = 'PENDING'
             ORDER BY log_id`,
      timeout,
    },
    [paymentId, targetNode],
  );
  return rows.map((r) => ({ ...r, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload }));
}

// Does `row` (a node's current copy, or null if it has none) already equal what `entry` would write?
export function rowMatchesEntry(row, entry) {
  if (entry.op === 'DELETE') return row == null;
  if (row == null || entry.payload == null) return false;
  const p = entry.payload;
  return (
    Number(row.customer_id) === Number(p.customer_id) &&
    Number(row.store_id) === Number(p.store_id) &&
    Number(row.amount) === Number(p.amount) &&
    String(row.payment_date) === String(p.payment_date)
  );
}
