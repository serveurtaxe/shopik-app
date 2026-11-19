// Mongo-side observer on a second connection to the stress DB.
//
// It carries the tool's two instruments:
// - the DB probe: a fixed indexed single-doc read issued DIRECTLY against mongod on
//   this connection, at a constant cadence. Its latency is what ranks the routes —
//   a route that drags the DB down inflates a query it does not touch. Doing it here
//   instead of through the app matters: the HTTP path also measures the app's own
//   event loop and request queue, so every route looked equally expensive (a 10-call
//   smoke run put every single one at 2× on that metric).
// - rich-mode metrics (local mongod): profiler ({ profile: 1, slowms }) for exact
//   per-window COLLSCAN/heavy-scan accounting, serverStatus for wiredTiger cache and
//   dirty-byte deltas, currentOp for live long ops.
// Atlas test tier forbids serverStatus/profiler for normal users → degrades to
// currentOp (when permitted) + the probe latency inflation done in load.js.

import mongoose from 'mongoose'
import { latencyStats } from './util.js'

const POLL_MS = 750
const SLOW_OP_SECS = 0.15
// Ops at or over this take the profiler's entry. 20ms is the default: below it a
// warm local mongod records thousands of entries that describe nothing worth fixing.
// --slow-ms 1 is the diagnostic setting — use it on a short --only run, not a full sweep.
const SLOW_OP_MS = 20
const PROBE_MS = 150

export class MongoObserver {
    constructor(uri, { profileEnabled = false, slowMs = SLOW_OP_MS, probe = null, probeEvery = PROBE_MS } = {}) {
        this.uri = uri
        this.profileEnabled = profileEnabled
        this.slowMs = slowMs
        this.probe = probe // { collection, filter, projection } — the fixed probe read
        this.probeEvery = probeEvery
        this.hasCurrentOp = false
        this.hasServerStatus = false
        this.hasProfiler = false
        this.hasDbProbe = false
        this.dbProbeRunning = false
        this.dbProbeFails = 0
        this.window = null
        this.poller = null
        this.pollFails = 0
        this.statusFails = 0
    }

    async connect() {
        this.conn = await mongoose.createConnection(this.uri, {
            maxPoolSize: 4, // polls + the probe must not queue behind each other
            serverSelectionTimeoutMS: 5000,
            bufferCommands: false
        }).asPromise()
        this.db = this.conn.db
        this.admin = this.db.admin() // must be CALLED — the method itself has no .command

        try {
            await this.admin.command({ currentOp: 1, active: true, maxTimeMS: 5000 })
            this.hasCurrentOp = true
        } catch (err) {
            this.note('currentOp not permitted', err)
        }
        try {
            await this.admin.command({ serverStatus: 1 })
            this.hasServerStatus = true
        } catch (err) {
            this.note('serverStatus not permitted (Atlas?)', err)
        }
        if (this.profileEnabled) await this.enableProfiler()
        if (this.probe?.filter) this.startDbProbe()
        this.poller = setInterval(() => this.poll().catch(() => { }), POLL_MS)
        return this.capabilities()
    }

    // mongod 8+ dropped setProfilingLevel AND stopped accepting collMod on
    // system.profile (both `flags: 1` and `flags.1.active` are IDLUnknownField on
    // 9.0.8 — verified against the stress mongod). The level is its own command
    // now: { profile: 1, slowms: N } sets it, { profile: 0 } clears it, and
    // { profile: -1 } reports the status (that is what db.getProfilingStatus sends).
    async enableProfiler() {
        try {
            const res = await this.db.command({ profile: 1, slowms: this.slowMs })
            if (res.was == null && res.ok !== 1)
                throw new Error(`profile command returned ${JSON.stringify(res)}`)
            this.hasProfiler = true // profiling is ON and must be reset in close()
        } catch (err) {
            this.note('profiler not enabled (profile command)', err)
            return
        }
        // No ts index on system.profile: mongod 9 refuses user index builds on it
        // (InvalidNamespace). The aggregate collscans the capped profile collection,
        // which is small and whose ns is filtered out of the results below anyway.
        try {
            const status = await this.db.command({ profile: -1 })
            if (status.was !== 1)
                this.note(`profiler command accepted but level is ${status.was}, not 1`, status)
        } catch { }
    }

    // The probe: the same indexed single-doc read the HTTP probe uses (product/get by
    // barcode), issued straight against mongod. It runs at a constant cadence whether
    // or not a window is open, and tags its samples onto whatever window is open — so
    // the baseline window and every route window measure the identical query.
    startDbProbe() {
        this.hasDbProbe = true
        this.dbProbeRunning = true
        const tick = async () => {
            if (!this.dbProbeRunning) return
            const ms = await this.readDbProbe()
            if (ms != null && this.window) this.window.dbProbeMs.push(ms)
            if (this.dbProbeRunning) this.dbProbeNext = setTimeout(tick, this.probeEvery)
        }
        this.dbProbeNext = setTimeout(tick, this.probeEvery)
    }

