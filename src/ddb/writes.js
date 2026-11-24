// Global writes: INSERT, UPDATE and DELETE on payment (CLAUDE.md §5.3; decisions D5, D9, D16).
//
// Every payment has two copies: Node 1 and its store's home node. One global write:
//   1. BEGINs on each available copy and locks the row: Node 1 FIRST, then the home node, always in
//      that order. Two writers of the same row therefore queue on Node 1's lock instead of each
//      holding one copy and waiting for the other (a distributed deadlock).
//   2. Catch-up guard: skips a copy that hasn't yet received an older write to this row, so the
//      older write can never be replayed over this newer one.
//   3. Writes the new row on every copy still in the write.
//   4. Records the change for the other copy in the SOURCE node's replication_log, inside the
//      source's own transaction: if the write commits, its to-do entry commits with it.
//   5. Commits the source first, then the other copy, then ticks the log entry off (APPLIED).
// A copy that is down is simply left out: the write still succeeds on the other copy, and the log
// entry stays PENDING until the recovery worker (step 5) replays it there.
import { randomUUID } from 'node:crypto';
import { config, ISOLATION_LEVELS, NODES, homeNode } from '../config.js';
import { describeError, isConnectionError } from '../db/errors.js';
import { getStatus, isAvailable, markDown, STATUS, waitForFirstCheck } from '../db/health.js';
import { getPool } from '../db/pools.js';
import { findPayments } from './reads.js';
import { applyRow, insertLogEntry, markApplied, markMissed, pendingFor, rowMatchesEntry } from './replicationLog.js';

// A write may legitimately wait up to LOCK_WAIT_TIMEOUT_S for another writer's row lock (that is
// how concurrent writers queue up, case C3), so only a node silent for longer counts as failed.
const STATEMENT_TIMEOUT_MS = (config.lockWaitTimeoutS + 5) * 1000;

// ---------- public API (used by routes/payments.js) ----------

/** fields: { customer_id, store_id, amount, payment_date }, already validated. */
export function insertPayment(fields, opts) {
  return globalWrite({ op: 'INSERT', storeId: fields.store_id, fields }, opts);
}

/** changes: any of { customer_id, amount, payment_date }, already validated. store_id never changes. */
export async function updatePayment(paymentId, changes, opts) {
  const storeId = await storeOf(paymentId);
  return globalWrite({ op: 'UPDATE', paymentId, storeId, changes }, opts);
}

export async function deletePayment(paymentId, opts) {
  const storeId = await storeOf(paymentId);
  return globalWrite({ op: 'DELETE', paymentId, storeId }, opts);
}

// The store decides which two nodes hold the row. store_id can never change, so looking it up
// with a normal read before the write is safe.
async function storeOf(paymentId) {
  const { rows } = await findPayments({ paymentId }, { limit: 1, offset: 0 });
  if (rows.length === 0) throw httpError(404, `Payment ${paymentId} not found`);
  return rows[0].store_id;
}

// ---------- the global write ----------

