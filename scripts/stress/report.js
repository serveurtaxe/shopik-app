// Console ranking + JSON artifact. Ranking metric = probe inflation: a fixed indexed
// single-doc read hammered at a constant cadence, measured during each route's window
// vs the no-load baseline — the route that drags the DB down inflates a query it does
// not touch.
//
// The headline impact is the probe MEDIAN ratio, not the p95 ratio: a window is a few
// seconds of probes, and a p95 over a dozen samples moves on its own (a 10-call smoke
// run made every single route look like DB DRAG on it). The tail is still reported —
// impactTail, plus a tail-drag flag — because a route that only hurts the tail is what
// a heavy scan looks like.
//
// Three guards keep that ranking honest:
// - a burst whose calls did not succeed (bad-payload / server-error / auth) did NO db
//   work: it gets no impact number and sorts last, so a route that only produced 400s
//   can never be read as a cheap one;
// - every row carries what one call actually returned (median bytes / items), because
//   a route that answered [] measured an early return, not mongo;
// - a window with too few probes (low-n) shows its numbers but earns no DB DRAG
//   verdict: the sample is not big enough to tell inflation from noise.

import fs from 'node:fs'
import path from 'node:path'
import { fmtMs } from './util.js'

function ratio(value, base) {
    if (!value || !base) return null
    return +(value / base).toFixed(2)
}

// Kinds that are not a successful call: server-error / bad-payload / auth /
// rate-limited / timeout / network. A burst of those did no DB work at all, so
// its probe inflation belongs to nobody and must not be ranked as a cheap route.
function failedKinds(kinds = {}) {
    return Object.entries(kinds)
        .filter(([kind]) => kind !== 'ok')
        .sort((a, b) => b[1] - a[1])
}

// Below this many probe samples a window's inflation numbers are noise-prone.
const MIN_PROBE_SAMPLES = 12

function verdict(row) {
    const flags = []
    if (row.noWork) flags.push(`no-work (${row.notOk} ${row.dominantKind})`)
    else if (row.notOk > 0) flags.push(`${row.notOk}× ${row.dominantKind}`)
    if (row.answeredNothing) flags.push('answered-nothing')
    if (row.collscans > 0) flags.push('COLLSCAN')
    if (row.heavyScan) flags.push('HEAVY-SCAN')
    if (row.probeSamples > 0 && row.probeSamples < MIN_PROBE_SAMPLES) flags.push(`low-n (${row.probeSamples} probes)`)
    else if (row.impact != null && row.impact >= 2) flags.push('DB DRAG')
    else if (row.impact != null && row.impact >= 1.3) flags.push('elevated')
    // Median flat but tail up: the burst is not saturating the DB, it is occasionally
    // making the probe wait behind a slow query — worth looking at, not a verdict.
    if (row.impactTail != null && row.impactTail >= 2 && (row.impact == null || row.impact < 1.3))
        flags.push('tail-drag')
    return flags.join(' + ') || 'ok'
}