    async readDbProbe() {
        const start = Date.now()
        try {
            await this.db.collection(this.probe.collection)
                .findOne(this.probe.filter, { projection: this.probe.projection, maxTimeMS: 5000 })
            this.dbProbeFails = 0
        } catch (err) {
            // A failed probe is not a latency sample: dropping it keeps the percentiles honest.
            if (++this.dbProbeFails >= 3) {
                this.hasDbProbe = false
                this.note('db probe disabled after repeated failures', err)
            }
            return null
        }
        return Date.now() - start
    }

    capabilities() {
        const caps = { currentOp: this.hasCurrentOp, serverStatus: this.hasServerStatus, profiler: this.hasProfiler, dbProbe: this.hasDbProbe }
        caps.mode = (caps.profiler ? 'rich'
            : caps.currentOp && caps.serverStatus ? 'ops+wiredtiger'
                : caps.serverStatus ? 'wiredtiger+latency'
                    : caps.currentOp ? 'ops-only'
                        : 'latency-only') + '+' + (caps.dbProbe ? 'db-probe' : 'http-probe')
        return caps
    }

    note(label, err) {
        console.log(`[observer] ${label}: ${err?.codeName || err?.code || ''} ${err?.message || err}`.trim())
    }

    isOwnOp(op) {
        const ns = op.ns || ''
        const command = op.command || {}
        return ns.endsWith('system.profile')
            || 'currentOp' in command || 'serverStatus' in command
            || 'collMod' in command || 'createCollection' in command || 'setProfilingLevel' in command
            || 'profile' in command
            || op.op === 'hello' || op.op === 'ping'
    }

    async poll() {
        if (this.hasCurrentOp) {
            try {
                const res = await this.admin.command({ currentOp: 1, active: true, maxTimeMS: 5000 })
                this.pollFails = 0
                if (this.window) {
                    for (const op of res.inprog || []) {
                        if (this.isOwnOp(op)) continue
                        const secs = op.secs_running
                            ?? (op.createdAt ? (Date.now() - new Date(op.createdAt).getTime()) / 1000 : 0)
                        if (secs < SLOW_OP_SECS) continue
                        this.window.slowOps++
                        if (/COLLSCAN/.test(op.planSummary || '')) {
                            this.window.collscans++
                            if (this.window.collscanExamples.length < 5)
                                this.window.collscanExamples.push({ ns: op.ns, secs: +secs.toFixed(2), plan: op.planSummary })
                        }
                        this.window.maxActiveSecs = Math.max(this.window.maxActiveSecs, +secs.toFixed(2))
                    }
                }
            } catch (err) {
                if (++this.pollFails >= 3) { this.hasCurrentOp = false; this.note('currentOp disabled after repeated failures', err) }
            }
        }
        this.tickCount = (this.tickCount || 0) + 1
        if (this.hasServerStatus && this.window && this.tickCount % 3 === 0)
            await this.snapshotWt()
    }

    openWindow(label) {
        this.window = {
            label,
            startedAt: new Date(),
            slowOps: 0,
            collscans: 0,
            collscanExamples: [],
            maxActiveSecs: 0,
            evictions: 0,
            evictionsLast: null,
            latestCache: null,
            latestDirty: null,
            startDirty: null,
            dbProbeMs: []
        }
        // Snapshot the WT counters the window started from. Without this the
        // columns depend on the poller's cadence, and short bursts (a few
        // seconds) land between two polls and report null.
        return this.snapshotWt()
    }

    // One serverStatus read, applied to the open window: the poller does this
    // every 3rd tick, the window edges do it deterministically.
    async snapshotWt() {
        if (!this.hasServerStatus || !this.window) return
        try {
            const status = await this.admin.command({ serverStatus: 1, maxTimeMS: 5000 })
            const apply = () => {
                this.window.latestCache = wt(status, 'bytes currently in the cache')
                this.window.latestDirty = wt(status, 'tracked dirty bytes in the cache')
                // 'tracked dirty bytes' accumulates until the next checkpoint, so the
                // window-open reading is the baseline and the report shows the DELTA:
                // a read-only burst should move it by ~0 (the profiler's own writes
                // are the exception, which is exactly why the delta is the number).
                if (this.window.startDirty == null) this.window.startDirty = this.window.latestDirty
                // Cumulative counter → delta per window. On 9.0.8 the useful
                // pressure counter is operations that had to WAIT for cache space
                // (older servers report 'evicted by application threads'); either
                // way a non-zero number means the burst outgrew the WT cache.
                const pressured = num(wt(status,
                    'operations timed out waiting for space in cache',
                    'evicted by application threads'))
                this.window.evictions += pressured - (this.window.evictionsLast ?? pressured)
                this.window.evictionsLast = pressured
            }
            // On the window-open snapshot evictionsLast is still null, so this
            // seeds the baseline and adds 0; on later snapshots it adds the delta.
            apply()
        } catch {
            if (++this.statusFails >= 3) {
                this.hasServerStatus = false
                this.note('serverStatus disabled after repeated failures')
            }
        }
    }

