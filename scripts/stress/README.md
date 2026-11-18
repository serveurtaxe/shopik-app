# Stress runner — find the routes that hurt mongo

Fires the app's own read routes at a **running** Shopik server, in two modes,
while watching mongo from the outside. The ranking metric is not each route's
own latency but the load it puts on the DB:

- **DB work per window** (primary sort): the profiler records every operation at or
  over `--slow-ms` inside the window, so a window says exactly which namespaces it
  read, how many documents that took, and whether any of it was a COLLSCAN.
- **DB probe inflation** (tie-breaker): a fixed index-covered read
  (`products` by barcode) is issued *directly against mongod* by the observer at a
  constant cadence. If it slows while route X is bursting, X dragged the DB down.
- The same read is also fired **through the app** (`product/get`) as context: that
  number carries the app's own queueing, which is why it is not the ranking metric —
  hammering any route at concurrency 8 inflates the HTTP probe ~2×, cheap ones included.

## Targets

| target | how the URI is picked | metrics capability |
|---|---|---|
| `local` | `STRESS_DB_URI_LOCAL` or `mongodb://localhost:27017/shopik_stress` | rich: profiler + `serverStatus` wiredTiger numbers + `currentOp` |
| `test`  | `STRESS_DB_URI_TEST` (required) | degrades automatically: `currentOp` when permitted, else latency only |

Safety: the runner refuses any URI identical to the `DB`/`DB_URI` env var of the
shell running it, and refuses to run with `PRODUCTION` set. Write routes are
never included unless `--mutations` is passed; login/OTP routes are never
stress-called at all.

## Which routes get fired

`routes.js` mirrors `server/router.js` discovery (223 live route files) and admits
only read-shaped action names (`get`, `read`, `list`, `counts`, `search`, `lookup`…).
Two deliberate exceptions to the heuristic:

- `DENY_PREFIXES` / `DENY_ROUTE_PREFIXES` / `NEVER_RUN` keep out the read-NAMED routes
  that are not load: `sync_*` (rebuilds), `send_*`, `bot/*` (external Comax APIs), and
  auth/infrastructure routes.
- `ALSO_READ` admits 11 read-shaped routes whose ACTION NAME says nothing because they
  are only reachable through another feature's permissions — each listed with what it
  really reads: `notifications/counts`, `order/mine`, `order/status`,
  `order/ops/pick_limits`, `user/coupon`, `user/favorites`, `category/products`,
  `display_block/categories`, `role/children`, `payment/refunds`, `supply_area/lookup`.
  They are admitted by full route name, never by widening `READ_ACTIONS`, so a
  same-named write route elsewhere cannot sneak in. `--discover-only` prints them as
  `read*`.

Deliberately not fired (they do no DB read to rank): `geocode/*`, `address/autocomplete`,
`address/validate`, `bot/*`, `sms/voice_test`, `cache/reset`, `user/sync_stats`,
`gs1/status` (BullMQ job counts), `gs1/retention` (GS1 API), `report/download`
(streams an xlsx from storage). A route that was never fired shows as a `skipped (…)`
row with a reason — never read it as a cheap route.

### Caveat: the copy converges to the branch's schema

The app builds every index its models declare (mongoose `autoIndex`) the moment it
connects, so after one run the restored copy carries the indexes of the branch you
are testing, not the ones prod actually has. That is useful — it measures the state
*after* a schema PR — but compare `listIndexes` between prod and the copy before
trusting a ranking, and drop the copy-only keys when you want to measure prod as it
is today:

```js
db.products.dropIndex("status_1_category.pathIds_1")       // not in prod
db.gs1_products.dropIndex("aliasStatus_1")                 // not in prod
```

### Caveat: the app logs every call, so a sweep fills the copy's `logs`

Read routes write one audit row per call (`action: '/user/read'`). A full sweep is
~40k calls, which is why `logs` went 32k → 319k after one afternoon of runs — and why
`log/read` / `log/count` and every window that reads logs looks different on the second
run. The tool itself never writes (that is what `--mutations` guards); the app does.
`logs` has a 24 h TTL index (`createdAt_1`, `expireAfterSeconds: 86400`), so those rows
expire on their own — deleting them only makes the next run match the dump immediately.
Between runs, delete the locally written rows using the gap between the dump's newest
log and the first local one:

```js
db.otps.deleteMany({})                             // the headless-OTP login docs (TTLs them anyway)
db.logs.deleteMany({ createdAt: { $gte: <first-local-run-time> } })
db.command({ profile: 0 })                        // the observer does this on close, belt-and-braces
db.system.profile.drop()                          // allowed while the level is 0
```

## Recipe: local mongod with a prod dump

