// Reading payments, with automatic fallback (CLAUDE.md §5.2).
//
// routing.js lists the ways to answer a read: a first choice, then a fallback. We use the first one
// whose nodes are all UP in this app's view. DOWN nodes are skipped, and so are RECOVERING ones,
// because they are still missing writes and could return old data.
//
// That view can be up to HEALTH_INTERVAL_MS old, so a node can also fail while we read from it.
// Then we mark it DOWN (so the next requests skip it at once) and try the next option.
//
// Every result says which node(s) answered and why, so the demo shows where the data came from.
import { config, ISOLATION_LEVELS, NODES } from '../config.js';
import { describeError, isConnectionError } from '../db/errors.js';
import { getStatus, isAvailable, markDown, STATUS, waitForFirstCheck } from '../db/health.js';
import { getPool } from '../db/pools.js';
import { readOptions } from './routing.js';

// A node that stops answering in the middle of a read counts as failed after this long, so the
// request moves on to the other copy instead of hanging. Plain reads don't wait for row locks,
// so a healthy node answers far sooner.
const READ_TIMEOUT_MS = 5000;

const COLUMNS = 'payment_id, customer_id, store_id, amount, payment_date';

/**
 * List / search payments, newest first (highest payment_id first).
 *
 * @param {object} filters  { paymentId, storeId, customerId, dateFrom, dateTo, minAmount, maxAmount },
 *                          all optional and already validated by the route
 * @param {object} page     { limit, offset }
 * @param {object} [opts]   { isolationLevel } (defaults to ISOLATION_LEVEL from .env)
 * @returns {Promise<object>} { servedBy, firstChoice, reason, skipped, isolationLevel, ms,
 *                              total, limit, offset, rows }; each row also says which node it came from
 */
export async function findPayments(filters, { limit, offset }, { isolationLevel = config.isolationLevel } = {}) {
  if (!ISOLATION_LEVELS.includes(isolationLevel)) throw new Error(`Unknown isolation level: ${isolationLevel}`);
  await waitForFirstCheck();

  const started = performance.now();
  const where = buildWhere(filters);
  const skipped = []; // nodes we couldn't use, and why
  const options = readOptions(filters.storeId ?? null);

  for (const [i, option] of options.entries()) {
    const notUp = option.nodes.filter((n) => !isAvailable(n));
    if (notUp.length > 0) {
      for (const n of notUp) skipped.push(skippedNode(n, getStatus(n)));
      continue;
    }

    const answer = await readOption(option.nodes, where, { limit, offset }, isolationLevel);
    if (answer.failed) {
      // These nodes were UP a moment ago but just failed: they are down now.
      for (const { nodeId, error } of answer.failed) {
        const detail = `read failed: ${describeError(error)}`;
        markDown(nodeId, detail);
        skipped.push(skippedNode(nodeId, STATUS.DOWN, detail));
      }
      continue;
    }

    const result = {
      servedBy: option.nodes,
      firstChoice: i === 0,
      reason: option.reason,
      skipped,
      isolationLevel,
      ms: Math.round(performance.now() - started),
      limit,
      offset,
      ...answer,
    };
    if (!result.firstChoice) {
      const names = option.nodes.map((n) => NODES[n].name).join(' + ');
      console.log(`[read] ${scope(filters)}: ${describeSkipped(skipped)} → served by ${names} (${result.ms} ms)`);
    }
    return result;
  }

  // Every copy of the rows we need is down (more than one node failed at once).
  console.warn(`[read] ${scope(filters)}: no copy available (${describeSkipped(skipped)})`);
  const err = new Error(`No node that holds these payments is available right now (${describeSkipped(skipped)}).`);
  err.status = 503;
  err.details = { skipped };
  throw err;
}

