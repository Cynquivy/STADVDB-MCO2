// Reads .env and describes the three nodes.
// Every other module imports from here, so the node map and the store → home-node rule
// live in exactly one place.
import 'dotenv/config';

export const NODE_IDS = [1, 2, 3];
export const STORE_IDS = [1, 2];
export const ISOLATION_LEVELS = ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'];

function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} must be a number (got "${raw}")`);
  return value;
}

function readNode(id, { role, stores }) {
  const host = process.env[`NODE${id}_HOST`];
  if (!host) throw new Error(`NODE${id}_HOST is not set. Copy .env.example to .env and fill it in.`);
  return {
    id,
    name: `Node ${id}`,
    role, // 'central' (all rows) or 'fragment' (one store)
    stores, // which store_ids this node holds
    host,
    port: readInt(`NODE${id}_PORT`, 3306),
    appUrl: (process.env[`NODE${id}_APP_URL`] || '').replace(/\/+$/, ''),
  };
}

// Horizontal fragmentation by store_id: Node 1 holds every row, Node 2 and Node 3 one store each.
export const NODES = {
  1: readNode(1, { role: 'central', stores: [1, 2] }),
  2: readNode(2, { role: 'fragment', stores: [1] }),
  3: readNode(3, { role: 'fragment', stores: [2] }),
};

// Every row has exactly two copies: Node 1 and its store's home fragment.
const HOME_NODE_BY_STORE = { 1: 2, 2: 3 };

export function homeNode(storeId) {
  const nodeId = HOME_NODE_BY_STORE[storeId];
  if (!nodeId) throw new Error(`store_id must be 1 or 2 (got ${storeId})`);
  return nodeId;
}

const nodeId = readInt('NODE_ID', 0);
if (!NODE_IDS.includes(nodeId)) {
  throw new Error(`NODE_ID must be 1, 2 or 3 (got "${process.env.NODE_ID ?? ''}"). Set it in .env.`);
}

// Normalise "repeatable   read" → "REPEATABLE READ" and reject anything that isn't a real level.
const isolationLevel = (process.env.ISOLATION_LEVEL || 'REPEATABLE READ').trim().toUpperCase().replace(/\s+/g, ' ');
if (!ISOLATION_LEVELS.includes(isolationLevel)) {
  throw new Error(`ISOLATION_LEVEL must be one of: ${ISOLATION_LEVELS.join(', ')} (got "${isolationLevel}")`);
}

export const config = Object.freeze({
  nodeId, // which VM this app instance runs on
  port: readInt('PORT', 80),
  db: Object.freeze({
    name: process.env.DB_NAME || 'mco2',
    user: process.env.DB_USER || 'ddb',
    password: process.env.DB_PASSWORD || '',
  }),
  isolationLevel,
  connectTimeoutMs: readInt('DB_CONNECT_TIMEOUT_MS', 2000),
  lockWaitTimeoutS: readInt('LOCK_WAIT_TIMEOUT_S', 10),
  healthIntervalMs: readInt('HEALTH_INTERVAL_MS', 2000),
  recoveryIntervalMs: readInt('RECOVERY_INTERVAL_MS', 3000),
  pendingGraceMs: readInt('PENDING_GRACE_MS', 5000),
  adminToken: process.env.ADMIN_TOKEN || '',
});