function summarize(results, baseline, mode = 'sequential') {
    const rows = []
    for (const entry of results) {
        if (entry.skipped) {
            rows.push({
                route: entry.route,
                mode,
                session: entry.session || null,
                skipped: true,
                verdict: `skipped (${entry.skipped})`
            })
            continue
        }
        if (entry.route === '__chaos_total__') continue
        const calls = entry.calls?.stats || {}
        const httpStats = entry.probe?.stats || {}
        const dbStats = entry.db?.probeDb || {}
        const failures = failedKinds(entry.calls?.kinds)
        const notOk = failures.reduce((sum, [, count]) => sum + count, 0)
        const noWork = notOk > 0 && !(entry.calls?.ok > 0)
        const profile = entry.db?.profile
        const collscans = (profile?.totalCollscans ?? 0) + (entry.db?.collscans ?? 0)
        const maxDocs = Math.max(0, ...(profile?.worst || []).map(w => w.maxDocsExamined || 0))
        const maxKeys = Math.max(0, ...(profile?.worst || []).map(w => w.maxKeysExamined || 0))
        // Scan size = the bigger of docs/keys examined anywhere in the window: an
        // index-covered count of 10k products shows up as keys, a whole-collection
        // read as docs.
        const maxScan = Math.max(maxDocs, maxKeys)
        // A row whose burst returned an empty list/object measured a route that
        // never reached mongo — real, but not a load number to compare against.
        const answeredNothing = !noWork && entry.calls?.items === 0
        // The observer's direct DB probe is the ranking basis; the HTTP probe (which
        // also carries the app's own queueing) is kept as context, and becomes the
        // basis only if the DB probe was unavailable.
        const basis = dbStats.count > 0 ? dbStats : httpStats.count > 0 ? httpStats : null
        const basisBase = basis === dbStats ? baseline?.db?.probeDb : baseline?.stats
        const impact = basis && !noWork ? ratio(basis.p50, basisBase?.p50) : null
        const impactTail = basis && !noWork ? ratio(basis.p95, basisBase?.p95) : null
        const httpImpact = basis === dbStats && httpStats.count > 0 && !noWork
            ? ratio(httpStats.p50, baseline?.stats?.p50) : null
        const row = {
            route: entry.route,
            mode,
            session: entry.session || 'admin',
            calls: calls.count ?? 0,
            rounds: entry.calls?.rounds ?? null,
            okCalls: entry.calls?.ok ?? null,
            notOk,
            dominantKind: failures[0]?.[0] || null,
            noWork,
            answeredNothing,
            errors: entry.calls?.kinds?.['server-error'] || 0,
            badPayload: entry.calls?.kinds?.['bad-payload'] || 0,
            p50Ms: calls.p50 ?? null,
            p95Ms: calls.p95 ?? null,
            probeBasis: basis ? (basis === dbStats ? 'db' : 'http') : null,
            probeP50Ms: basis?.p50 ?? null,
            probeP95Ms: basis?.p95 ?? null,
            probeSamples: basis?.count ?? 0,
            impact,
            impactTail,
            httpProbeP50Ms: httpStats.p50 ?? null,
            httpImpact,
            collscans: collscans || 0,
            maxDocsExamined: maxDocs || null,
            maxKeysExamined: maxKeys || null,
            maxScan: maxScan || null,
            profileMillis: profile?.totalMillis ?? null,
            respBytes: entry.calls?.bytes ?? null,
            respItems: entry.calls?.items ?? null,
            wtMB: entry.db?.cacheMB ?? null,
            dirtyDeltaMB: entry.db?.dirtyDeltaMB ?? null,
            evictions: entry.db?.evictions || null
        }
        row.heavyScan = maxScan >= 50_000
        row.verdict = verdict(row)
        if (entry.db?.profile?.worst?.length)
            row.worst = entry.db.profile.worst.slice(0, 3)
        rows.push(row)
    }
    // Ranking: the DB work the window actually caused — the biggest docs/keys examined
    // by any operation in it — with probe inflation as the tie-breaker and the route's
    // own latency after that. The probe alone cannot rank a local run: with the dataset
    // fitting the wiredTiger cache nothing inflates, and every route reads the same 1%.
    rows.sort((a, b) => (b.maxScan ?? 0) - (a.maxScan ?? 0)
        || (b.impact ?? -1) - (a.impact ?? -1)
        || (b.p50Ms ?? 0) - (a.p50Ms ?? 0))
    return rows
}

function pad(value, width, right = false) {
    const s = String(value ?? '')
    return right ? s.padStart(width) : s.padEnd(width)
}