// Reads from all nodes of one option at the same time and combines their answers.
// Returns { total, rows }, or { failed: [{ nodeId, error }] } if any node couldn't be reached.
async function readOption(nodes, where, { limit, offset }, isolationLevel) {
  // One node: it returns the page directly.
  // Several nodes (the two fragments): each returns its newest offset+limit rows, and we cut the
  // page out of the merged list. This is the UNION ALL of §5.2, done in the app because the
  // fragments are separate servers. Every row of the page is among its own fragment's newest
  // offset+limit rows, so the page is exactly what Node 1 would have returned.
  const single = nodes.length === 1;
  const settled = await Promise.allSettled(
    nodes.map((n) => readFromNode(n, where, single ? limit : offset + limit, single ? offset : 0, isolationLevel)),
  );

  const failed = settled.flatMap((s, k) => (s.status === 'rejected' ? [{ nodeId: nodes[k], error: s.reason }] : []));
  const realError = failed.find((f) => !isConnectionError(f.error));
  if (realError) throw realError.error; // e.g. bad SQL: another node wouldn't do better
  if (failed.length > 0) return { failed };

  const answers = settled.map((s) => s.value);
  const total = answers.reduce((sum, a) => sum + a.total, 0);
  const rows = single
    ? answers[0].rows
    : answers
        .flatMap((a) => a.rows)
        .sort((a, b) => b.payment_id - a.payment_id)
        .slice(offset, offset + limit);
  return { total, rows };
}

// One node's part of the answer. It runs in one READ ONLY transaction at the chosen isolation
// level, so the count and the rows come from the same snapshot (at REPEATABLE READ and above).
async function readFromNode(nodeId, where, take, skip, isolationLevel) {
  const conn = await getPool(nodeId).getConnection();
  let broken = false;
  try {
    // isolationLevel was checked against ISOLATION_LEVELS, so it is safe to put in the SQL.
    await run(conn, `SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
    await run(conn, 'START TRANSACTION READ ONLY');
    const [[{ total }]] = await run(conn, `SELECT COUNT(*) AS total FROM payment ${where.sql}`, where.params);
    const [rows] = await run(
      conn,
      `SELECT ${COLUMNS} FROM payment ${where.sql} ORDER BY payment_id DESC LIMIT ? OFFSET ?`,
      [...where.params, take, skip],
    );
    await run(conn, 'COMMIT');
    return { total: Number(total), rows: rows.map((row) => ({ ...row, node: nodeId })) };
  } catch (err) {
    broken = isConnectionError(err);
    if (!broken) await conn.query('ROLLBACK').catch(() => (broken = true));
    throw err;
  } finally {
    // A broken connection is thrown away. Back in the pool, it would fail the next request too.
    if (broken) conn.destroy();
    else conn.release();
  }
}

function run(conn, sql, params = []) {
  return conn.query({ sql, timeout: READ_TIMEOUT_MS }, params);
}

// The same WHERE clause works on every node: a fragment simply has no rows of the other store.
function buildWhere(f) {
  const clauses = [];
  const params = [];
  const add = (clause, value) => {
    clauses.push(clause);
    params.push(value);
  };
  if (f.paymentId != null) add('payment_id = ?', f.paymentId);
  if (f.storeId != null) add('store_id = ?', f.storeId);
  if (f.customerId != null) add('customer_id = ?', f.customerId);
  if (f.dateFrom) add('payment_date >= ?', f.dateFrom);
  if (f.dateTo) add('payment_date < DATE_ADD(?, INTERVAL 1 DAY)', f.dateTo); // the whole "to" day counts
  if (f.minAmount != null) add('amount >= ?', f.minAmount);
  if (f.maxAmount != null) add('amount <= ?', f.maxAmount);
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function skippedNode(nodeId, status, detail = null) {
  return { node: nodeId, name: NODES[nodeId].name, status, detail };
}

const scope = (f) => (f.storeId != null ? `store ${f.storeId}` : 'all stores');
const describeSkipped = (skipped) => skipped.map((s) => `${s.name} ${s.status}`).join(', ');
