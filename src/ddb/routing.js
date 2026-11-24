// Read routing (CLAUDE.md §5.2): which node(s) can answer a read, best choice first.
//
// Users never pick a node. Every payment is stored in exactly two places (Node 1 and its store's
// home node), so every read has a first choice and a fallback.
import { config, NODES, homeNode } from '../config.js';

/**
 * The ways to answer a read, best first. Each option is a set of nodes that TOGETHER hold every
 * row the read could return. reads.js uses the first option whose nodes are all UP.
 *
 *   one store s, app on a node that holds s   → [this node]  then [the other copy]
 *   one store s, app on the other fragment    → [home of s]   then [Node 1]
 *   every store (or store unknown, e.g. by ID) → [Node 1]     then [Node 2 + Node 3]
 *
 * @param {number|null} storeId  1 or 2 to read one store, null for every store
 * @param {number} localNodeId   the node this app runs on
 */
export function readOptions(storeId, localNodeId = config.nodeId) {
  if (storeId == null) {
    // Node 1 has every store in one place. Without it, both fragments are needed: together they
    // hold exactly what Node 1 holds (the UNION ALL of Node 2 and Node 3).
    return [
      { nodes: [1], reason: 'Node 1 holds every payment' },
      { nodes: [2, 3], reason: 'Node 2 (store 1) + Node 3 (store 2) together hold every payment' },
    ];
  }

  // One store: its rows are on Node 1 and on the store's home node. Prefer this app's own node
  // when it is one of them (its database is on the same VM); otherwise prefer the home node,
  // which holds only this store's rows.
  const home = homeNode(storeId);
  const first = localNodeId === 1 || localNodeId === home ? localNodeId : home;
  const second = first === 1 ? home : 1;
  return [
    {
      nodes: [first],
      reason: first === localNodeId
        ? `this app's own node holds store ${storeId}`
        : `${NODES[home].name} is store ${storeId}'s home node`,
    },
    { nodes: [second], reason: `${NODES[second].name} also holds store ${storeId}` },
  ];
}
