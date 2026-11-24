// One connection pool per node. Every app instance talks to all three databases directly:
// over the internal network on the cloud, or through the public port forwards from a laptop.
import mysql from 'mysql2/promise';
import { config, NODES } from '../config.js';

// Settings shared by the pools and by the health check's one-off connections.
export function connectionOptions(nodeId) {
  const node = NODES[nodeId];
  return {
    host: node.host,
    port: node.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name,
    connectTimeout: config.connectTimeoutMs, // detect a crashed node in seconds, not minutes
    dateStrings: true, // keep DATETIME exactly as stored (no timezone shifts), so copies and checksums match
    decimalNumbers: true, // DECIMAL amounts come back as numbers instead of strings
  };
}

const pools = new Map();

// Two pools per node:
//   'main' : transactions (reads and writes). A write holds one connection per copy until it commits.
//   'meta' : short autocommit bookkeeping queries that a write makes WHILE holding its 'main'
//            connections (reading or ticking off replication_log entries). If these came from the
//            same pool, 10 concurrent writers could hold every connection and wait forever for an
//            11th, so they get their own small pool.
const POOL_SIZE = { main: 10, meta: 4 };

export function getPool(nodeId, kind = 'main') {
  const key = `${kind}:${nodeId}`;
  if (!pools.has(key)) {
    const pool = mysql.createPool({
      ...connectionOptions(nodeId),
      connectionLimit: POOL_SIZE[kind],
      waitForConnections: true,
      enableKeepAlive: true,
      maxIdle: 2,
      idleTimeout: 30_000, // drop idle connections, so ones broken by a MySQL restart don't linger
    });

    // Each new connection gets our lock wait timeout, so a transaction blocked by another
    // transaction's row lock gives up after LOCK_WAIT_TIMEOUT_S instead of MySQL's default 50 s.
    // (pool.pool is the underlying callback-style pool; its 'connection' event fires before the
    // connection is handed out, and the SET runs before any query queued after it.)
    pool.pool.on('connection', (conn) => {
      conn.query(`SET SESSION innodb_lock_wait_timeout = ${Number(config.lockWaitTimeoutS)}`, (err) => {
        if (err) console.warn(`[pools] Node ${nodeId}: could not set lock wait timeout: ${err.message}`);
      });
    });

    pools.set(key, pool);
  }
  return pools.get(key);
}

export async function closeAllPools() {
  await Promise.allSettled([...pools.values()].map((pool) => pool.end()));
  pools.clear();
}
