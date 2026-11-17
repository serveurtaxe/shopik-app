// Load generation: sequential bursts (one route at a time, attributed by a
// concurrent cheap probe) and chaos mode (everything at once, aggregate only).
//
// The probe is the discriminator: a fixed indexed single-doc read hammered at a
// constant cadence. If the probe slows down while route X is bursting, X is
// what dragged the DB down — that ranks the routes, not their own latency.

import { latencyStats, pool, sleep } from './util.js'
import { PROBE_ROUTE, probePayload, payloadFor } from './payloads.js'

function withDomain(payload, domainId) {
    if (domainId == null || payload.domainId != null) return payload
    return { ...payload, domainId }
}

async function burst(client, route, payload, { calls, concurrency, domainId }) {
    const results = await pool(calls, concurrency, () =>
        client.call(route, withDomain(payload, domainId)))
    const kinds = {}
    const durations = []
    for (const res of results) {
        kinds[res.kind] = (kinds[res.kind] || 0) + 1
        durations.push(res.ms)
    }
    const firstError = results.find(res => res.kind === 'server-error' || res.kind === 'auth' || res.kind === 'gate')
    return { stats: latencyStats(durations), kinds, firstError: firstError ? firstError.body?.message : null }
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

export async function measureBaseline({ client, fixtures, seconds = 3, probeEvery, domainId }) {
    const until = { done: false }
    const timer = setTimeout(() => { until.done = true }, seconds * 1000)
    const baseline = await probeLoop(client, fixtures, { domainId, probeEvery, until })
    clearTimeout(timer)
    return baseline
}

export async function runSequential({ client, fixtures, observer, routes, calls, concurrency, probeEvery, gap, domainId, log }) {
    const results = []
    for (const [index, route] of routes.entries()) {
        const payload = payloadFor(route.route, fixtures)
        if (payload === null) {
            results.push({ route: route.route, skipped: 'missing fixture', config: route })
            continue
        }
        // preventMultiple routes 429 their own concurrent burst (request lock),
        // which pollutes both the latency stats and the probe window. Serial.
        const burstConcurrency = route.preventMultiple ? 1 : concurrency
        log(`(${index + 1}/${routes.length}) ${route.route} — ${calls} calls × ${burstConcurrency}${route.preventMultiple ? ' (request-locked)' : ''}`)
        observer.openWindow(route.route)
        const until = { done: false }
        const bursting = burst(client, route.route, payload, { calls, concurrency: burstConcurrency, domainId })
            .finally(() => { until.done = true })
        const probe = probeLoop(client, fixtures, { domainId, probeEvery, until })
        const [callsResult, probeResult] = await Promise.all([bursting, probe])
        const db = await observer.closeWindow()
        results.push({
            route: route.route,
            config: route,
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

export async function runChaos({ client, fixtures, observer, routes, chaosDuration, concurrency, domainId, log }) {
    const usable = routes
        .map(route => ({ route, payload: payloadFor(route.route, fixtures) }))
        .filter(entry => entry.payload !== null)
    log(`chaos: ${usable.length} routes × ${concurrency} inflight × ${chaosDuration}s`)

    const perRoute = new Map(usable.map(({ route }) => [route, []]))
    const skipped = routes.length - usable.length
    observer.openWindow('chaos')
    const deadline = Date.now() + chaosDuration * 1000
    let cursor = 0
    await pool(concurrency, concurrency, async () => {
        while (Date.now() < deadline) {
            const entry = usable[cursor++ % usable.length]
            const res = await client.call(entry.route, withDomain(entry.payload, domainId))
            perRoute.get(entry.route).push(res)
        }
    })
    const db = await observer.closeWindow()

    const results = []
    for (const [route, responses] of perRoute) {
        const kinds = {}
        const durations = []
        for (const res of responses) {
            kinds[res.kind] = (kinds[res.kind] || 0) + 1
            durations.push(res.ms)
        }
        results.push({ route, calls: { stats: latencyStats(durations), kinds }, db })
    }
    results.push({ route: '__chaos_total__', chaosDb: db, skipped })
    return results
}
