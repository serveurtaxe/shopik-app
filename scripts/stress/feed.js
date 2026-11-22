// Feed-only stress benchmark.
//
// The sitemap and Google Merchant documents are served per Host and are either
// a Redis hit (milliseconds) or the first request of a new generation (~1.6s
// for a 7.4k-product catalog). That cold/warm split is the interesting number,
// and it does not fit the route ranking in run.js (which measures DB pressure of
// /api reads), so the feed endpoints get their own phase.
//
// Requests go through node:http rather than fetch because fetch/undici refuses
// to override the Host header; the feed resolves the store from Host alone. The
// tool never clears a cache or writes anything: the first request is measured
// as-is, so a stale catalog regenerates exactly once (the same thing a crawler
// would trigger) and the rest are warm.

import http from 'node:http'
import https from 'node:https'
import { pool, latencyStats, fmtMs } from './util.js'

export const FEED_ENDPOINTS = [
    { key: 'sitemap-index', path: '/sitemap.xml' },
    { key: 'sitemap-pages', path: '/sitemap-pages.xml' },
    { key: 'sitemap-products-1', path: '/sitemap-products-1.xml' },
    { key: 'google-feed', path: '/google-feed.xml' }
]

function fmtBytes(bytes) {    if (bytes == null) return '—'
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${bytes} B`
}

function request({ baseUrl, host, path, cookie = '', headers = {}, timeoutMs, agent }) {
    const url = new URL(baseUrl)
    const lib = url.protocol === 'https:' ? https : http
    const started = performance.now()

    return new Promise(resolve => {
        let settled = false
        const finish = value => {
            if (settled) return
            settled = true
            resolve(value)
        }

        const req = lib.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || undefined,
            path,
            method: 'GET',
            agent,
            headers: {
                host,
                // Feed responses differ per host; an Origin keeps any shared
                // middleware happy without changing the resolved domain.
                origin: `https://${host}`,
                cookie,
                ...headers
            }
        }, res => {
            let bytes = 0
            res.on('data', chunk => { bytes += chunk.length })
            res.on('end', () => finish({
                status: res.statusCode,
                ms: performance.now() - started,
                bytes,
                etag: res.headers.etag || null,
                cacheControl: res.headers['cache-control'] || null
            }))
            res.on('error', error => finish({ status: 0, ms: performance.now() - started, bytes, error: error.message }))
        })

        req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
        req.on('error', error => finish({ status: 0, ms: performance.now() - started, bytes: 0, error: error.message }))
        req.end()
    })
}

function statusSummary(results) {
    const statuses = {}
    for (const result of results) {
        const key = result.status || 'network'
        statuses[key] = (statuses[key] || 0) + 1
    }
    return statuses
}

/**
 * @param {object} options
 * @param {string} options.baseUrl    running server, e.g. http://127.0.0.1:1990
 * @param {string} options.host       configured storefront domain to send as Host
 * @param {number} [options.calls]    warm calls per endpoint (default 10)
 * @param {number} [options.concurrency]
 * @param {string} [options.cookie]   gate cookie header, when the server is gated
 * @param {string} [options.only]     regex over endpoint keys (e.g. 'sitemap')
 * @param {number} [options.timeoutMs]
 * @param {(msg: string) => void} [options.log]
 */