```bash
# 1. dump (from a machine that may touch prod)
mongodump --uri="$PROD_DB" --out dumps/prod

# 2. throwaway local mongo + redis, restore
docker run -d --name shopik-stress-mongo -p 27017:27017 -v shopik-stress-data:/data/db mongo:8
mongorestore --uri mongodb://localhost:27017/shopik_stress --drop dumps/prod
docker run -d --name shopik-stress-redis -p 6379:6379 redis

# 3. run the app against the stress DB (crons/workers off)
DB=mongodb://localhost:27017/shopik_stress NO_NIGHT_SYNC=1 PORT=7777 npm start

# 4. stress it
node scripts/stress/run.js --target local --id-num <your admin idNum> --headless-otp
```

Leave the stress Redis WARM: prod answers most of these reads from cache, so flushing
it measures a cold-cache server prod is not.

## Recipe: test Atlas URI

```bash
DB=<test-uri> NO_NIGHT_SYNC=1 npm start         # server against the test DB
STRESS_DB_URI_TEST=<test-uri> node scripts/stress/run.js --target test --mode both
```

Expect the observer to print `serverStatus not permitted` / profiler skipped —
that's Atlas doing its thing; ranking still works via the probes.

## Auth and sessions

The runner logs in with the **real app login flow** (no token forging):

- interactive: prompts for `--id-num`, calls `admin/login_otp` (real SMS to the
  admin's phone), prompts for the code, captures `ADMIN_TOKEN_COOKIE`.
- `--headless-otp` (unattended): writes the OTP doc in the stress DB
  directly, skipping SMS entirely. Guarded the same way as everything else —
  impossible against a prod-looking URI.
- If the target has `SITE_GATE_PASSWORD`, pass `--gate-password` (or
  `STRESS_GATE_PASSWORD`); the runner detects the gate and logs in once.

The admin login is pinned to a sampled store (`admin/current_store`) — the ops
queue routes answer empty without a `currentStoreId` and would measure nothing.

Some routes refuse a super-admin burst, so the runner opens two more sessions (same
headless-OTP trick, each with its own cookie jar). The probe always runs on the admin
session, so the impact numbers stay comparable window to window:

| session | sampled from | routes |
|---|---|---|
| picker | a real `status: 'picking'` order and the admin picking it | `order/ops/suggest_replacements` (403 unless the caller **is** the picker), `order/ops/pick_limits` |
| shopper | `--user-phone <phone>`, else a real cart order with a `storeId` whose owner also has past orders (one `distinct` query, preferring repeat customers) | `order/cart/get`, `order/window/options`, `order/mine`, `order/status`, `user/coupon`, `user/favorites`, `menu/get`, `product/search` |

The storefront routes read `_user`, which the router only populates for a non-admin
platform, so that client says `platform: web` and sends the storefront Origin. For
`menu/get` and `product/search` it matters beyond auth: an admin takes a different
code path (hidden products, multi-domain prices), so measuring them as admin would
rank a request no shopper ever makes.

A shopper whose cart order has no `storeId` gets `order/window/options` skipped with
that reason — the route returns `[]` before touching mongo, and a row that measures
nothing would look like a cheap route.

## Modes and knobs

- `sequential` (default): each route alone — `--calls` × `--concurrency`, repeated
  until the window has lasted `--min-window` ms (default 3000), then `--gap` cooldown.
  Repeating is what makes the probe samples comparable between windows, and it is the
  honest load shape: a screen a user keeps opening, not a single flash.
- `chaos`: every allowed route concurrently round-robin for `--chaos-duration` seconds
  — aggregate only, measures total damage. Its DB numbers land on the
  `__chaos_total__` row, not on each route (attribution is impossible there).
- `both`: run one after the other.
- `--baseline-seconds` (default 10): the no-load window every impact is divided by.
  A short baseline produces impacts that are noise.
- `--slow-ms` (default 20): profiler threshold. Use `1` on a short `--only` run to see
  every read a route does (sub-millisecond ops are not recorded — which conveniently
  keeps the volume down on a full sweep).

## Reading the report

Rows are sorted by **documents examined in the window**, then probe inflation, then
the route's own latency — because on a warm local copy nothing inflates (everything
fits the wiredTiger cache) while the reads a route really does are still visible.

