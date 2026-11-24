// Entry point. The same app runs on all three VMs; only .env differs (mainly NODE_ID).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, NODES } from './config.js';
import { startHealthChecks, stopHealthChecks } from './db/health.js';
import { closeAllPools } from './db/pools.js';
import statusRoutes from './routes/status.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const thisNode = NODES[config.nodeId];
const app = express();

app.use(express.json());
app.use('/api', statusRoutes);

app.get('/', (req, res) => res.redirect('/status.html'));
app.use(express.static(path.join(here, 'public')));

// Unknown API routes and errors return JSON that still says which node's app answered.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found', app: thisNode.name }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message, app: thisNode.name });
});

function exitOnListenError(err) {
  const hint = err.code === 'EADDRINUSE' ? ` Something else is using port ${config.port}.` : '';
  console.error(`[server] could not listen on port ${config.port}: ${err.message}.${hint}`);
  process.exit(1);
}

const server = app.listen(config.port, (err) => {
  if (err) return exitOnListenError(err);
  console.log(`[server] ${thisNode.name} app (${thisNode.role}) listening on port ${config.port}`);
  console.log(`[server] isolation level default: ${config.isolationLevel}`);
  if (!config.db.password) console.warn('[server] DB_PASSWORD is empty, so database logins will fail. Set it in .env.');
});
server.on('error', exitOnListenError);

startHealthChecks();

// pm2 sends SIGINT on reload/stop: finish cleanly so no database connections are left half-open.
function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  stopHealthChecks();
  server.close(() => closeAllPools().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref(); // don't hang forever on a stuck connection
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