export async function runFeedBenchmark({
    baseUrl,
    host,
    calls = 10,
    concurrency = 2,
    cookie = '',
    only = null,
    timeoutMs = 120_000,
    log = console.log,
    table = console.table
}) {
    if (!baseUrl) throw new Error('feed benchmark needs a base URL')
    if (!host) throw new Error('feed benchmark needs the storefront host to send as Host')

    const url = new URL(baseUrl)
    const lib = url.protocol === 'https:' ? https : http
    const agent = new lib.Agent({ keepAlive: true, maxSockets: Math.max(1, concurrency) + 1 })
    const regex = only ? new RegExp(only) : null
    const endpoints = FEED_ENDPOINTS.filter(endpoint => !regex || regex.test(endpoint.key))
    if (!endpoints.length) throw new Error(`no feed endpoint matches --only ${only}`)

    const requestFor = path => request({ baseUrl, host, path, cookie, timeoutMs, agent })
    const results = []

    log(`feed benchmark: ${baseUrl} with Host: ${host} — ${calls} warm calls × ${concurrency} per endpoint`)

    try {
        for (const endpoint of endpoints) {
            // First hit as-is: warm when a generation is already cached, otherwise
            // the request that builds the whole feed set.
            const first = await requestFor(endpoint.path)

            const warm = await pool(calls, concurrency, () => requestFor(endpoint.path))
            const stats = latencyStats(warm.map(result => result.ms))
            const ok = warm.filter(result => result.status === 200).length

            let conditional = null
            if (first.etag) {
                conditional = await request({
                    baseUrl, host, path: endpoint.path, cookie, timeoutMs, agent,
                    headers: { 'if-none-match': first.etag }
                })
            }

            const distinct = [...new Set(warm.map(result => result.bytes))].sort((a, b) => a - b)
            results.push({
                endpoint: endpoint.key,
                path: endpoint.path,
                first: { status: first.status, ms: first.ms, bytes: first.bytes, etag: first.etag, cacheControl: first.cacheControl, error: first.error || null },
                warm: { ...stats, ok, notOk: warm.length - ok, statuses: statusSummary(warm), bytes: distinct.length === 1 ? distinct[0] : distinct, medianBytes: distinct[Math.floor(distinct.length / 2)] ?? null },
                conditional: conditional ? { status: conditional.status, ms: conditional.ms, bytes: conditional.bytes } : null
            })
        }

        // Host routing in one cheap pass: unknown and admin hosts must 404, and
        // the configured host must not.
        const hostChecks = []
        for (const [label, checkHost] of [['unknown', 'unknown.invalid'], ['admin', `admin.${host}`], ['configured', host]]) {
            const result = await request({ baseUrl, host: checkHost, path: '/sitemap.xml', cookie, timeoutMs, agent })
            hostChecks.push({ label, host: checkHost, status: result.status, ms: result.ms })
        }

        printFeedResults(results, hostChecks, log, table)
        return { results, hostChecks }
    } finally {
        agent.destroy()
    }
}

export function printFeedResults(results, hostChecks, log = console.log, table = console.table) {
    const rows = results.map(entry => ({
        endpoint: entry.endpoint,
        first: fmtMs(entry.first.ms),
        p50: fmtMs(entry.warm.p50),
        p95: fmtMs(entry.warm.p95),
        p99: fmtMs(entry.warm.p99),
        max: fmtMs(entry.warm.max),
        ok: `${entry.warm.ok}/${entry.warm.ok + entry.warm.notOk}`,
        bytes: fmtBytes(entry.warm.medianBytes),
        'first status': entry.first.status,
        '304': entry.conditional ? `${entry.conditional.status} (${fmtMs(entry.conditional.ms)})` : '—'
    }))
    table(rows)

    for (const entry of results) {
        if (entry.first.status === 200) continue
        log(`  ${entry.endpoint}: first request failed — ${entry.first.error || `HTTP ${entry.first.status}`}`)
    }
    if (results.some(entry => entry.warm.notOk)) {
        const failed = results.filter(entry => entry.warm.notOk)
        log(`  warm failures: ${failed.map(entry => `${entry.endpoint} ${JSON.stringify(entry.warm.statuses)}`).join(', ')}`)
    }

    log('host routing (GET /sitemap.xml):')
    for (const check of hostChecks)
        log(`  ${check.label.padEnd(10)} Host: ${String(check.host).padEnd(22)} → ${check.status} (${fmtMs(check.ms)})`)

    const cold = results.filter(entry => entry.first.ms >= 250)
    if (cold.length)
        log(`cold/first hit(s): ${cold.map(entry => `${entry.endpoint} ${fmtMs(entry.first.ms)}`).join(', ')} — this is the generation cost, only the first request of a fresh catalog pays it`)
}
