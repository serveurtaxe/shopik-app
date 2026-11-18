# Stress runner — find the routes that hurt mongo

Fires the app's own read routes at a **running** Shopik server, in two modes,
while watching mongo from the outside. The ranking metric is not each route's
own latency but **probe inflation**: a fixed cheap indexed read (`product/get`
by barcode) runs at a constant cadence during every burst — if it slows down
while route X is bursting, route X is what dragged the DB down.

## Targets

| target | how the URI is picked | metrics capability |
|---|---|---|
| `local` | `STRESS_DB_URI_LOCAL` or `mongodb://localhost:27017/shopik_stress` | rich: profiler (`slowms=100`) + `serverStatus` WT deltas + `currentOp` |
| `test`  | `STRESS_DB_URI_TEST` (required) | degrades automatically: `currentOp` when permitted, else latency only |

Safety: the runner refuses any URI identical to the `DB`/`DB_URI` env var of the
shell running it, and refuses to run with `PRODUCTION` set. Write routes are
never included unless `--mutations` is passed; login/OTP routes are never
stress-called at all.

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
node scripts/stress/run.js --target local --id-num <your admin idNum> --user-phone <a shopper phone>
```

### Caveat: the copy converges to the branch's schema

The app builds every index its models declare (mongoose `autoIndex`) the moment it
connects, so after one run the restored copy carries the indexes of the branch you
are testing, not the ones prod actually has. That is useful — it measures the state
*after* a schema PR — but compare `listIndexes` between prod and the copy before
trusting a latency number, and drop the branch's new keys when you want to measure
prod as it is today.

## Recipe: test Atlas URI

```bash
DB=<test-uri> NO_NIGHT_SYNC=1 npm start         # server against the test DB
STRESS_DB_URI_TEST=<test-uri> node scripts/stress/run.js --target test --mode both
```

Expect the observer to print `serverStatus not permitted` / profiler skipped —
that's Atlas doing its thing; ranking still works via probe inflation.

## Auth

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

Two route families refuse a super-admin burst, so the runner opens two more
sessions (same headless-OTP trick, each with its own cookie jar):

| session | sampled from | routes |
|---|---|---|
| picker | a real `status: 'picking'` order and the admin picking it | `order/ops/suggest_replacements` (403 unless the caller **is** the picker) |
| shopper | `--user-phone <phone>`, else the newest real cart order that has a `storeId` | `order/cart/get`, `order/window/options` (`_user` is only populated for a non-admin platform, so this client says `platform: web` and sends the storefront Origin) |

A shopper whose cart order has no `storeId` gets `order/window/options` skipped
with that reason — the route returns `[]` before touching mongo, and a row that
measures nothing would look like a cheap route.

## Modes

- `sequential` (default): burst each route alone (`--calls` × `--concurrency`,
  cooldown `--gap`), attributed window per route. This is the answer to
  "which route slows mongo".
- `chaos`: every allowed route concurrently round-robin for `--chaos-duration`
  seconds — aggregate only, measures total damage.
- `both`: run one after the other.

## Reading the report

`impact` = window probe p95 / baseline probe p95:

- `≥2×` → **DB DRAG** — the route slowed unrelated DB work.
- `COLLSCAN` → profiler/`currentOp` saw full collection scans in the window
  (rich mode gives exact per-namespace counts with docs examined).
- `HEAVY-SCAN` ≥50k docs examined → index-backed but huge.
- `bad-payload` rows: the route needs a payload the fixture table doesn't know
  — add it to `payloads.js` and rerun.
- `skipped (…)` rows: the fixture or session the route needs is missing (a reason
  is named). A route that never ran has no latency number — never read it as a
  cheap route.

JSON artifact: `reports/stress/<stamp>-<target>-<mode>.json`.

## Verifying the db-memory fixes

Run the suite once with the fix branch deployed and once with `main`, diff the
`collscans` column — the routes the memory-spike PR touched should go to zero.

## Files

```
scripts/stress/
  run.js       entry + orchestration
  config.js    CLI/env parsing + production guard
  routes.js    route discovery mirroring server/router.js + read allow-list
  payloads.js  per-route payload fixtures + which session each route needs
  fixtures.js  raw-collection sampling from the stress DB (ids, cart, picking order)
  client.js    HTTP client (one platform + one cookie jar per session, envelope parsing)
  auth.js      gate login + admin / picker / shopper logins (interactive or headless OTP)
  observer.js  mongo probe: profiler, serverStatus WT deltas, currentOp
  load.js      sequential bursts + chaos + the probe loop
  report.js    console ranking + JSON writer
```
