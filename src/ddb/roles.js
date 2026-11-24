// Primary and secondary copies (docs/decisions.md D14).
//
// Every payment is stored twice: on Node 1 and on its store's home node (D1). For each store:
//   PRIMARY   = the copy whose row lock a write takes first: the first copy in the fixed lock order
//               (Node 1, then the home node) that is UP (§5.3). Writes to that store are serialized there.
//   SECONDARY = the other copy, if it is UP.
//
// So Node 1 is normally primary for both stores. When Node 1 is DOWN or RECOVERING, each fragment
// takes over as primary for its own store. Node 1 takes the role back once it is UP again, which
// means it has also received the writes it missed (§5.1).
//
// There is no vote. Every app applies this same rule to its own view of node status, so all apps
// agree within one health-check interval without sending each other any messages.
import { NODES, NODE_IDS, STORE_IDS, homeNode } from '../config.js';

const MAX_EVENTS = 20;

let current = null; // the latest roles
const events = []; // changes of primary, newest first

/**
 * Roles for one view of node status.
 * @param {(nodeId: number) => string} statusOf  'UP' | 'DOWN' | 'RECOVERING'
 */
export function computeRoles(statusOf) {
  const stores = {};
  for (const s of STORE_IDS) {
    const copies = [1, homeNode(s)]; // the fixed lock order
    const up = copies.filter((n) => statusOf(n) === 'UP');
    stores[s] = {
      copies,
      primary: up[0] ?? null,
      secondary: up[1] ?? null,
      failover: up.length > 0 && up[0] !== copies[0], // a fragment is standing in for Node 1
    };
  }

  const nodes = {};
  for (const id of NODE_IDS) {
    const primaryFor = STORE_IDS.filter((s) => stores[s].primary === id);
    const secondaryFor = STORE_IDS.filter((s) => stores[s].secondary === id);
    const role = primaryFor.length ? 'PRIMARY' : secondaryFor.length ? 'SECONDARY' : 'NONE';
    nodes[id] = { role, primaryFor, secondaryFor };
  }
  return { stores, nodes };
}

// Called by the health check after every status change. Records and logs each change of primary.
export function updateRoles(statusOf) {
  const next = computeRoles(statusOf);
  for (const s of STORE_IDS) {
    const before = current ? current.stores[s].primary : undefined;
    const after = next.stores[s].primary;
    if (before === after) continue;
    const message = describeChange(s, before, after, statusOf);
    console.log(`[roles] ${message}`);
    if (current) {
      events.unshift({ at: new Date().toISOString(), store: s, from: before, to: after, message });
      events.length = Math.min(events.length, MAX_EVENTS);
    }
  }
  current = next;
}

export function getRoles() {
  return current && { ...current, events };
}

function describeChange(store, before, after, statusOf) {
  const name = (id) => NODES[id].name;
  if (after === null) return `Store ${store}: no primary, because no copy is UP`;
  if (before === undefined) return `Store ${store}: ${name(after)} is primary`; // app just started
  if (before !== null && statusOf(before) !== 'UP') {
    return `Store ${store}: ${name(after)} took over as primary (${name(before)} is ${statusOf(before)})`;
  }
  return `Store ${store}: ${name(after)} is primary again`;
}