async function globalWrite({ op, paymentId = null, storeId, fields, changes }, { isolationLevel = config.isolationLevel } = {}) {
  if (!ISOLATION_LEVELS.includes(isolationLevel)) throw httpError(400, `Unknown isolation level: ${isolationLevel}`);
  await waitForFirstCheck(); // right after startup, every node is "not checked yet"
  const tx = new GlobalTransaction({ op, paymentId, storeId, isolationLevel });

  try {
    if (tx.avail.length === 0) {
      throw httpError(503, `No copy of store ${storeId}'s payments is available (${tx.describeMissing()}). Nothing was saved.`);
    }

    // 1. BEGIN and lock the row on each available copy, in the fixed order: Node 1, then home.
    const current = {}; // nodeId → that copy's row before the write (null if it has none)
    for (const n of [...tx.avail]) {
      await tx.onNode(n, async () => {
        await tx.begin(n);
        if (op !== 'INSERT') current[n] = await tx.lockRow(n);
      });
    }
    if (tx.avail.length === 0) throw httpError(503, `Every copy failed (${tx.describeMissing()}). Nothing was saved.`);

    // 2. Catch-up guard (a brand-new INSERT id has no older writes, so INSERTs skip it).
    if (op !== 'INSERT') await catchUpGuard(tx, current);
    if (tx.avail.length === 0) {
      throw httpError(409, `Payment ${paymentId} is being resynchronised on every reachable copy. Nothing was saved; try again in a few seconds.`);
    }

    // 3. Work out the new row. The base is the primary's copy: the first copy still in the write.
    let row = null;
    if (op === 'INSERT') {
      row = { payment_id: null, ...fields };
    } else {
      const base = current[tx.avail[0]];
      if (!base) throw httpError(404, `Payment ${paymentId} not found`);
      if (op === 'UPDATE') row = { ...base, ...changes, payment_id: paymentId, store_id: base.store_id };
    }

    // 4. Write every copy still in the write, in lock order.
    for (const n of [...tx.avail]) {
      await tx.onNode(n, async () => {
        if (op === 'INSERT' && row.payment_id === null) {
          // The first copy written picks the ID with its own auto-increment (step 3, offset = node
          // number), so IDs never clash, even between nodes that can't reach each other.
          const [result] = await tx.run(n, 'INSERT INTO payment (customer_id, store_id, amount, payment_date) VALUES (?, ?, ?, ?)', [
            row.customer_id, row.store_id, row.amount, row.payment_date,
          ]);
          row.payment_id = result.insertId;
          tx.paymentId = row.payment_id;
          tx.note(n, `INSERT → new payment_id ${row.payment_id}`);
        } else if (op === 'INSERT') {
          // Every other copy gets the SAME id. A plain INSERT, so a clashing id fails loudly.
          await tx.run(n, 'INSERT INTO payment (payment_id, customer_id, store_id, amount, payment_date) VALUES (?, ?, ?, ?, ?)', [
            row.payment_id, row.customer_id, row.store_id, row.amount, row.payment_date,
          ]);
          tx.note(n, `INSERT payment_id ${row.payment_id}`);
        } else {
          await applyRow(tx.conn(n), op, row, { paymentId, timeout: STATEMENT_TIMEOUT_MS });
          tx.note(n, op === 'DELETE' ? 'DELETE' : 'UPDATE (full row)');
        }
      });
    }
    if (tx.avail.length === 0) throw httpError(503, `Every copy failed (${tx.describeMissing()}). Nothing was saved.`);

    // 5. Log the change for the other copy, in the source's own transaction (transactional outbox).
    const { src, logIds } = await writeLogEntries(tx, row);

    // 6. Commit the source first: from here on, the write is durable and so is its log entry.
    await commitSource(tx, src);
    const committed = [src];

    // 7. Then commit every other copy, and tick its log entry off.
    for (const n of tx.avail.filter((x) => x !== src)) {
      try {
        await tx.commit(n);
        committed.push(n);
        // If this tick fails, the entry stays PENDING and is replayed later: harmless (idempotent).
        await markApplied(getPool(src, 'meta'), logIds[n]).catch(() => {});
      } catch (err) {
        // R1 / R3: the source has the write, this copy doesn't. Record the miss right away so every
        // app sees this node as RECOVERING; the recovery worker will replay the entry.
        const reason = describeError(err);
        tx.missing.set(n, 'commit failed');
        tx.note(n, `COMMIT failed (${reason}); it will get this write from the log`);
        if (isConnectionError(err)) markDown(n, `write failed: ${reason}`);
        await markMissed(getPool(src, 'meta'), logIds[n], `commit failed: ${reason}`).catch(() => {});
      }
    }

    const result = tx.result({ row, src, committed });
    console.log(`[write] ${tx.summary(result)}`);
    return result;
  } catch (err) {
    await tx.rollbackAll();
    const mapped = mapError(err, tx);
    console.warn(`[write] ${tx.id.slice(0, 8)} ${op} ${tx.paymentId ?? ''} failed: ${mapped.message}`);
    throw mapped;
  }
}

// D9 + D16: before writing copy n directly, look in the OTHER copy's log for older PENDING writes
// to this row aimed at n. Every such entry is stored there: the row has two copies, and an entry
// is always written by the copy that committed.
async function catchUpGuard(tx, current) {
  for (const n of [...tx.avail]) {
    const other = tx.copies.find((c) => c !== n);
    if (getStatus(other) === STATUS.DOWN) {
      tx.note(n, `couldn't check ${NODES[other].name}'s log (it is DOWN): see §5.8 "overlapping failures"`);
      continue;
    }

    // A separate autocommit read sees the latest committed log. No lock is needed: new entries for
    // this row can only be added by a writer holding its row lock, and we hold it.
    let entries;
    try {
      entries = await pendingFor(getPool(other, 'meta'), tx.paymentId, n, { timeout: STATEMENT_TIMEOUT_MS });
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      tx.note(n, `couldn't check ${NODES[other].name}'s log (${describeError(err)})`);
      continue;
    }
    if (entries.length === 0) continue;

    // If n's row already equals what the newest entry would write, n has those writes (e.g. the
    // writer that made them committed n but hasn't ticked them off yet): tick them off and go on.
    if (rowMatchesEntry(current[n], entries.at(-1))) {
      try {
        await markApplied(getPool(other, 'meta'), entries.map((e) => e.log_id));
        tx.note(n, `${plural(entries.length, 'older log entry', 'older log entries')} already applied here → marked APPLIED`);
        continue;
      } catch (err) {
        // Still PENDING, so a replay could later overwrite this write on n: treat n as behind.
        tx.note(n, `couldn't tick off older log entries (${describeError(err)})`);
      }
    }

    // n is behind: don't write it now. This write joins the log behind the older ones, and the
    // recovery worker replays them all in order.
    tx.note(n, `behind: ${plural(entries.length, 'older write')} to this row not applied here yet → this write is queued in the log`);
    await tx.drop(n, 'behind');
  }
}

