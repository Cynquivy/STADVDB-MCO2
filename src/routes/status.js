// Node status API, used by the status page (and later by the demo and test scripts).
import os from 'node:os';
import { Router } from 'express';
import { config, NODES } from '../config.js';
import { refreshNow, snapshot } from '../db/health.js';

const router = Router();
const startedAt = new Date().toISOString();

// "Which node am I?" Other app instances call this to check that this VM's app is running.
router.get('/whoami', (req, res) => {
  const node = NODES[config.nodeId];
  res.json({
    nodeId: node.id,
    name: node.name,
    role: node.role,
    stores: node.stores,
    hostname: os.hostname(),
    startedAt,
  });
});

// Latest result of the background health check (cheap: nothing is queried here).
router.get('/status', (req, res) => {
  res.json(snapshot());
});

// The page's "Check now" button: run a check immediately instead of waiting for the next one.
router.post('/status/refresh', async (req, res) => {
  await refreshNow();
  res.json(snapshot());
});

export default router;