| column / flag | meaning |
|---|---|
| `calls` | total calls in the window (`rounds` in the CSV: how many bursts it took) |
| `probe`, `impact`, `tail`, `n` | DB probe p50 in the window, its ratio vs the baseline, the p95 ratio, and the sample count |
| `collscan`, `maxDocs` | profiler/`currentOp` counts in the window: full scans, and the biggest `docsExamined` |
| `dirtyΔ`, `wtMB` | wiredTiger dirty bytes *delta* over the window (a read burst should be ~0) and the cache level |
| `resp` | median bytes / items one call handed back: `12.3k/32` reads 32 documents, `30b/0` answered an empty list |
| `no-work (n kind)` | every call failed (`bad-payload` / `server-error` / `auth`): the route did **no** DB work, gets no impact, and sorts last |
| `answered-nothing` | the calls succeeded but returned nothing — an early return, not a mongo read |
| `low-n (n probes)` | too few probe samples to call inflation a verdict (numbers are still printed) |
| `tail-drag` | median flat, p95 up ≥2×: the burst occasionally makes the probe wait — worth a look, not a verdict |
| `COLLSCAN`, `HEAVY-SCAN` (≥50k docs) | index-free / index-backed-but-huge reads in the window |
| `skipped (…)` | the fixture or session the route needs is missing, with the reason named |

Below the table, `worst profiled namespaces per offender` names the exact collection,
operation count and docs examined — that is the part a fix is written against.

Artifacts: `reports/stress/<stamp>-<target>-<mode>.json` (full rows + raw window
data + the options the run used) and the same ranking as `.csv`.

## Verifying a db-memory fix

Run the suite once with the fix branch deployed and once with `main`, diff the
`maxDocs` / `collscans` / `resp` columns for the routes the PR touched — they should
fall to zero or to the payload the screen actually needs.

## What the sweeps found, and what was done about it

The sweep and Atlas's index advisor were both used, and they measure different halves of
the workload: the sweep's hot reads are answered from Redis on prod and never reach
mongod, so they never appear in the advisor; the advisor only sees the slow queries that
do reach it — sync/report/admin paths, all at 0.04–0.38 queries/hour. Every fix below is
listed with `explain("executionStats")` measured on the prod copy before and after.

| read | before | after |
|---|---|---|
| `comax_product/sales_window` department group | IXSCAN+FETCH of 21 514 docs / 52 ms | covered scan: 21 512 keys, 0 docs / 4 ms |
| `order/ops/suggest_replacements` product lookup | 6 802–7 201 docs per cart | 20–110 docs (`category.pathIds` is the key products index) |
| `category/rename` product title update | COLLSCAN of 39 459 docs / 14 ms | 2 198 keys / 2 198 docs / 2 ms |
| `reports/version.js` newest-comax-`updatedAt` probe | COLLSCAN + blocking sort of 21 514 docs | 1 key, 0 docs / 1 ms (`{updatedAt:-1, id:1}`) |
| `reports/catalog.js` GS1 barcode set + dated check | 2 × COLLSCAN of 23 449 heavy docs (~163 MB) | covered `distinct` on the unique barcode index (0 docs) + 684 docs via `skipReason_1` |

What was measured and deliberately not done:

- **`gs1_products {createdAt}`** was the advisor's suggestion, but no query in this app
  sorts `gs1_products` by `createdAt`; the two advisor entries on that collection are the
  report's `skipReason` / `raw $exists` reads. A partial `{barcode:1}` index on
  `raw: {$exists:true}` was created on the copy and measured: `distinct` will not use
  partial indexes, and hinted into it still FETCHes 22 788 docs instead of scanning 23 449
  — dropped, and the reads were reshaped onto `skipReason_1` instead.
- **`products {status, category.id}`** plus the 6- and 7-key
  `prices.domainId + storeIds + sortOrder…` compounds: the `category.id` scans were
  `suggest_replacements` and `category/rename`, both fixed by filtering the indexed
  `pathIds` instead. The wide compounds target reads doing 0.04–0.25 queries/hour on a
  collection that already carries 14 indexes, and some list key directions no single
  index can serve for the sort they are meant to fix.
- **`menu/get`** (5 254 docs on a cache miss, 86 ms) and **`store/nearby`** (57 keys /
  8 docs, 0.93 ms measured alone, `GEO_NEAR_2DSPHERE` over 4 stores): one menu miss per
  store behind a 1 h cache, and a geo read that is already index-served. Neither earns a
  new index on a collection the nightly import writes in bulk.

## Files

```
scripts/stress/
  run.js       entry + orchestration
  config.js    CLI/env parsing + production guard
  routes.js    route discovery mirroring server/router.js + read allow-list + ALSO_READ
  payloads.js  per-route payload fixtures + which session each route needs
  fixtures.js  raw-collection sampling from the stress DB (ids, cart, picking order)
  client.js    HTTP client (one platform + one cookie jar per session, envelope parsing)
  auth.js      gate login + admin / picker / shopper logins (interactive or headless OTP)
  observer.js  the DB probe + profiler + serverStatus WT numbers + currentOp
  load.js      sustained sequential bursts + chaos + the HTTP probe loop
  report.js    console ranking + CSV/JSON writer
  util.js      percentiles, worker pool, formatting
```
