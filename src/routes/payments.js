// Payments API. The routing, replication and fallback logic is in src/ddb/; this file checks the
// request's input and shapes the response.
//
//   GET    /api/payments?store=&id=&customer=&from=&to=&min=&max=&limit=&offset=&isolation=
//   GET    /api/payments/:id
//   POST   /api/payments        { store_id, customer_id, amount, payment_date?, isolation? }
//   PATCH  /api/payments/:id    { customer_id?, amount?, payment_date?, isolation? }  (store_id can't change)
//   DELETE /api/payments/:id?isolation=
//
// `isolation` is optional on every request (READ UNCOMMITTED, READ COMMITTED, REPEATABLE READ or
// SERIALIZABLE); without it, ISOLATION_LEVEL from .env is used. This is how the tests run every
// case under all four levels.
import { Router } from 'express';
import { config, ISOLATION_LEVELS, NODES, STORE_IDS } from '../config.js';
import { findPayments } from '../ddb/reads.js';
import { deletePayment, insertPayment, updatePayment } from '../ddb/writes.js';

const router = Router();
const app = { nodeId: config.nodeId, name: NODES[config.nodeId].name }; // the app that answered

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_PAYMENT_ID = 4294967295; // INT UNSIGNED
const MAX_CUSTOMER_ID = 65535; // SMALLINT UNSIGNED

// ---------- reads (step 2) ----------

// List and search. Every filter is optional; with none, it lists every payment, newest first.
router.get('/payments', async (req, res) => {
  const q = req.query;
  const filters = {
    paymentId: intValue(one(q, 'id'), 'payment ID', 1, MAX_PAYMENT_ID),
    storeId: storeValue(one(q, 'store')),
    customerId: intValue(one(q, 'customer'), 'customer ID', 1, MAX_CUSTOMER_ID),
    dateFrom: dateValue(one(q, 'from'), '"from" date'),
    dateTo: dateValue(one(q, 'to'), '"to" date'),
    minAmount: amountValue(one(q, 'min'), 'minimum amount'),
    maxAmount: amountValue(one(q, 'max'), 'maximum amount'),
  };
  const page = {
    limit: intValue(one(q, 'limit'), 'limit', 1, MAX_LIMIT) ?? DEFAULT_LIMIT,
    offset: intValue(one(q, 'offset'), 'offset', 0, 1_000_000) ?? 0,
  };
  res.json({ app, ...(await findPayments(filters, page, isolation(one(q, 'isolation')))) });
});

// One payment by ID. Its store isn't known yet, so it is looked up like "every store" (§5.2).
router.get('/payments/:id', async (req, res) => {
  const paymentId = intValue(req.params.id, 'payment ID', 1, MAX_PAYMENT_ID);
  const opts = isolation(one(req.query, 'isolation'));
  const { rows, total, limit, offset, ...route } = await findPayments({ paymentId }, { limit: 1, offset: 0 }, opts);
  if (rows.length === 0) {
    return res.status(404).json({ error: `Payment ${paymentId} not found`, app, ...route });
  }
  res.json({ app, ...route, payment: rows[0] });
});

// ---------- writes (step 3): see src/ddb/writes.js for the protocol ----------

router.post('/payments', async (req, res) => {
  const body = bodyOf(req);
  const fields = {
    store_id: required(storeValue(body.store_id), 'store_id'),
    customer_id: required(intValue(body.customer_id, 'customer_id', 1, MAX_CUSTOMER_ID), 'customer_id'),
    amount: required(amountValue(body.amount, 'amount'), 'amount'),
    payment_date: dateTimeValue(body.payment_date) ?? now(), // computed ONCE here, so both copies get the same value
  };
  res.status(201).json({ app, ...(await insertPayment(fields, isolation(body.isolation))) });
});

