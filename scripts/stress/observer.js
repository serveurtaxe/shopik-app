// Mongo-side observer on a second connection to the stress DB.
//
// Rich mode (local mongod): profiler (slowms=100) gives exact per-window
// COLLSCAN/heavy-scan accounting; serverStatus gives wiredTiger cache deltas —
// the actual RAM-pressure signal; currentOp catches live long ops.
// Atlas test tier forbids serverStatus/profiler for normal users → degrades to
// currentOp (when permitted) + probe latency inflation done in load.js.

import mongoose from 'mongoose'

const POLL_MS = 750
const SLOW_OP_SECS = 0.15
const SLOW_OP_MS = 100 // setProfilingLevel slowms is in milliseconds

export class MongoObserver {
    constructor(uri, { profileEnabled = false } = {}) {
        this.uri = uri
        this.profileEnabled = profileEnabled
        this.hasCurrentOp = false
        this.hasServerStatus = false
        this.hasProfiler = false
        this.window = null
        this.poller = null
        this.pollFails = 0
        this.statusFails = 0
    }

    async connect() {
        this.conn = await mongoose.createConnection(this.uri, {
            maxPoolSize: 3,
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
        if (this.profileEnabled) {
            try {
                await this.db.command({ setProfilingLevel: 1, slowms: SLOW_OP_MS })
                this.hasProfiler = true // even if the index below fails, profiling is ON and must be reset
                try {
                    await this.db.collection('system.profile').createIndex({ ts: 1 })
                } catch (err) {
                    this.note('profiler ts index not created (best-effort)', err)
                }
            } catch (err) {
                this.note('profiler not enabled', err)
            }
        }
        this.poller = setInterval(() => this.poll().catch(() => { }), POLL_MS)
        return this.capabilities()
    }

    capabilities() {
        const caps = { currentOp: this.hasCurrentOp, serverStatus: this.hasServerStatus, profiler: this.hasProfiler }
        caps.mode = caps.profiler ? 'rich'
            : caps.currentOp && caps.serverStatus ? 'ops+wiredtiger'
                : caps.serverStatus ? 'wiredtiger+latency'
                    : caps.currentOp ? 'ops-only'
                        : 'latency-only'
        return caps
    }

    note(label, err) {
        console.log(`[observer] ${label}: ${err?.codeName || err?.code || ''} ${err?.message || err}`.trim())
    }

    isOwnOp(op) {
        const ns = op.ns || ''
        const command = op.command || {}
        return ns.endsWith('system.profile')
            || 'currentOp' in command || 'serverStatus' in command || 'setProfilingLevel' in command
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
        if (this.hasServerStatus && this.window && this.tickCount % 3 === 0) {
            try {
                const status = await this.admin.command({ serverStatus: 1, maxTimeMS: 5000 })
                this.window.latestCache = wt(status, 'bytes currently in the cache')
                this.window.latestDirty = wt(status, 'tracked dirty bytes in the cache')
                this.window.evictions += num(wt(status, 'evicted by application threads')) - (this.window.evictionsLast ?? 0)
                this.window.evictionsLast = num(wt(status, 'evicted by application threads'))
            } catch {
                if (++this.statusFails >= 3) {
                    this.hasServerStatus = false
                    this.note('serverStatus disabled after repeated failures')
                }
            }
        }
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
            latestDirty: null
        }
    }

    async closeWindow() {
        if (!this.window) return null
        const window = this.window
        this.window = null
        await new Promise(resolve => setTimeout(resolve, POLL_MS)) // let one last poll land

        const stats = {
            slowOps: window.slowOps,
            collscans: window.collscans,
            collscanExamples: window.collscanExamples,
            maxActiveSecs: window.maxActiveSecs,
            evictions: window.evictions,
            cacheMB: window.latestCache != null ? +(window.latestCache / 1048576).toFixed(1) : null,
            dirtyMB: window.latestDirty != null ? +(window.latestDirty / 1048576).toFixed(1) : null
        }
        if (this.hasProfiler) {
            try {
                // system.profile ts is server-time: pad both ends against clock skew.
                const pad = 1000
                const rows = await this.db.collection('system.profile').aggregate([
                    { $match: { ts: { $gte: new Date(window.startedAt.getTime() - pad), $lte: new Date(Date.now() + pad) } } },
                    {
                        $group: {
                            _id: '$ns',
                            ops: { $sum: 1 },
                            millis: { $sum: '$millis' },
                            maxDocs: { $max: '$docsExamined' },
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
                        maxDocsExamined: row.maxDocs
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
        if (this.hasProfiler)
            await this.db.command({ setProfilingLevel: 0 }).catch(() => { })
        await this.conn.close().catch(() => { })
    }
}

function num(value) {
    return typeof value === 'number' ? value : 0
}

function wt(status, fragment) {
    // WiredTiger counters live under wiredTiger.transactions (bytes/dirty/evictions),
    // block cache stats under wiredTiger.blockCache — .metrics is a different group.
    for (const group of [status?.wiredTiger?.transactions, status?.wiredTiger?.blockCache, status?.wiredTiger?.metrics]) {
        const key = Object.keys(group || {}).find(k => k.includes(fragment))
        if (key) return group[key]
    }
    return undefined
}