function fmtBytes(bytes) {
    if (bytes == null) return '—'
    return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}k` : `${bytes}b`
}

// resp = what one call handed back: median bytes / median items. '12.3k/32' is a
// route reading 32 documents; '30b/0' is a route that answered an empty list and
// therefore did no real reading.
function fmtResp(row) {
    if (row.respBytes == null && row.respItems == null) return '—'
    return `${fmtBytes(row.respBytes)}/${row.respItems ?? '—'}`
}

export function printReport({ opts, capabilities, baseline, sequential, chaos, durationMs }) {
    const base = baseline?.stats
    const baseDb = baseline?.db?.probeDb
    console.log('\n══════════ stress report ══════════')
    console.log(`target: ${opts.target} (${capabilities.mode})  mode: ${opts.mode}  wall: ${(durationMs / 1000).toFixed(1)}s`)
    console.log(`baseline probe — db: p50 ${fmtMs(baseDb?.p50)} p95 ${fmtMs(baseDb?.p95)} (n=${baseDb?.count ?? 0})   http: p50 ${fmtMs(base?.p50)} p95 ${fmtMs(base?.p95)} (n=${base?.count ?? 0})`)
    if ((baseDb?.count ?? 0) < MIN_PROBE_SAMPLES && (base?.count ?? 0) < MIN_PROBE_SAMPLES)
        console.log(`⚠ baseline has only ${baseDb?.count ?? 0} db / ${base?.count ?? 0} http probes — impacts are not trustworthy, raise --baseline-seconds`)

    if (sequential?.length) {
        const rows = summarize(sequential, baseline)
        const basis = rows.find(row => row.probeBasis)?.probeBasis || '—'
        console.log(`\n── sequential (sorted by docs/keys examined in the window, then ${basis}-probe inflation) ${'─'.repeat(8)}`)
        console.log(pad('route', 34) + pad('sess', 8) + pad('calls', 6, true) + pad('p50', 9, true) + pad('p95', 9, true)
            + pad('probe', 7, true) + pad('impact', 7, true) + pad('tail', 6, true) + pad('n', 3, true)
            + pad('collscan', 8, true) + pad('maxScan', 9, true) + pad('dirtyΔ', 6, true) + pad('resp', 13, true) + '  verdict')
        for (const row of rows) {
            if (row.skipped) { console.log(pad(row.route, 34) + pad(row.session || '—', 8) + `  ${row.verdict}`); continue }
            console.log(
                pad(row.route, 34)
                + pad(row.session, 8)
                + pad(row.calls, 6, true)
                + pad(fmtMs(row.p50Ms), 9, true)
                + pad(fmtMs(row.p95Ms), 9, true)
                + pad(fmtMs(row.probeP50Ms), 9, true)
                + pad(row.impact == null ? '—' : `${row.impact}×`, 7, true)
                + pad(row.impactTail == null ? '—' : `${row.impactTail}×`, 6, true)
                + pad(row.probeSamples || '—', 4, true)
                + pad(row.collscans || '—', 8, true)
                + pad(row.maxScan ?? '—', 9, true)
                + pad(row.dirtyDeltaMB ?? '—', 6, true)
                + pad(fmtResp(row), 13, true)
                + `  ${row.verdict}`
            )
        }
        const ran = rows.filter(row => !row.skipped && !row.noWork).length
        const noWork = rows.filter(row => row.noWork).length
        const skipped = rows.filter(row => row.skipped).length
        console.log(`\nran: ${ran}  no-work: ${noWork}  skipped: ${skipped}  (no-work rows are not ranked — their probe window measured other work)`)
        const offenders = rows.filter(row => row.worst)
        if (offenders.length) {
            console.log('\n── worst profiled namespaces per offender')
            for (const row of offenders)
                for (const w of row.worst)
                    console.log(`${pad(row.route, 34)}  ${pad(w.ns, 26)} ops=${w.ops} collscan=${w.collscans} millis=${w.millis} maxDocs=${w.maxDocsExamined} maxKeys=${w.maxKeysExamined}`)
        }
    }

    if (chaos?.length) {
        console.log(`\n── chaos (aggregate; attribution not possible — use sequential for that) ${'─'.repeat(8)}`)
        const rows = summarize(chaos.filter(r => r.route !== '__chaos_total__'), baseline)
        for (const row of rows)
            console.log(pad(row.route, 34) + pad(row.session || '—', 8) + pad(row.calls, 6, true) + pad(fmtMs(row.p50Ms), 9, true) + pad(fmtMs(row.p95Ms), 9, true) + pad(fmtResp(row), 14, true) + `  ${row.verdict}`)
        const total = chaos.find(r => r.route === '__chaos_total__')
        if (total?.chaosDb) {
            const db = total.chaosDb
            console.log(`\nchaos db window: collscans=${db.collscans} slowOps=${db.slowOps} maxActiveSecs=${db.maxActiveSecs} evictions=${db.evictions} cache=${db.cacheMB ?? '?'}MB dirtyΔ=${db.dirtyDeltaMB ?? '?'}MB dbProbe=${JSON.stringify(db.probeDb || {})}`)
            if (db.profile?.worst?.length)
                for (const w of db.profile.worst.slice(0, 10))
                    console.log(`  ${pad(w.ns, 26)} ops=${w.ops} collscan=${w.collscans} millis=${w.millis} maxDocs=${w.maxDocsExamined} maxKeys=${w.maxKeysExamined}`)
        }
    }
}

export function saveReport({ opts, startedAt, capabilities, baseline, sequential, chaos, durationMs }) {
    fs.mkdirSync(opts.reportDir, { recursive: true })
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = path.join(opts.reportDir, `${stamp}-${opts.target}-${opts.mode}.json`)
    const sequentialRows = sequential && summarize(sequential, baseline, 'sequential')
    const chaosRows = chaos && summarize(chaos.filter(r => r.route !== '__chaos_total__'), baseline, 'chaos')
    const data = {
        startedAt: startedAt.toISOString(),
        durationMs,
        target: { target: opts.target, baseUrl: opts.baseUrl },
        capabilities,
        options: {
            mode: opts.mode, calls: opts.calls, concurrency: opts.concurrency, chaosDuration: opts.chaosDuration,
            probeEvery: opts.probeEvery, gap: opts.gap, baselineSeconds: opts.baselineSeconds, minWindow: opts.minWindow
        },
        baseline,
        sequential: sequentialRows,
        sequentialRaw: sequential && sequential.map(entry => ({ ...entry, db: entry.db })),
        chaos: chaos && {
            rows: chaosRows,
            db: chaos.find(r => r.route === '__chaos_total__')?.chaosDb
        }
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
    console.log(`\nreport saved: ${file}`)

    // Spreadsheet-friendly ranking: raw numeric ms columns, sorted by impact.
    const columns = ['route', 'mode', 'session', 'skipped', 'calls', 'rounds', 'okCalls', 'notOk', 'dominantKind',
        'noWork', 'answeredNothing', 'errors', 'badPayload', 'p50Ms', 'p95Ms', 'probeBasis', 'probeP50Ms',
        'probeP95Ms', 'probeSamples', 'impact', 'impactTail', 'httpProbeP50Ms', 'httpImpact', 'collscans',
        'maxDocsExamined', 'maxKeysExamined', 'maxScan', 'profileMillis', 'respBytes', 'respItems', 'wtMB', 'dirtyDeltaMB', 'evictions', 'verdict']
    const escape = value => value == null ? '' : `"${String(value).replace(/"/g, '""')}"`
    const rows = [...(sequentialRows || []), ...(chaosRows || [])]
    const csv = ['\uFEFF' + columns.join(',')]
        .concat(rows.map(row => columns.map(col => escape(row[col])).join(',')))
        .join('\r\n')
    const csvFile = file.replace(/\.json$/, '.csv')
    fs.writeFileSync(csvFile, csv)
    console.log(`csv saved:  ${csvFile}`)
    return file
}
