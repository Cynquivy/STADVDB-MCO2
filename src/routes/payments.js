// Payments API (step 2: reads). The routing and fallback logic is in src/ddb/; this file only checks
// the request's input and shapes the response.
//
//   GET /api/payments?store=&id=&customer=&from=&to=&min=&max=&limit=&offset=
//   GET /api/payments/:id
import { Router } from 'express';
import { config, NODES, STORE_IDS } from '../config.js';
import { findPayments } from '../ddb/reads.js';

const router = Router();
const app = { nodeId: config.nodeId, name: NODES[config.nodeId].name }; // the app that answered

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_PAYMENT_ID = 4294967295; // INT UNSIGNED
const MAX_CUSTOMER_ID = 65535; // SMALLINT UNSIGNED

// List and search. Every filter is optional; with none, it lists every payment, newest first.
router.get('/payments', async (req, res) => {
  const filters = parseFilters(req.query);
  const page = {
    limit: intParam(req.query, 'limit', 'limit', { min: 1, max: MAX_LIMIT }) ?? DEFAULT_LIMIT,
    offset: intParam(req.query, 'offset', 'offset', { min: 0, max: 1_000_000 }) ?? 0,
  };
  res.json({ app, ...(await findPayments(filters, page)) });
});

// One payment by ID. Its store isn't known yet, so it is looked up like "every store" (§5.2).
router.get('/payments/:id', async (req, res) => {
  const paymentId = intParam(req.params, 'id', 'payment ID', { min: 1, max: MAX_PAYMENT_ID });
  const { rows, total, limit, offset, ...route } = await findPayments({ paymentId }, { limit: 1, offset: 0 });
  if (rows.length === 0) {
    return res.status(404).json({ error: `Payment ${paymentId} not found`, app, ...route });
  }
  res.json({ app, ...route, payment: rows[0] });
});

// ---------- input checks: anything invalid gets a 400 with a clear message ----------

function parseFilters(query) {
  return {
    paymentId: intParam(query, 'id', 'payment ID', { min: 1, max: MAX_PAYMENT_ID }),
    storeId: storeParam(query),
    customerId: intParam(query, 'customer', 'customer ID', { min: 1, max: MAX_CUSTOMER_ID }),
    dateFrom: dateParam(query, 'from', '"from" date'),
    dateTo: dateParam(query, 'to', '"to" date'),
    minAmount: amountParam(query, 'min', 'minimum amount'),
    maxAmount: amountParam(query, 'max', 'maximum amount'),
  };
}

function storeParam(query) {
  const raw = rawParam(query, 'store');
  if (raw === null) return null;
  const storeId = Number(raw);
  if (!STORE_IDS.map(String).includes(raw)) throw badRequest(`store must be ${STORE_IDS.join(' or ')}`);
  return storeId;
}

// Returns null when the parameter is missing or empty.
function rawParam(source, key) {
  const raw = source[key];
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw badRequest(`${key} was given more than once`);
  return raw.trim();
}

function intParam(source, key, label, { min, max }) {
  const raw = rawParam(source, key);
  if (raw === null) return null;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max) {
    throw badRequest(`${label} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function dateParam(source, key, label) {
  const raw = rawParam(source, key);
  if (raw === null) return null;
  // Real calendar dates only: "2005-02-30" would become March 2, so compare the round trip.
  const date = new Date(`${raw}T00:00:00Z`);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(date.getTime()) && date.toISOString().startsWith(raw);
  if (!valid) throw badRequest(`${label} must be a date like 2005-05-25`);
  return raw;
}

function amountParam(source, key, label) {
  const raw = rawParam(source, key);
  if (raw === null) return null;
  // amount is DECIMAL(5,2): at most 999.99, two decimals.
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) throw badRequest(`${label} must be an amount from 0 to 999.99`);
  return Number(raw);
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

export default router;
