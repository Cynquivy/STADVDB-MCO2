// Telling "we couldn't reach this node" apart from ordinary SQL errors.
//
// A connection error means the node crashed, MySQL was stopped, the network failed, or we can't
// log in. The app then treats the node as DOWN and uses another copy of the data.
// Any other error (bad SQL, a lock wait timeout, ...) came from a node that is working, so
// switching to another node wouldn't help.

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', // nothing listening: MySQL is stopped
  'ECONNRESET',
  'ETIMEDOUT', // no answer within DB_CONNECT_TIMEOUT_MS
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST', // MySQL closed the connection (e.g. systemctl stop mysql mid-query)
  'PROTOCOL_SEQUENCE_TIMEOUT', // a query got no answer within its timeout
  'ER_SERVER_SHUTDOWN', // MySQL is shutting down
  'ER_CLIENT_INTERACTION_TIMEOUT', // MySQL dropped an idle connection
  'ER_ACCESS_DENIED_ERROR', // wrong password: this app can't use the node at all
  'ER_CON_COUNT_ERROR', // too many connections
]);

export function isConnectionError(err) {
  // mysql2 sets `fatal` on errors that broke the connection itself.
  return err?.fatal === true || CONNECTION_ERROR_CODES.has(err?.code);
}

// A short one-line description, e.g. "ECONNREFUSED: connect ECONNREFUSED 10.20.200.245:3306".
export function describeError(err) {
  const message = err.message || err.errors?.[0]?.message || '';
  if (!err.code) return message || String(err);
  return message && !message.includes(err.code) ? `${err.code}: ${message}` : message || err.code;
}
