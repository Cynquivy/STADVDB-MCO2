-- Read-only checks. Run on each node and compare the results.
--   On a VM:  mysql -t < /opt/mco2/sql/99_verify.sql
USE mco2;

-- 1) Fragments (CLAUDE.md §3): per store, Node 2's (store 1) or Node 3's (store 2) row must
--    match Node 1's row exactly: same count, total and checksum.
SELECT store_id, COUNT(*) AS num_rows, SUM(amount) AS total,
       BIT_XOR(CRC32(CONCAT_WS('|', payment_id, customer_id, store_id, amount, payment_date))) AS checksum
FROM payment GROUP BY store_id;

-- 2) ID generation: expect step 3, and offset 1 on Node 1, 2 on Node 2, 3 on Node 3.
SELECT @@auto_increment_increment AS step, @@auto_increment_offset AS id_offset;

-- 3) The table's ID counter: expect 16050 on every node until the first insert.
--    The next ID a node generates is the first number >= this that fits its offset:
--    Node 1 → 16051, Node 2 → 16052, Node 3 → 16050.
SET SESSION information_schema_stats_expiry = 0;   -- otherwise MySQL may show a cached value
SELECT AUTO_INCREMENT AS next_counter
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'mco2' AND TABLE_NAME = 'payment';
