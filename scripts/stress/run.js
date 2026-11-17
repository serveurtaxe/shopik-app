#!/usr/bin/env node
// Stress runner entry: wire config → fixtures → auth → observer → load → report.

import { parseArgs, guardAgainstProduction, usage } from './config.js'
import { discoverRoutes } from './routes.js'
import { loadFixtures } from './fixtures.js'
import { StressClient } from './client.js'
import { ensureGate, adminLogin, pinCurrentStore } from './auth.js'
import { MongoObserver } from './observer.js'
import { measureBaseline, runSequential, runChaos } from './load.js'
import { printReport, saveReport } from './report.js'
import { sleep } from './util.js'

const opts = parseArgs()
if (opts.help) {
    console.log(usage())
    process.exit(0)
}

if (opts.discoverOnly) {
    const routes = await discoverRoutes({ only: opts.only, mutations: opts.mutations })
    console.log(`${routes.length} routes (${opts.mutations ? 'read + mutations' : 'read-only allow-list'}):\n`)
    for (const route of routes)
        console.log(`  ${String(route.route).padEnd(40)} ${route.readOnly ? 'read ' : 'WRITE'} ${route.permissions.join(',')}`)
    process.exit(0)
}

guardAgainstProduction(opts.uri)

const interactive = Boolean(process.stdin.isTTY)
const log = message => console.log(`[stress] ${message}`)

const fixtures = await loadFixtures(opts.uri, { idNum: opts.idNum })
const client = new StressClient({ baseUrl: opts.baseUrl, origin: opts.adminOrigin })
let observer

try {
    observer = new MongoObserver(opts.uri, { profileEnabled: opts.profile })
    const capabilities = await observer.connect()
    log(`observer capabilities: ${JSON.stringify(capabilities)}`)

    await ensureGate(client, { gatePassword: opts.gatePassword, interactive })
    await adminLogin(client, fixtures, { idNum: opts.idNum, headlessOtp: opts.headlessOtp, interactive })
    if (await pinCurrentStore(client, fixtures))
        log(`pinned admin currentStoreId=${fixtures.currentStoreId}`)

    const routes = await discoverRoutes({ only: opts.only, mutations: opts.mutations })
    if (!routes.length) throw new Error('no routes matched the allow-list/regex')
    log(`${routes.length} routes queued`)

    const domainId = fixtures.domainId
    await sleep(1000) // let pools/plans settle before measuring the baseline
    const baseline = await measureBaseline({ client, fixtures, seconds: 4, probeEvery: opts.probeEvery, domainId })
    log(`baseline probe: ${JSON.stringify(baseline.kinds)} stats: ${JSON.stringify(baseline.stats)}`)

    const startedAt = new Date()
    const t0 = Date.now()
    let sequential = null
    let chaos = null
    if (opts.mode === 'sequential' || opts.mode === 'both')
        sequential = await runSequential({
            client, fixtures, observer, routes,
            calls: opts.calls, concurrency: opts.concurrency,
            probeEvery: opts.probeEvery, gap: opts.gap, domainId, log
        })
    if (opts.mode === 'chaos' || opts.mode === 'both')
        chaos = await runChaos({
            client, fixtures, observer, routes,
            chaosDuration: opts.chaosDuration, concurrency: opts.concurrency,
            domainId, log
        })
    const durationMs = Date.now() - t0

    printReport({ opts, capabilities, baseline, sequential, chaos, durationMs })
    saveReport({ opts, startedAt, capabilities, baseline, sequential, chaos, durationMs })
} finally {
    await observer?.close()
    await fixtures.close()
}