router.patch('/payments/:id', async (req, res) => {
  const paymentId = intValue(req.params.id, 'payment ID', 1, MAX_PAYMENT_ID);
  const body = bodyOf(req);
  if (body.payment_id !== undefined && Number(body.payment_id) !== paymentId) throw badRequest('payment_id can\'t be changed');
  const changes = {};
  const customer = intValue(body.customer_id, 'customer_id', 1, MAX_CUSTOMER_ID);
  const amount = amountValue(body.amount, 'amount');
  const date = dateTimeValue(body.payment_date);
  if (customer !== null) changes.customer_id = customer;
  if (amount !== null) changes.amount = amount;
  if (date !== null) changes.payment_date = date;
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to change: send customer_id, amount or payment_date');

  // store_id decides where the row lives, so it can never change (rows never move between fragments).
  const store = storeValue(body.store_id);
  if (store !== null) {
    const { rows } = await findPayments({ paymentId }, { limit: 1, offset: 0 });
    if (rows[0] && rows[0].store_id !== store) throw badRequest('store_id can\'t be changed');
  }
  res.json({ app, ...(await updatePayment(paymentId, changes, isolation(body.isolation))) });
});

router.delete('/payments/:id', async (req, res) => {
  const paymentId = intValue(req.params.id, 'payment ID', 1, MAX_PAYMENT_ID);
  const level = one(req.query, 'isolation') ?? req.body?.isolation;
  res.json({ app, ...(await deletePayment(paymentId, isolation(level))) });
});

// ---------- input checks: anything invalid gets a 400 with a clear message ----------

function bodyOf(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw badRequest('Send a JSON object (Content-Type: application/json)');
  }
  return req.body;
}

// A query parameter, or null when missing or empty.
function one(query, key) {
  const raw = query[key];
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw badRequest(`${key} was given more than once`);
  return raw;
}

// The values below come from query strings or JSON bodies. null / undefined / '' mean "not given".
const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';

function required(value, label) {
  if (value === null) throw badRequest(`${label} is required`);
  return value;
}

function intValue(v, label, min, max) {
  if (!given(v)) return null;
  const raw = String(v).trim();
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max) {
    throw badRequest(`${label} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function storeValue(v) {
  if (!given(v)) return null;
  const raw = String(v).trim();
  if (!STORE_IDS.map(String).includes(raw)) throw badRequest(`store must be ${STORE_IDS.join(' or ')}`);
  return Number(raw);
}

function amountValue(v, label) {
  if (!given(v)) return null;
  const raw = String(v).trim();
  // amount is DECIMAL(5,2): at most 999.99, two decimals.
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) throw badRequest(`${label} must be an amount from 0 to 999.99`);
  return Number(raw);
}

function dateValue(v, label) {
  if (!given(v)) return null;
  const raw = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !realDate(raw)) throw badRequest(`${label} must be a date like 2005-05-25`);
  return raw;
}

// "2005-05-25 11:30", "2005-05-25T11:30:37" (from a datetime-local input), ... → "2005-05-25 11:30:37"
function dateTimeValue(v) {
  if (!given(v)) return null;
  const m = String(v).trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  const ok = m && realDate(m[1]) && Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4] ?? 0) < 60;
  if (!ok) throw badRequest('payment_date must look like 2005-05-25 11:30:00');
  return `${m[1]} ${m[2]}:${m[3]}:${m[4] ?? '00'}`;
}

// Real calendar dates only: "2005-02-30" would become March 2, so compare the round trip.
function realDate(ymd) {
  const date = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(ymd);
}

// The app's local time (the VMs run on Asia/Manila), as MySQL DATETIME text.
function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// "read committed", "READ-COMMITTED", "read_committed" → "READ COMMITTED". Missing → the .env default.
function isolation(v) {
  if (!given(v)) return {};
  const level = String(v).trim().toUpperCase().replace(/[-_\s]+/g, ' ');
  if (!ISOLATION_LEVELS.includes(level)) throw badRequest(`isolation must be one of: ${ISOLATION_LEVELS.join(', ')}`);
  return { isolationLevel: level };
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

export default router;
