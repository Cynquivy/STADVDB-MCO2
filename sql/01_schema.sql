-- Run on ALL THREE nodes. Safe to re-run: it only creates what is missing.
--   On a VM (after deploying):  mysql < /opt/mco2/sql/01_schema.sql
--
-- `payment` already exists on every node (loaded during setup), so IF NOT EXISTS leaves it and
-- its rows untouched. It is here so the schema is documented in one place (CLAUDE.md §3).
USE mco2;

CREATE TABLE IF NOT EXISTS payment (
  payment_id   INT UNSIGNED      NOT NULL AUTO_INCREMENT,
  customer_id  SMALLINT UNSIGNED NOT NULL,
  store_id     TINYINT UNSIGNED  NOT NULL,   -- fragmentation key: store 1 → Node 2, store 2 → Node 3
  amount       DECIMAL(5,2)      NOT NULL,
  payment_date DATETIME          NOT NULL,
  PRIMARY KEY (payment_id),
  KEY idx_store (store_id)
) ENGINE=InnoDB;

-- Writes that still have to reach another node (CLAUDE.md §5.5). One per node, same schema everywhere.
-- An entry is written in the SAME transaction as the local write, so a committed write can never
-- lose the record of the copies it still owes.
CREATE TABLE IF NOT EXISTS replication_log (
  log_id      BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  txn_id      CHAR(36)         NOT NULL,           -- global transaction id (UUID)
  source_node TINYINT UNSIGNED NOT NULL,           -- the node whose log this is
  target_node TINYINT UNSIGNED NOT NULL,           -- the node that still needs the write
  op          ENUM('INSERT','UPDATE','DELETE') NOT NULL,
  payment_id  INT UNSIGNED     NOT NULL,
  payload     JSON             NULL,               -- full row after the change (INSERT/UPDATE)
  status      ENUM('PENDING','APPLIED','FAILED') NOT NULL DEFAULT 'PENDING',
  attempts    INT UNSIGNED     NOT NULL DEFAULT 0,
  last_error  VARCHAR(255)     NULL,               -- set = the target is known to have missed this write
  created_at  DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  applied_at  DATETIME(3)      NULL,
  PRIMARY KEY (log_id),
  KEY idx_pending (status, target_node, log_id),          -- recovery worker + status counts
  KEY idx_row_pending (payment_id, target_node, status)   -- catch-up guard lookup (§5.3)
) ENGINE=InnoDB;
