// Load generation: sequential bursts (one route at a time, attributed by a
// concurrent cheap probe) and chaos mode (everything at once, aggregate only).
//
// The probe is the discriminator: a fixed indexed single-doc read hammered at a
// constant cadence. If the probe slows down while route X is bursting, X is
// what dragged the DB down — that ranks the routes, not their own latency.

import { latencyStats, pool, sleep } from './util.js'
import { PROBE_ROUTE, probePayload, payloadFor, sessionFor } from './payloads.js'

// Each burst fires with the session its route actually needs (see payloads.js
// SESSIONS); the probe always runs on the admin session so its numbers stay
// comparable from window to window.
function clientFor(clients, route) {
    const session = sessionFor(route)
    return { session, client: session === 'admin' ? clients.admin : clients[session] }
}

const median = values => {
    if (!values.length) return null
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
}

// One shared accounting for a burst and for a chaos window: latency percentiles, the
// kind histogram, and what actually came back. bytes/items are what separate a cheap
// route from one that answered nothing.
//
// It folds INCREMENTALLY on purpose: a sustained window fires thousands of calls and
// some routes answer megabytes each (gs1/aliases, category/tree). Holding every
// response — body included — is how a sweep runs out of heap, so the body is dropped
// the moment the call has been counted.
function newCallAccounting() {
    const kinds = {}
    const durations = []
    const bytes = []
    const items = []
    const ERROR_KINDS = new Set(['server-error', 'auth', 'gate', 'timeout', 'network', 'rate-limited'])
    let ok = 0
    let firstError = null
    return {
        add(res) {
            kinds[res.kind] = (kinds[res.kind] || 0) + 1
            durations.push(res.ms)
            if (res.ok) {
                ok++
                bytes.push(res.bytes)
                if (res.items != null) items.push(res.items)
            } else if (!firstError && ERROR_KINDS.has(res.kind))
                firstError = res.error || res.kind
        },
        summary() {
            return {
                stats: latencyStats(durations),
                kinds,
                ok,
                notOk: durations.length - ok,
                bytes: median(bytes),
                items: median(items),
                firstError
            }
        }
    }
}

function skipReason(payload) {
    if (payload === null) return 'missing fixture'
    return payload?.skip || null
}

function withDomain(payload, domainId) {
    if (domainId == null || payload.domainId != null) return payload
    return { ...payload, domainId }
}

// A route whose 30-call burst finishes in 200ms leaves the probe 1-2 samples, so its
// "impact" would be pure noise. Each burst is therefore REPEATED until the window has
// run minWindowMs — which is also the more honest load shape (a screen a user keeps
// opening, not a single flash) and gives every window a comparable number of probes.
async function sustainedBurst(client, route, payload, { calls, concurrency, domainId, minWindowMs }) {
    const accounting = newCallAccounting()
    const started = Date.now()
    let rounds = 0
    do {
        const round = await pool(calls, concurrency, () =>
            client.call(route, withDomain(payload, domainId)))
        for (const res of round) accounting.add(res)
        rounds++
    } while (Date.now() - started < minWindowMs)
    return { ...accounting.summary(), rounds }
}

async function probeLoop(client, fixtures, { domainId, probeEvery, until }) {
    const durations = []
    const kinds = {}
    while (!until.done) {
        const res = await client.call(PROBE_ROUTE, withDomain(probePayload(fixtures), domainId), { timeoutMs: 15_000 })
        durations.push(res.ms)
        kinds[res.kind] = (kinds[res.kind] || 0) + 1
        await sleep(probeEvery)
    }
    return { stats: latencyStats(durations), kinds }
}

export async function measureBaseline({ client, observer, fixtures, seconds = 10, probeEvery, domainId }) {
    const until = { done: false }
    const timer = setTimeout(() => { until.done = true }, seconds * 1000)
    // The baseline IS a window: the DB probe fills it exactly like a route window, so
    // the impact ratios compare the same query against the same measurement.
    await observer.openWindow('baseline')
    const http = await probeLoop(client, fixtures, { domainId, probeEvery, until })
    clearTimeout(timer)
    const db = await observer.closeWindow()
    return { ...http, db }
}

export async function runSequential({ clients, fixtures, observer, routes, calls, concurrency, probeEvery, gap, minWindowMs, domainId, log }) {
    const results = []
    for (const [index, route] of routes.entries()) {
        const payload = payloadFor(route.route, fixtures)
        const skip = skipReason(payload)
        if (skip) {
            results.push({ route: route.route, skipped: skip, config: route, session: sessionFor(route.route) })
            continue
        }
        const { session, client } = clientFor(clients, route.route)
        if (!client) {
            results.push({ route: route.route, skipped: `no ${session} session`, config: route, session })
            continue
        }
        // preventMultiple routes 429 their own concurrent burst (request lock),
        // which pollutes both the latency stats and the probe window. Serial.
        const burstConcurrency = route.preventMultiple ? 1 : concurrency
        log(`(${index + 1}/${routes.length}) ${route.route} — ${calls} calls × ${burstConcurrency} for ≥${minWindowMs}ms${route.preventMultiple ? ' (request-locked)' : ''}${session === 'admin' ? '' : ` as ${session}`}`)
        await observer.openWindow(route.route)
        const until = { done: false }
        const bursting = sustainedBurst(client, route.route, payload, { calls, concurrency: burstConcurrency, domainId, minWindowMs })
            .finally(() => { until.done = true })
        const probe = probeLoop(clients.admin, fixtures, { domainId, probeEvery, until })
        const [callsResult, probeResult] = await Promise.all([bursting, probe])
        const db = await observer.closeWindow()
        results.push({
            route: route.route,
            config: route,
            session,
            calls: callsResult,
            probe: probeResult,
            db
        })
        if (callsResult.firstError)
            log(`    ⚠ first error: ${callsResult.firstError}`)
        await sleep(gap) // drain: keep bursts from bleeding into the next window
    }
    return results
}

export async function runChaos({ clients, fixtures, observer, routes, chaosDuration, concurrency, domainId, log }) {
    const usable = []
    for (const route of routes) {
        const payload = payloadFor(route.route, fixtures)
        if (skipReason(payload)) continue
        const { session, client } = clientFor(clients, route.route)
        if (!client) continue
        usable.push({ route, payload, client, session })
    }
    const skipped = routes.length - usable.length
    log(`chaos: ${usable.length} routes × ${concurrency} inflight × ${chaosDuration}s`)

    // One accounting per route (not an array of responses): the chaos phase runs for
    // minutes and some routes answer megabytes per call.
    const perRoute = new Map(usable.map(({ route }) => [route.route, newCallAccounting()]))
    const sessions = new Map(usable.map(({ route, session }) => [route.route, session]))
    await observer.openWindow('chaos')
    const deadline = Date.now() + chaosDuration * 1000
    let cursor = 0
    await pool(concurrency, concurrency, async () => {
        while (Date.now() < deadline) {
            const entry = usable[cursor++ % usable.length]
            const res = await entry.client.call(entry.route.route, withDomain(entry.payload, domainId))
            perRoute.get(entry.route.route).add(res)
        }
    })
    const db = await observer.closeWindow()

    const results = []
    // One shared window for the whole chaos phase: its DB numbers describe the
    // aggregate and land on __chaos_total__, not on every route row (that would
    // print the same COLLSCAN flag on routes that may not have caused it).
    for (const [name, accounting] of perRoute)
        results.push({ route: name, session: sessions.get(name), calls: accounting.summary() })
    results.push({ route: '__chaos_total__', chaosDb: db, skipped })
    return results
}
