#!/usr/bin/env node
// Stress runner entry: wire config → fixtures → auth → observer → load → report.

import { parseArgs, guardAgainstProduction, usage } from './config.js'
import { discoverRoutes } from './routes.js'
import { loadFixtures } from './fixtures.js'
import { StressClient } from './client.js'
import { ensureGate, adminLogin, customerLogin, pinCurrentStore, closePrompt } from './auth.js'
import { MongoObserver } from './observer.js'
import { measureBaseline, runSequential, runChaos } from './load.js'
import { printReport, saveReport } from './report.js'
import { CUSTOMER_PLATFORM } from './payloads.js'
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
        console.log(`  ${String(route.route).padEnd(40)} ${route.alsoRead ? 'read*' : route.readOnly ? 'read ' : 'WRITE'} ${route.permissions.join(',')}`)
    process.exit(0)
}

guardAgainstProduction(opts.uri)

const log = message => console.log(`[stress] ${message}`)

const fixtures = await loadFixtures(opts.uri, { idNum: opts.idNum, userPhone: opts.userPhone })
if (opts.userPhone && !fixtures.customerPhone)
    log(`--user-phone ${opts.userPhone} is not a user of this stress DB — the storefront routes will be skipped`)

// One client per session: the admin, the picker of the sampled picking order
// (suggest_replacements answers 403 to anyone else) and the shopper behind the
// storefront routes (platform 'web', storefront Origin, its own cookie jar).
const clients = { admin: null, picker: null, customer: null }
let gated = false

async function newClient({ origin, platform }) {
    const client = new StressClient({ baseUrl: opts.baseUrl, origin, platform })
    if (gated) await client.gateLogin(opts.gatePassword)
    return client
}

let observer

try {
    observer = new MongoObserver(opts.uri, {
        profileEnabled: opts.profile,
        slowMs: opts.slowMs,
        probeEvery: opts.probeEvery,
        // The ranking probe: an index-covered single-doc read (barcode_1), issued
        // straight against mongod by the observer. See observer.js for why it is not
        // an HTTP call.
        probe: fixtures.productBarcodes.length
            ? { collection: 'products', filter: { barcode: String(fixtures.productBarcodes[0]) }, projection: { _id: 0, barcode: 1 } }
            : null
    })
    const capabilities = await observer.connect()
    log(`observer capabilities: ${JSON.stringify(capabilities)}`)

    clients.admin = await newClient({ origin: opts.adminOrigin })
    gated = (await ensureGate(clients.admin, { gatePassword: opts.gatePassword })).gated
    await adminLogin(clients.admin, fixtures, { idNum: opts.idNum, headlessOtp: opts.headlessOtp })
    if (await pinCurrentStore(clients.admin, fixtures))
        log(`pinned admin currentStoreId=${fixtures.currentStoreId}`)

    if (fixtures.pickerIdNum && !opts.headlessOtp && fixtures.pickerIdNum !== opts.idNum)
        log(`picker session needs --headless-otp (its OTP goes to that picker's own phone) — order/ops/suggest_replacements skipped`)
    else if (fixtures.pickerIdNum) {
        clients.picker = await newClient({ origin: opts.adminOrigin })
        await adminLogin(clients.picker, fixtures, { idNum: fixtures.pickerIdNum, phone: fixtures.pickerPhone, label: 'picker', headlessOtp: opts.headlessOtp })
        log(`picker session (idNum ${fixtures.pickerIdNum}): order ${fixtures.pickOrderId}, cart item ${fixtures.pickBarcode}`)
    }

    if (fixtures.customerPhone) {
        const shopper = await newClient({ origin: opts.storefrontOrigin, platform: CUSTOMER_PLATFORM })
        await customerLogin(shopper, fixtures, { phone: fixtures.customerPhone, headlessOtp: opts.headlessOtp })
        // Single read first: getUserOrder creates the cart order for a shopper who
        // has none, and a burst racing that creation is not what we want to time.
        const warm = await shopper.call('order/cart/get', {})
        if (!fixtures.customerCartStoreId) await fixtures.refreshCustomerCart()
        clients.customer = shopper
        log(`customer session: cart ${fixtures.customerCartId || '—'} store ${fixtures.customerCartStoreId || '—'} (warm-up ${warm.status} ${warm.ms}ms)`)
    }

    const routes = await discoverRoutes({ only: opts.only, mutations: opts.mutations })
    if (!routes.length) throw new Error('no routes matched the allow-list/regex')
    log(`${routes.length} routes queued`)

    const domainId = fixtures.domainId
    await sleep(1000) // let pools/plans settle before measuring the baseline
    const baseline = await measureBaseline({ client: clients.admin, observer, fixtures, seconds: opts.baselineSeconds, probeEvery: opts.probeEvery, domainId })
    log(`baseline probe: ${JSON.stringify(baseline.kinds)} stats: ${JSON.stringify(baseline.stats)}`)

    const startedAt = new Date()
    const t0 = Date.now()
    let sequential = null
    let chaos = null
    if (opts.mode === 'sequential' || opts.mode === 'both')
        sequential = await runSequential({
            clients, fixtures, observer, routes,
            calls: opts.calls, concurrency: opts.concurrency,
            probeEvery: opts.probeEvery, gap: opts.gap, minWindowMs: opts.minWindow, domainId, log
        })
    if (opts.mode === 'chaos' || opts.mode === 'both')
        chaos = await runChaos({
            clients, fixtures, observer, routes,
            chaosDuration: opts.chaosDuration, concurrency: opts.concurrency,
            domainId, log
        })
    const durationMs = Date.now() - t0

    printReport({ opts, capabilities, baseline, sequential, chaos, durationMs })
    saveReport({ opts, startedAt, capabilities, baseline, sequential, chaos, durationMs })
} finally {
    closePrompt()
    await observer?.close()
    await fixtures.close()
}
