# STADVDB MCO2: Distributed Payments Database

Our project for STADVDB MCO2 (Transaction Management), DLSU, Term 1 AY 2026–2027.

One table of payments is spread across **three MySQL servers** on the CCS Cloud. The **same web
app runs on all three**. Users can read and write from any node, and the app:

- keeps every copy of the data consistent,
- keeps working when a node crashes, and
- sends a node the writes it missed once it comes back.

We wrote the replication and recovery logic ourselves (in `src/ddb/`). MySQL's built-in replication
is **not** used; the rubric penalises it.

> **Status:** step 1 (node status page) is built but not deployed yet. See [Running it](#running-it)
> and the [build plan](#build-plan).

---

## The three nodes

| Node | Role | Holds | App URL |
|---|---|---|---|
| **Node 1** | Central | All 16,049 payments | http://103.231.240.136:10244 |
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
Users never pick a node; the app picks for them.

| You ask for | The app reads from | If that node is down |
|---|---|---|
| One store's payments | This node if it holds that store, otherwise the store's home node | Node 1 |
| One payment by ID, or all payments | Node 1 | Node 2 + Node 3 together |

- Every response shows **which node served it**.
- A node that is down, or still catching up after a crash, is never read from.

### Writing (insert, update, delete)
1. **Find the two copies:** Node 1 and the row's home node.
2. **Lock the row on Node 1 first, then on the home node, always in that order.** If two people
   edit the same row at once, the second waits for the first instead of the two deadlocking.
3. **Write the change on both copies.**
4. **Record a log entry for the second copy, in the same transaction as the first.** Each node has
   a `replication_log` table: a to-do list of copies that still need updating.
5. **Commit the first copy, then the second**, then tick off the log entry.

If one copy's node is down, the write **still succeeds** on the other copy. Its log entry just
stays open (`PENDING`) until that node returns.

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

### Isolation level
The isolation level is a **setting**: a default in `.env`, which the demo page can override per
request. This lets us run the concurrency tests under all four levels and choose the best one
from the results. Writes always lock their row (`SELECT … FOR UPDATE`), whatever the level.

---

## Build plan

We build in this order. **After each step, the app is deployed on all three VMs.**

| # | Step | What it does | Proves | Status |
|---|---|---|---|---|
| 1 | **Node status page** | Connects to all 3 databases and shows which nodes are up or down. Deployed to all 3 VMs first to prove the setup works. Reused in the recovery demo. | Setup works | Built, not deployed |
| 2 | **Reads** | List and search payments, with fallback to another node when one is down. | Data stays available | To do |
| 3 | **Writes** | Insert, update and delete, routed by `store_id` to the home node plus Node 1, using the lock order above. Isolation level becomes a setting. Adds a consistency check. | Copies stay in sync | To do |
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

Your laptop app is a fourth instance of the app, talking to the real cloud databases. In step 1 it
only *reads*, so running it is harmless. (Be careful once writes exist in step 3.)

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
   Then on the VM, run `nano /opt/mco2/.env` and set `NODE_ID` (1, 2 or 3, matching the VM) and
   `DB_PASSWORD`. Keep `PORT=80` and the internal `10.20.200.x` addresses.

### On the cloud: deploy
1. **Commit your changes.** The script deploys the last commit, never uncommitted work.
2. From the repo folder, in Git Bash:
   ```bash
   bash scripts/deploy.sh     # all three VMs (asks for each VM's SSH password once)
   bash scripts/deploy.sh 3   # just Node 3
   ```
   For each VM, it copies the code to `/opt/mco2`, installs packages, and starts or restarts the app
   with pm2. Each VM's `.env` is left alone.
3. **First deploy only:** create the `replication_log` table on every node. This is safe to re-run;
   it never touches existing rows.
   ```bash
   for p in 20244 20245 20246; do ssh -p $p root@103.231.240.136 "mysql < /opt/mco2/sql/01_schema.sql"; done
   ```
   If `mysql` asks for a password, use `mysql -u ddb -p mco2 < /opt/mco2/sql/01_schema.sql` on the VM instead.

### Check that it works
Open all three pages: http://103.231.240.136:10244, :10245 and :10246. On **every** page you
should see:
- the nav bar saying *Served by Node 1/2/3* (a different node on each page)
- all three nodes **UP**, with *App: Running* and *ID settings ... ✓*
- row counts where Node 2's store 1 plus Node 3's store 2 equal Node 1's total (16,049)

Then try a crash. Stop MySQL on Node 3:
```bash
ssh -p 20246 root@103.231.240.136 "systemctl stop mysql"
```
Within a few seconds, Node 3 turns **DOWN** on all three pages. Start it again
(`systemctl start mysql`) and it turns **UP**. This is the same view we use in the recovery demo.

### Reading the status page
| Line | Meaning |
|---|---|
| Database | Address, and how long connecting plus `SELECT 1` took |
| App | Whether that VM's app answers. A warning here usually means a wrong `NODE_ID` in its `.env`. |
| ID settings | The node's auto-increment step and offset. They must be step 3, offset = node number. |
| Log on this node | Writes stored in this node's `replication_log` that another node still needs |
| Missing writes | Writes that other nodes' logs still owe *this* node. If any are missed, the node is RECOVERING. |
| Rows | Payments per store on this node |

### Useful commands on a VM
```bash
pm2 logs mco2-ddb          # live log: status changes like "Node 3: UP → DOWN"
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
- **"The replication_log table is missing":** run step 3 of *Deploy* on that node.
- **Deploy says `.env is missing`:** do *First-time setup* step 2 for that VM.

### Checking the data
`sql/99_verify.sql` holds all the read-only checks (fragments, ID settings). On a VM:
`mysql -t < /opt/mco2/sql/99_verify.sql`. The main one: run this on each node, and for each store,
Node 2's or Node 3's row must match Node 1's:
```sql
SELECT store_id, COUNT(*) AS num_rows, SUM(amount) AS total,
       BIT_XOR(CRC32(CONCAT_WS('|', payment_id, customer_id, store_id, amount, payment_date))) AS checksum
FROM mco2.payment GROUP BY store_id;
```