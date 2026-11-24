// Consistency API (CLAUDE.md M7): the pass/fail check for every test case.
//
//   GET /api/consistency        Node 1 vs Node 2 + Node 3, per store (count, sum, checksum)
//   GET /api/consistency/:id    every copy of one payment, side by side
import { Router } from 'express';
import { config, NODES } from '../config.js';
import { checkConsistency, comparePayment } from '../ddb/consistency.js';

const router = Router();
const app = { nodeId: config.nodeId, name: NODES[config.nodeId].name };

router.get('/consistency', async (req, res) => {
  res.json({ app, ...(await checkConsistency()) });
});

router.get('/consistency/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    const err = new Error('payment ID must be a whole number');
    err.status = 400;
    throw err;
  }
  res.json({ app, ...(await comparePayment(id)) });
});

export default router;
