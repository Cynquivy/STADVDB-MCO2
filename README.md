# STADVDB MCO2: Distributed Payments Database

Our project for STADVDB MCO2 (Transaction Management), DLSU, Term 1 AY 2026–2027.

One modified table of payments from the Sakila DB is spread across **three MySQL servers** on the CCS Cloud. The **same web
app runs on all three**. Users can read and write from any node, and the app:

- keeps every copy of the data consistent,
- keeps working when a node crashes, and
- sends a node the writes it missed once it comes back.

We wrote the replication and recovery logic ourselves (in `src/ddb/`). MySQL's built-in replication
is **not** used; the rubric penalises it.

> **Status:** steps 1 (node status page), 2 (reads) and 3 (writes) are built but not deployed yet. See
> [Running it](#running-it) and the [build plan](#build-plan).

---

## The three nodes

| Node | Role | Holds | App URL |
|---|---|---|---|
| **Node 1** | Central | All 16,044 payments | http://103.231.240.136:10244 |
| **Node 2** | Fragment | Store 1's payments only | http://103.231.240.136:10245 |
| **Node 3** | Fragment | Store 2's payments only | http://103.231.240.136:10246 |

```
                 ┌───────────────────────┐
                 │  Node 1: every row    │
                 └───────────────────────┘
                  ▲                     ▲
       store 1 rows also here    store 2 rows also here
                  ▼                     ▼
       ┌───────────────────┐   ┌───────────────────┐
       │ Node 2: store 1   │   │ Node 3: store 2   │
       └───────────────────┘   └───────────────────┘
```

- Node 2 + Node 3 together = Node 1, and they never share a row.
- So **every payment is stored in exactly two places**: Node 1, and its store's node
  (the row's **home node**).
- A payment's `store_id` can't be changed, so a row never moves to the other fragment.

The table (identical on all three nodes):

| Column | Meaning |
|---|---|
| `payment_id` | Unique ID. Each node generates different numbers, so new IDs never clash. |
| `customer_id` | Who paid |
| `store_id` | 1 or 2. Decides the home node. |
| `amount` | How much |
| `payment_date` | When |

---

## How it works

### Reading
Users never pick a node; the app picks for them. Every payment is stored in two places, so every
read has a first choice and a fallback:

| You ask for | First choice | If that node is down |
|---|---|---|
| One store's payments | **This app's own node**, if it holds that store. Otherwise the store's home node. | The store's other copy (Node 1, or the home node) |
| All payments, a customer, a payment ID (store unknown) | Node 1 | Node 2 + Node 3 together |

- **Skipped:** nodes that are DOWN, and nodes that are RECOVERING (still missing writes, so they
  could return old data).
- **A node can crash between health checks.** If a read fails to reach a node, the app marks it
  DOWN at once and tries the fallback, so the user still gets an answer.
- **"Node 2 + Node 3 together"**: the app asks both fragments and merges their rows into one list.
  The fragments are separate servers, so SQL can't do this `UNION ALL` itself.
- Every response says **which node answered, and why**. Each row also says which node it came from.
- If no copy is available (two nodes down at once), the app answers *503* and lists the nodes
  it skipped. ([details](docs/decisions.md#d13-read-path-details-52))

### Writing (insert, update, delete)
1. **Find the two copies:** Node 1 and the row's home node.
2. **Lock the row on Node 1 first, then on the home node, always in that order.** If two people
   edit the same row at once, the second waits for the first instead of the two deadlocking.
3. **Write the change on both copies.**
4. **Record a log entry for the second copy, in the same transaction as the first.** Each node has
   a `replication_log` table: a to-do list of copies that still need updating.
5. **Commit the first copy, then the second**, then tick off the log entry.

- If one copy's node is down, the write **still succeeds** on the other copy. Its log entry just
  stays open (`PENDING`) until that node returns.
- **New IDs** come from the first copy written (normally Node 1). Each node counts in steps of 3 from
  its own offset, so IDs never clash even if the nodes can't reach each other.
- `store_id` can't be changed, so a row never moves between fragments.
- Every write reports **which copies committed, which are still owed the write, and every step**
  (lock, write, log, commit) with timings. The app also logs one line per write (`[write] ...`).
- If two writes hit the same row at once, the second waits for the first. If it waits more than
  `LOCK_WAIT_TIMEOUT_S` (10 s), it gives up with *"nothing was saved; try again"*.
  ([details](docs/decisions.md#d16-write-path-details-53-step-3))

### When a node fails, and when it comes back
- Each app checks every few seconds which nodes respond:
  - **UP:** reachable and up to date.
  - **DOWN:** not responding.
  - **RECOVERING:** back online, but still missing some writes.
- A **background job** in each app watches its own node's log. When a node comes back, the job
  replays the writes that node missed, **in the exact order they happened**. Then the node turns UP.
- **Catch-up guard:** before writing a row straight to a node, the app checks whether that node
  is still owed an older write to the same row. If it is, the new write waits in the log behind the
  older one instead of jumping ahead. Without this, a node that restarts quickly could get the new
  value and then have it overwritten by the older one being replayed.
  ([details](docs/decisions.md#d9-catch-up-guard-51-53-56))

### Primary and secondary copies
Each store's rows have two copies. The **primary** is the copy a write locks first, so writes to
that store line up there. The other copy is the **secondary**.

| | Store 1 | Store 2 |
|---|---|---|
| Normally | Primary **Node 1**, secondary Node 2 | Primary **Node 1**, secondary Node 3 |
| Node 1 DOWN or RECOVERING | **Node 2 takes over** as primary | **Node 3 takes over** as primary |
| Node 1 back and caught up | Node 1 is primary again | Node 1 is primary again |

- **There is no election (no vote between nodes).** The rule is fixed: the primary is the first copy
  in the lock order (Node 1, then the store's own node) that is UP. Every app applies this rule to
  its own health checks, so all apps agree within a couple of seconds, without exchanging messages.
- Node 1 takes the role back only after it has received every write it missed (until then it is
  RECOVERING), so the primary always has the latest data.
- The status page shows the roles, and a **Kill / Restore** button per node to watch a takeover
  live. ([details](docs/decisions.md#d14-primary-and-secondary-copies-51-53))

### Isolation level
The isolation level is a **setting**, so we can run the concurrency tests under all four levels
and pick the best one from the results:
- **Default:** `ISOLATION_LEVEL` in `.env` (REPEATABLE READ for now).
- **Payments page:** the *Isolation level* menu at the top right. It applies to every search and
  write on that page, and is remembered in your browser.
- **API / test scripts:** add `isolation` to any request, e.g. `?isolation=SERIALIZABLE` or
  `"isolation": "READ COMMITTED"` in the JSON body.

Writes always lock their row (`SELECT … FOR UPDATE`), whatever the level.

---

## Build plan

We build in this order. **After each step, the app is deployed on all three VMs.**

| # | Step | What it does | Proves | Status |
|---|---|---|---|---|
| 1 | **Node status page** | Connects to all 3 databases and shows which nodes are up or down, and which copy of each store is primary. Kill / Restore buttons stop and start a node's MySQL. Deployed to all 3 VMs first to prove the setup works. Reused in the recovery demo. | Setup works | Built, not deployed |
| 2 | **Reads** | List and search payments. Reads from the local node, and falls back to another node when one is down. | Data stays available | Built, not deployed |
| 3 | **Writes** | Insert, update and delete, routed by `store_id` to the home node plus Node 1, using the lock order above. Isolation level becomes a setting. Adds a consistency check. | Copies stay in sync | Built, not deployed |
| 4 | **Concurrency demo page** | Fires transactions from 2+ nodes at the same time, with `DO SLEEP` delays like in the hands-on. | Concurrency cases 1–3 | To do |
| 5 | **Recovery** | Writes that can't reach a node go to the `replication_log`. A background job replays them in order when the node is back. | Recovery cases 1–4 | To do |
| 6 | **Test scripts** | Python threads hitting the 3 app URLs, like the hands-on scripts. Each case runs 3+ times, and the logs are saved. | Evidence for the report | To do |

After that: the report, slides and test PDF.

### The test cases we must show

**Concurrency** (each one under all 4 isolation levels):

| Case | What happens |
|---|---|
| C1 | Two or more nodes **read** the same row at the same time |
| C2 | One node **writes** a row while others **read** it |
| C3 | Two or more nodes **write** the same row at the same time |

**Failure and recovery** (while other transactions keep running):

| Case | What happens |
|---|---|
| R1 | A write from Node 2/3 can't be copied to Node 1 because Node 1 is down |
| R2 | Node 1 comes back and receives the writes it missed |
| R3 | A write from Node 1 can't be copied to Node 2/3 because that node is down |
| R4 | Node 2/3 comes back and receives the writes it missed |

Every case passes only if the **consistency check** at the end shows Node 2 + Node 3 matching Node 1.

---

## Running it

### On your laptop (to try changes)
You need Node.js 22 or newer. In the repo folder:

1. `npm install`
2. Copy `.env.example` to `.env`, then edit `.env`:
   - `PORT=3000` (port 80 needs admin rights on a laptop)
   - `DB_PASSWORD=` the team password
   - swap the six `NODEx_HOST` / `NODEx_PORT` lines for the commented **laptop** lines (public ports),
     and do the same for the three `NODEx_APP_URL` lines
   - `NODE_ID` can be any of 1, 2, 3; it only changes which node the page calls "This app"
3. `npm start` (or `npm run dev` to restart automatically when you save a file)
4. Open http://localhost:3000

Your laptop app is a fourth instance of the app, talking to the **real cloud databases**. Searching
is harmless, but **Add / Edit / Delete on your laptop change the real data** on the nodes.

To use a port other than the one in `.env` (e.g. if 3000 is taken), set it for one run:
`PORT=3001 npm start` in Git Bash.

### On the cloud: first-time setup (once per VM)
Do this on **each** VM. SSH ports: Node 1 `20244`, Node 2 `20245`, Node 3 `20246`.

1. Install Node.js 22 and pm2:
   ```bash
   ssh -p 20244 root@103.231.240.136          # use 20245 / 20246 for Node 2 / Node 3
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
   apt install -y nodejs
   npm install -g pm2
   pm2 startup systemd                         # start the app again after a reboot
   mkdir -p /opt/mco2
   exit
   ```
2. Give the VM its own `.env`. From the repo folder on your laptop (Git Bash):
   ```bash
   scp -P 20244 .env.example root@103.231.240.136:/opt/mco2/.env
   ```
   Then on the VM, run `nano /opt/mco2/.env` and set:
   - `NODE_ID`: 1, 2 or 3, matching the VM
   - `DB_PASSWORD`
   - `ADMIN_TOKEN`: any long random string, **the same on all three VMs** (it switches on the Kill /
     Restore buttons; leave it empty to switch them off). Share it in the team chat, never in git.

   Keep `PORT=80` and the internal `10.20.200.x` addresses. After changing `.env` on a running app,
   run `pm2 restart mco2-ddb --update-env`.

### On the cloud: deploy
1. **Commit your changes.** The script deploys the last commit, never uncommitted work.
2. From the repo folder, in Git Bash:
   ```bash
   bash scripts/deploy.sh     # all three VMs (asks for each VM's SSH password once)
   bash scripts/deploy.sh 3   # just Node 3
   ```
   For each VM, it copies the code to `/opt/mco2`, installs packages, and starts or restarts the app
   with pm2. Each VM's `.env` is left alone.
3. **First deploy only:** create the `replication_log` table on every node. **Writes fail without
   it.** This is safe to re-run; it never touches existing rows.
   ```bash
   for p in 20244 20245 20246; do ssh -p $p root@103.231.240.136 "mysql < /opt/mco2/sql/01_schema.sql"; done
   ```
   If `mysql` asks for a password, use `mysql -u ddb -p mco2 < /opt/mco2/sql/01_schema.sql` on the VM instead.

### Check that it works
Open all three pages: http://103.231.240.136:10244, :10245 and :10246. On **every** page you
should see:
- the nav bar saying *App on Node 1/2/3* (a different node on each page)
- all three nodes **UP**, with *App: Running* and no red problem boxes
- *Store 1: primary Node 1, secondary Node 2* and *Store 2: primary Node 1, secondary Node 3*
- row counts where Node 2's store 1 plus Node 3's store 2 equal Node 1's total (16,044)

Then try a crash: type the admin token (top right) and click **Kill** on Node 1. Within a few
seconds, on all three pages, Node 1 turns **DOWN**, both stores show **Failover**, and Node 2 and
Node 3 become primary. Click **Restore** and Node 1 becomes primary again. This is the same view we
use in the recovery demo. (Without the buttons: `ssh -p 20244 root@103.231.240.136 "systemctl stop mysql"`,
then `systemctl start mysql`.)

Then check reads: open **Payments** in the nav on each node, and try the fallback below.

Then check writes: on Node 3's page, add a payment for **Store 1**. The *Last write* panel should
say *Committed on Node 1 + Node 2* and *Copies match*. Edit it from Node 2's page, delete it from
Node 1's page, and the status page should still say **Copies: Match ✓** for both stores.

### Reading the status page
| Part | Meaning |
|---|---|
| **Store 1 / Store 2** cards | Which copy is primary and which is secondary right now. *Failover* means Node 1 is unavailable, so the store's own node leads. |
| Copies (on the store cards) | The consistency check, every 5 s: Node 1's rows for that store vs the store's node (count, total and checksum). *Match ✓* is the pass condition for every test case. |
| Badge (UP / RECOVERING / DOWN) | The node's status. Hover it for a short explanation. |
| Role chip (*Primary · stores 1 & 2*, *Secondary · store 1*, *No role*) | The node's role. A DOWN or RECOVERING node has none. |
| Database | How long connecting plus `SELECT 1` took, or *Not reachable* |
| App | Whether that VM's app answers. A warning here usually means a wrong `NODE_ID` in its `.env`. |
| Rows | Payments per store on this node |
| Missed writes | Writes that other nodes' logs still owe *this* node. If any are missed, the node is RECOVERING. |
| Log | Only shown when this node's `replication_log` holds writes that another node still needs |
| Red box | A problem, e.g. wrong ID settings or a missing `replication_log` table |
| **Role changes** | Each takeover and handback, with the time it happened (this app's view; cleared when the app restarts) |

### Kill and restore a node
**Kill** runs `systemctl stop mysql` on that node's VM, and **Restore** runs `systemctl start mysql`.
Only the database stops: the node's app keeps running, which is how Restore can reach it afterwards.

- The page sends the request to the app that served it, which passes it to the target node's app
  (only that VM can stop its own MySQL). Any page can kill or restore any node.
- Type the **admin token** in the box at the top right first. It is remembered in that browser.
- If `ADMIN_TOKEN` is empty in an app's `.env`, that app's page shows no buttons.
- Test scripts can do the same: `POST /api/admin/nodes/3/mysql/stop` (or `/start`) with the header
  `X-Admin-Token: <token>`.

### Using the payments page
Click **Payments** in the nav (or open `/payments.html`). Fill in any filters and click **Search**.
Empty filters mean "any". Results are newest first, 50 per page.

The **Read from** panel above the results shows where the data came from:

| You see | Meaning |
|---|---|
| `Node 2` · *First choice* | The normal node for this search answered. |
| `Node 1` · *Fallback*, and *Node 2 skipped: …* | Node 2 was DOWN or RECOVERING, so its other copy answered. |
| `Node 2` + `Node 3` · *Fallback* | Node 1 was unavailable, so both fragments answered and their rows were merged. The **Read from** column says which node each row came from. |
| A red message: *No node that holds these payments is available* | Every copy of the rows needed is down (two nodes at once). |

**Try a fallback** (the demo for step 2):
1. Open http://103.231.240.136:10245/payments.html (the app on Node 2), pick **Store 1**, and Search.
   It shows *Read from Node 2 · First choice*.
2. On the Status page, **Kill** Node 2 (or `ssh -p 20245 root@103.231.240.136 "systemctl stop mysql"`).
3. Search again. Same rows, now *Read from Node 1 · Fallback*, with *Node 2 skipped*.
4. Open http://103.231.240.136:10244/payments.html (Node 1's app), stop Node 1 instead, and search
   **All stores**. The rows now come from *Node 2 + Node 3*.
5. **Restore** the node. Within a few seconds the first choice is back.

**Add, edit and delete:**
- **Add payment:** pick the store, type the customer ID and amount, and click *Add payment*. The ID
  is assigned automatically, and *Paid on* defaults to now.
- **Edit / Delete:** use the buttons on any row. Delete asks you to confirm. The store can't be
  edited, because it decides which nodes hold the row.
- After every write, the **Last write** panel shows:
  - *Committed on*: the copies that have the change now;
  - *Still owed to*: copies that will get it later from the log, and why (*down*, *recovering*, *behind*);
  - the source node, isolation level, time and transaction id;
  - *Steps*: every lock, write, log entry and commit, in order, with timings;
  - the row as it is on every copy right now, with a *Copies match* badge.

**Try a write while a node is down** (the demo for step 3): Kill Node 3 on the status page, then add
a payment for **Store 2**. It succeeds with *Committed on Node 1* and *Still owed to Node 3 · down*.
When Node 3 is restored, it shows **RECOVERING** (it is owed that write). Replaying the log comes in
step 5; until then the node stays RECOVERING, and reads and writes keep avoiding it.

**The API** (used by the page, and later by the test scripts). Every request accepts an optional
`isolation` (see [Isolation level](#isolation-level)).

| Request | Does |
|---|---|
| `GET /api/payments` | Payments, newest first. Optional filters: `store` (1 or 2), `id`, `customer`, `from` and `to` (dates like `2005-05-25`), `min` and `max` (amounts), plus `limit` (1–200, default 50) and `offset`. |
| `GET /api/payments/16049` | One payment, or 404 if no copy has it. |
| `POST /api/payments` | Adds a payment. JSON body: `store_id`, `customer_id`, `amount`, optional `payment_date` (`2026-11-24 10:15:00`). |
| `PATCH /api/payments/16049` | Changes `customer_id`, `amount` and/or `payment_date`. |
| `DELETE /api/payments/16049` | Deletes the payment from both copies. |
| `GET /api/consistency` | Node 1 vs Node 2 + Node 3 for each store (count, total, checksum); `ok` is the pass/fail. |
| `GET /api/consistency/16049` | That payment on every node, side by side, plus any log entries still owed for it. |

- **Reads** include `servedBy` (the nodes that answered), `firstChoice`, `reason` and `skipped`.
- **Writes** include `committed`, `pending` (copies still owed the write, and why), `source`,
  `txnId` and `timeline` (every step).
- **Both** include `isolationLevel` and `ms`.
- **Errors:**
  - 400: bad input, with a message saying what's wrong;
  - 404: no such payment;
  - 409: another write held the row too long (try again);
  - 503: no copy available.

### Useful commands on a VM
```bash
pm2 logs mco2-ddb          # live log: "[write] ... committed Node 1 + Node 2", "Node 1: UP → DOWN", "[roles] ..."
pm2 ls                     # is the app running?
pm2 restart mco2-ddb
systemctl stop mysql       # simulate a crash
systemctl start mysql      # recover
```

### If something goes wrong
- **Page doesn't load:** run `pm2 logs mco2-ddb` on that VM. `EADDRINUSE` means something else is
  using port 80 (maybe from the earlier port test); find it with `ss -ltnp | grep ':80 '` and stop it.
- **A node shows DOWN with `ER_ACCESS_DENIED_ERROR`:** wrong `DB_PASSWORD` in that VM's `.env`.
  Fix it, then run `pm2 restart mco2-ddb --update-env`.
- **"The replication_log table is missing"** (status page or a failed write): run step 3 of *Deploy*
  on that node.
- **Deploy says `.env is missing`:** do *First-time setup* step 2 for that VM.
- **Kill / Restore: "rejected the token" or "Wrong admin token":** `ADMIN_TOKEN` differs between
  the VMs, or the box at the top right has a typo. **"did not answer":** that node's app isn't
  running (`pm2 ls` on that VM).

### Checking the data
`sql/99_verify.sql` holds all the read-only checks (fragments, ID settings). On a VM:
`mysql -t < /opt/mco2/sql/99_verify.sql`. The main one: run this on each node, and for each store,
Node 2's or Node 3's row must match Node 1's:
```sql
SELECT store_id, COUNT(*) AS num_rows, SUM(amount) AS total,
       BIT_XOR(CRC32(CONCAT_WS('|', payment_id, customer_id, store_id, amount, payment_date))) AS checksum
FROM mco2.payment GROUP BY store_id;
```