// One entry for the other copy, inserted inside the source's transaction. The source is this
// app's own node when it holds the row, otherwise Node 1; if that copy isn't in the write, the
// first copy that is. If the source fails right here, the next copy becomes the source.
async function writeLogEntries(tx, row) {
  for (;;) {
    const src = tx.avail.includes(tx.preferredSource) ? tx.preferredSource : tx.avail[0];
    if (src === undefined) throw httpError(503, `Every copy failed (${tx.describeMissing()}). Nothing was saved.`);
    const logIds = {};
    const ok = await tx.onNode(src, async () => {
      for (const target of tx.copies.filter((t) => t !== src)) {
        const why = tx.missing.get(target);
        logIds[target] = await insertLogEntry(tx.conn(src), {
          txnId: tx.id,
          source: src,
          target,
          op: tx.op,
          paymentId: tx.paymentId,
          payload: row,
          lastError: why ? `not written: ${why}` : null, // a known miss counts at once (§5.1)
          timeout: STATEMENT_TIMEOUT_MS,
        });
        tx.note(src, `log entry #${logIds[target]} for ${NODES[target].name}${why ? ` (missed: ${why})` : ''}`);
      }
    });
    if (ok) return { src, logIds };
  }
}

async function commitSource(tx, src) {
  try {
    await tx.commit(src);
  } catch (err) {
    // A lost connection during COMMIT leaves the outcome unknown. Either way the copies end up
    // consistent: if it committed, so did its log entry, and the other copy is replayed from it;
    // if not, nothing was written anywhere (the other copies are rolled back below).
    if (isConnectionError(err)) markDown(src, `write failed: ${describeError(err)}`);
    throw httpError(503, `Lost ${NODES[src].name} while committing, so the write may or may not have been saved. Check payment ${tx.paymentId} before retrying.`);
  }
}

// ---------- one global transaction: a local transaction on each copy ----------

class GlobalTransaction {
  constructor({ op, paymentId, storeId, isolationLevel }) {
    this.id = randomUUID();
    this.op = op;
    this.paymentId = paymentId;
    this.storeId = storeId;
    this.isolationLevel = isolationLevel;
    this.home = homeNode(storeId);
    this.copies = [1, this.home]; // the fixed lock order
    this.preferredSource = this.copies.includes(config.nodeId) ? config.nodeId : 1;
    this.avail = this.copies.filter((n) => isAvailable(n)); // copies taking part in the write
    this.missing = new Map(); // copy → why it isn't written now ('down' | 'recovering' | 'behind' | ...)
    for (const n of this.copies) if (!this.avail.includes(n)) this.missing.set(n, getStatus(n).toLowerCase());
    this.conns = new Map(); // copy → connection with an open local transaction
    this.started = performance.now();
    this.timeline = [];
    for (const [n, why] of this.missing) this.note(n, `skipped: ${why}`);
  }

  note(node, text) {
    this.timeline.push({ ms: Math.round(performance.now() - this.started), node, text });
  }

  conn(n) {
    return this.conns.get(n);
  }

  run(n, sql, params = []) {
    return this.conns.get(n).query({ sql, timeout: STATEMENT_TIMEOUT_MS }, params);
  }

  async begin(n) {
    this.conns.set(n, await getPool(n).getConnection());
    // isolationLevel was checked against ISOLATION_LEVELS, so it is safe to put in the SQL.
    await this.run(n, `SET TRANSACTION ISOLATION LEVEL ${this.isolationLevel}`);
    await this.run(n, 'START TRANSACTION');
    this.note(n, 'BEGIN');
  }