    async closeWindow() {
        if (!this.window) return null
        const window = this.window
        this.window = null
        await new Promise(resolve => setTimeout(resolve, POLL_MS)) // let one last poll land
        await this.snapshotWt() // the closing snapshot: every window gets cache/dirty numbers

        const stats = {
            slowOps: window.slowOps,
            collscans: window.collscans,
            collscanExamples: window.collscanExamples,
            maxActiveSecs: window.maxActiveSecs,
            evictions: window.evictions,
            cacheMB: window.latestCache != null ? +(window.latestCache / 1048576).toFixed(1) : null,
            dirtyDeltaMB: window.latestDirty != null && window.startDirty != null
                ? +((window.latestDirty - window.startDirty) / 1048576).toFixed(1) : null,
            probeDb: latencyStats(window.dbProbeMs)
        }
        if (this.hasProfiler) {
            try {
                // system.profile ts is server-time: pad both ends against clock skew.
                const pad = 1000
                const rows = await this.db.collection('system.profile').aggregate([
                    {
                        $match: {
                            ts: { $gte: new Date(window.startedAt.getTime() - pad), $lte: new Date(Date.now() + pad) },
                            // the observer's own profile read must not describe its own window
                            ns: { $not: { $regex: 'system\\.profile' } }
                        }
                    },
                    {
                        $group: {
                            _id: '$ns',
                            ops: { $sum: 1 },
                            millis: { $sum: '$millis' },
                            maxDocs: { $max: '$docsExamined' },
                            // An index scan over 10k documents reports keysExamined, not
                            // docsExamined, and aggregations report neither reliably at the
                            // top level — so the scan-size ranking takes the larger of the
                            // two. Both are kept in the CSV.
                            maxKeys: { $max: '$keysExamined' },
                            collscans: {
                                $sum: {
                                    $cond: [{
                                        $regexMatch: { input: { $ifNull: ['$planSummary', ''] }, regex: 'COLLSCAN' }
                                    }, 1, 0]
                                }
                            }
                        }
                    },
                    { $sort: { millis: -1 } },
                    { $limit: 10 }
                ]).toArray()
                stats.profile = {
                    totalOps: rows.reduce((sum, row) => sum + row.ops, 0),
                    totalCollscans: rows.reduce((sum, row) => sum + row.collscans, 0),
                    totalMillis: rows.reduce((sum, row) => sum + row.millis, 0),
                    worst: rows.map(row => ({
                        ns: row._id,
                        ops: row.ops,
                        collscans: row.collscans,
                        millis: row.millis,
                        maxDocsExamined: row.maxDocs,
                        maxKeysExamined: row.maxKeys
                    }))
                }
            } catch (err) {
                this.note('system.profile read failed (degraded to window counters)', err)
            }
        }
        return stats
    }

    async close() {
        clearInterval(this.poller)
        this.dbProbeRunning = false
        clearTimeout(this.dbProbeNext)
        if (this.hasProfiler)
            await this.db.command({ profile: 0 }).catch(() => { })
        await this.conn.close().catch(() => { })
    }
}

function num(value) {
    return typeof value === 'number' ? value : 0
}

// WiredTiger counter GROUPS differ between mongod majors, and the fragment we
// look for must be matched inside the right one: on 9.0.8 (verified against the
// stress mongod) the cache numbers live in wiredTiger.cache — 'bytes currently in
// the cache', 'tracked dirty bytes in the cache' — while 'transactions' /
// 'blockCache' / 'metrics' hold none of them, which is why every local run so far
// reported wtMB/dirty as null. The older group names stay in the list so a run
// against an older server or Atlas still fills the columns.
const WT_GROUPS = status => [
    status?.wiredTiger?.cache,
    status?.wiredTiger?.transactions,
    status?.wiredTiger?.blockCache,
    status?.wiredTiger?.['block-cache'],
    status?.wiredTiger?.concurrentTransactions,
    status?.wiredTiger?.metrics
]

function wt(status, ...fragments) {
    for (const group of WT_GROUPS(status)) {
        for (const fragment of fragments) {
            const key = Object.keys(group || {}).find(k => k.includes(fragment))
            if (key != null && typeof group[key] === 'number') return group[key]
        }
    }
    return undefined
}
