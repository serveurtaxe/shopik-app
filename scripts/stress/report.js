// Console ranking + JSON artifact. Ranking metric = probe inflation: probe p95
// during the route's window vs the no-load baseline — the route that drags the
// DB down inflates a query it does not touch.

import fs from 'node:fs'
import path from 'node:path'
import { fmtMs } from './util.js'

function ratio(value, base) {
    if (!value || !base) return null
    return +(value / base).toFixed(2)
}

function verdict(row) {
    const flags = []
    if (row.collscans > 0) flags.push('COLLSCAN')
    if (row.heavyScan) flags.push('HEAVY-SCAN')
    if (row.impact != null && row.impact >= 2) flags.push('DB DRAG')
    else if (row.impact != null && row.impact >= 1.3) flags.push('elevated')
    return flags.join(' + ') || 'ok'
}

function summarize(results, baseline) {
    const rows = []
    for (const entry of results) {
        if (entry.skipped) {
            rows.push({ route: entry.route, verdict: `skipped (${entry.skipped})` })
            continue
        }
        if (entry.route === '__chaos_total__') continue
        const calls = entry.calls?.stats || {}
        const probeP95 = entry.probe?.stats?.p95 ?? entry.chaosProbeP95 ?? null
        const impact = entry.probe ? ratio(probeP95, baseline?.stats?.p95) : null
        const profile = entry.db?.profile
        const collscans = (profile?.totalCollscans ?? 0) + (entry.db?.collscans ?? 0)
        const maxDocs = Math.max(0, ...(profile?.worst || []).map(w => w.maxDocsExamined || 0))
        const row = {
            route: entry.route,
            calls: calls.count ?? 0,
            errors: entry.calls?.kinds?.['server-error'] || 0,
            badPayload: entry.calls?.kinds?.['bad-payload'] || 0,
            p50: fmtMs(calls.p50),
            p95: fmtMs(calls.p95),
            probeP95: fmtMs(probeP95),
            impact,
            collscans: collscans || 0,
            maxDocsExamined: maxDocs || null,
            wtMB: entry.db?.cacheMB ?? null,
            dirtyMB: entry.db?.dirtyMB ?? null,
            evictions: entry.db?.evictions || null,
            verdict: verdict({ collscans, impact, heavyScan: maxDocs >= 50_000 })
        }
        if (entry.db?.profile?.worst?.length)
            row.worst = entry.db.profile.worst.slice(0, 3)
        rows.push(row)
    }
    rows.sort((a, b) => (b.impact ?? -1) - (a.impact ?? -1))
    return rows
}

function pad(value, width, right = false) {
    const s = String(value ?? '')
    return right ? s.padStart(width) : s.padEnd(width)
}

export function printReport({ opts, capabilities, baseline, sequential, chaos, durationMs }) {
    const base = baseline?.stats
    console.log('\n══════════ stress report ══════════')
    console.log(`target: ${opts.target} (${capabilities.mode})  mode: ${opts.mode}  wall: ${(durationMs / 1000).toFixed(1)}s`)
    console.log(`baseline probe: p50 ${fmtMs(base?.p50)} p95 ${fmtMs(base?.p95)} (n=${base?.count})`)

    if (sequential?.length) {
        const rows = summarize(sequential, baseline)
        console.log(`\n── sequential (probe inflation ranks the DB drag) ${'─'.repeat(8)}`)
        console.log(pad('route', 34) + pad('calls', 6, true) + pad('p50', 9, true) + pad('p95', 9, true)
            + pad('probe-p95', 11, true) + pad('impact', 7, true) + pad('collscan', 9, true)
            + pad('wtMB', 8, true) + pad('dirty', 7, true) + '  verdict')
        for (const row of rows) {
            if (row.skipped) { console.log(pad(row.route, 34) + `  ${row.verdict}`); continue }
            console.log(
                pad(row.route, 34)
                + pad(row.calls, 6, true)
                + pad(row.p50, 9, true)
                + pad(row.p95, 9, true)
                + pad(row.probeP95, 11, true)
                + pad(row.impact == null ? '—' : `${row.impact}×`, 7, true)
                + pad(row.collscans || '—', 9, true)
                + pad(row.wtMB ?? '—', 8, true)
                + pad(row.dirtyMB ?? '—', 7, true)
                + `  ${row.verdict}`
            )
        }
        const offenders = rows.filter(row => row.worst)
        if (offenders.length) {
            console.log('\n── worst profiled namespaces per offender')
            for (const row of offenders)
                for (const w of row.worst)
                    console.log(`${pad(row.route, 34)}  ${pad(w.ns, 26)} ops=${w.ops} collscan=${w.collscans} millis=${w.millis} maxDocs=${w.maxDocsExamined}`)
        }
    }

    if (chaos?.length) {
        console.log(`\n── chaos (aggregate; attribution not possible — use sequential for that) ${'─'.repeat(8)}`)
        const rows = summarize(chaos.filter(r => r.route !== '__chaos_total__'), baseline)
        for (const row of rows)
            console.log(pad(row.route, 34) + pad(row.calls, 6, true) + pad(row.p50, 9, true) + pad(row.p95, 9, true) + `  ${row.verdict}`)
        const total = chaos.find(r => r.route === '__chaos_total__')
        if (total?.chaosDb) {
            const db = total.chaosDb
            console.log(`\nchaos db window: collscans=${db.collscans} slowOps=${db.slowOps} maxActiveSecs=${db.maxActiveSecs} evictions=${db.evictions} cache=${db.cacheMB ?? '?'}MB dirty=${db.dirtyMB ?? '?'}MB`)
            if (db.profile?.worst?.length)
                for (const w of db.profile.worst.slice(0, 10))
                    console.log(`  ${pad(w.ns, 26)} ops=${w.ops} collscan=${w.collscans} millis=${w.millis} maxDocs=${w.maxDocsExamined}`)
        }
    }
}

export function saveReport({ opts, startedAt, capabilities, baseline, sequential, chaos, durationMs }) {
    fs.mkdirSync(opts.reportDir, { recursive: true })
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = path.join(opts.reportDir, `${stamp}-${opts.target}-${opts.mode}.json`)
    const data = {
        startedAt: startedAt.toISOString(),
        durationMs,
        target: { target: opts.target, baseUrl: opts.baseUrl },
        capabilities,
        options: { mode: opts.mode, calls: opts.calls, concurrency: opts.concurrency, chaosDuration: opts.chaosDuration },
        baseline,
        sequential: sequential && summarize(sequential, baseline),
        sequentialRaw: sequential && sequential.map(entry => ({ ...entry, db: entry.db })),
        chaos: chaos && {
            rows: summarize(chaos.filter(r => r.route !== '__chaos_total__'), baseline),
            db: chaos.find(r => r.route === '__chaos_total__')?.chaosDb
        }
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
    console.log(`\nreport saved: ${file}`)
    return file
}