  // SELECT … FOR UPDATE: wait for (then hold) this copy's row lock until COMMIT / ROLLBACK.
  async lockRow(n) {
    const t0 = performance.now();
    const [rows] = await this.run(
      n,
      'SELECT payment_id, customer_id, store_id, amount, payment_date FROM payment WHERE payment_id = ? FOR UPDATE',
      [this.paymentId],
    );
    const waited = Math.round(performance.now() - t0);
    this.note(n, `locked row ${this.paymentId}${waited >= 50 ? ` (waited ${waited} ms for another write)` : ''}${rows[0] ? '' : ' (not on this copy)'}`);
    return rows[0] ?? null;
  }

  async commit(n) {
    try {
      await this.run(n, 'COMMIT');
      this.note(n, 'COMMIT');
      this.release(n);
    } catch (err) {
      this.release(n, { broken: true });
      throw err;
    }
  }

  // Runs one step on copy n. If n can't be reached, n leaves the write (it gets the change later
  // from the log) and this returns false; any other error aborts the whole write.
  async onNode(n, step) {
    try {
      await step();
      return true;
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      const reason = describeError(err);
      markDown(n, `write failed: ${reason}`);
      this.note(n, `lost connection (${reason})`);
      await this.drop(n, 'down', { broken: true });
      return false;
    }
  }

  // Takes copy n out of the write: roll back its local transaction and remember why.
  async drop(n, why, { broken = false } = {}) {
    await this.rollback(n, { broken });
    this.avail = this.avail.filter((x) => x !== n);
    this.missing.set(n, why);
  }

  async rollback(n, { broken = false } = {}) {
    const conn = this.conns.get(n);
    if (!conn) return;
    if (!broken) {
      try {
        await conn.query('ROLLBACK');
      } catch {
        broken = true;
      }
    }
    this.release(n, { broken });
  }

  async rollbackAll() {
    await Promise.all([...this.conns.keys()].map((n) => this.rollback(n)));
  }

  // A broken connection is thrown away instead of going back to the pool.
  release(n, { broken = false } = {}) {
    const conn = this.conns.get(n);
    if (!conn) return;
    this.conns.delete(n);
    if (broken) conn.destroy();
    else conn.release();
  }

  describeMissing() {
    return [...this.missing].map(([n, why]) => `${NODES[n].name} ${why}`).join(', ') || 'none';
  }

  result({ row, src, committed }) {
    const lockOrder = (a, b) => this.copies.indexOf(a) - this.copies.indexOf(b);
    return {
      txnId: this.id,
      op: this.op,
      paymentId: this.paymentId,
      storeId: this.storeId,
      payment: row, // the row as it is now (null after a DELETE)
      copies: this.copies,
      source: src,
      committed: committed.sort(lockOrder),
      pending: [...this.missing].map(([node, why]) => ({ node, why })).sort((a, b) => lockOrder(a.node, b.node)),
      isolationLevel: this.isolationLevel,
      ms: Math.round(performance.now() - this.started),
      timeline: this.timeline,
    };
  }

  summary(r) {
    const names = (ids) => ids.map((n) => NODES[n].name).join(' + ') || 'none';
    const pending = r.pending.length ? r.pending.map((p) => `${NODES[p.node].name} (${p.why})`).join(', ') : 'none';
    return `${r.txnId.slice(0, 8)} ${r.op} payment ${r.paymentId} (store ${r.storeId}): committed ${names(r.committed)}; pending ${pending}; source ${NODES[r.source].name}; ${r.isolationLevel}; ${r.ms} ms`;
  }
}

// ---------- errors ----------

function mapError(err, tx) {
  if (err.status) return err;
  if (err.code === 'ER_LOCK_WAIT_TIMEOUT') {
    return httpError(409, `Another write held payment ${tx.paymentId} for more than ${config.lockWaitTimeoutS} s. Nothing was saved; try again.`);
  }
  if (err.code === 'ER_LOCK_DEADLOCK') return httpError(409, 'MySQL detected a deadlock and cancelled this write. Nothing was saved; try again.');
  if (err.code === 'ER_NO_SUCH_TABLE') return httpError(500, 'The replication_log table is missing. Run sql/01_schema.sql on every node.');
  if (err.code === 'ER_DUP_ENTRY') {
    return httpError(500, `Payment id ${tx.paymentId} already exists on a copy: check the auto-increment settings (sql/99_verify.sql).`);
  }
  if (isConnectionError(err)) return httpError(503, `Lost a node during the write (${describeError(err)}). Nothing was saved.`);
  return err;
}

function httpError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  if (details) err.details = details;
  return err;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
