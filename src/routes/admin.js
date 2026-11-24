// Failure injection (CLAUDE.md §5.7): stop ("kill") or start ("restore") MySQL on a node, for the
// demo and the test scripts. Only the database stops; the node's app keeps running, which is what
// lets the same button restore it afterwards.
//
//   POST /api/admin/nodes/:id/mysql/stop|start   used by the status page: asks node :id's app to do it
//   POST /api/admin/mysql/stop|start             runs `systemctl stop|start mysql` on THIS VM
//
// Every request needs the X-Admin-Token header to match ADMIN_TOKEN (the same value on all three
// VMs). With ADMIN_TOKEN empty, these endpoints are switched off: the app is on a public address.
import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Router } from 'express';
import { config, NODES, NODE_IDS } from '../config.js';
import { refreshNow } from '../db/health.js';

const run = promisify(execFile);
const router = Router();
const ACTIONS = ['stop', 'start'];
const FORWARD_TIMEOUT_MS = 45_000; // starting MySQL can take a while

router.use('/admin', requireToken);

// The status page's Kill / Restore buttons. The page talks only to the app that served it; that
// app forwards the request to the target node's app, because only that VM can run its systemctl.
router.post('/admin/nodes/:id/mysql/:action', async (req, res) => {
  const nodeId = Number(req.params.id);
  const action = req.params.action;
  if (!NODE_IDS.includes(nodeId) || !ACTIONS.includes(action)) {
    return res.status(404).json({ error: 'Use /api/admin/nodes/1|2|3/mysql/stop|start' });
  }
  const node = NODES[nodeId];
  if (!node.appUrl) return res.status(500).json({ error: `NODE${nodeId}_APP_URL is not set in .env` });

  let answer;
  try {
    const response = await fetch(`${node.appUrl}/api/admin/mysql/${action}`, {
      method: 'POST',
      headers: { 'X-Admin-Token': config.adminToken },
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    answer = { status: response.status, body: await response.json().catch(() => ({})) };
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'timed out' : err.cause?.code || err.message;
    return res.status(502).json({ error: `${node.name}'s app did not answer (${why}). Is it running?` });
  }

  await refreshNow({ fresh: true }); // show the new status on this app's page at once
  if (answer.status === 403) {
    const why = answer.body.error ?? 'refused';
    return res.status(502).json({ error: `${node.name}'s app: ${why}. ADMIN_TOKEN must be the same on all three VMs.` });
  }
  res.status(answer.status).json(answer.body);
});

// Runs on the VM whose MySQL should stop or start. The app runs as root under pm2, so it may.
router.post('/admin/mysql/:action', async (req, res) => {
  const action = req.params.action;
  if (!ACTIONS.includes(action)) return res.status(404).json({ error: 'Use /api/admin/mysql/stop or /start' });
  if (process.platform !== 'linux') {
    return res.status(501).json({ error: 'systemctl only exists on the VMs, not on this machine' });
  }

  const node = NODES[config.nodeId];
  const started = Date.now();
  console.log(`[admin] ${action === 'stop' ? 'Killing' : 'Restoring'} ${node.name}: systemctl ${action} mysql`);
  try {
    await run('systemctl', [action, 'mysql'], { timeout: FORWARD_TIMEOUT_MS - 5_000 });
  } catch (err) {
    console.error(`[admin] systemctl ${action} mysql failed: ${err.stderr || err.message}`);
    return res.status(500).json({ error: `systemctl ${action} mysql failed: ${(err.stderr || err.message).trim()}` });
  }
  // `is-active` exits non-zero when MySQL is stopped, which is expected after a stop.
  const mysql = await run('systemctl', ['is-active', 'mysql']).then((r) => r.stdout.trim(), (err) => err.stdout?.trim() || 'unknown');
  console.log(`[admin] ${node.name}: MySQL is now ${mysql} (${Date.now() - started} ms)`);
  refreshNow({ fresh: true }).catch(() => {}); // this app's own status page updates too
  res.json({ ok: true, node: node.id, action, mysql, ms: Date.now() - started });
});

function requireToken(req, res, next) {
  if (!config.adminToken) {
    return res.status(403).json({ error: 'Kill / Restore are off on this app: set ADMIN_TOKEN in its .env' });
  }
  const given = req.get('X-Admin-Token');
  if (!given) return res.status(401).json({ error: 'Admin token required (X-Admin-Token header)' });
  if (!sameSecret(given, config.adminToken)) return res.status(403).json({ error: 'Wrong admin token' });
  next();
}

// Compares hashes in constant time, so response timing doesn't reveal how much of a guess was right.
function sameSecret(a, b) {
  const hash = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}

export default router;
