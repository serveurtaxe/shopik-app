// Request-log policy: which requests get a log document, and how a response is
// summarized for it.
//
// The router used to write two documents per request (a pending insert before
// the handler, then an update with the response). On the 1-CPU/M20 profile that
// doubled the latency of even a trivial route, and large object responses wrote
// up to 54 KB of body per call. Now there is one insert, after the response, and
// successful reads are sampled — mutations, errors and slow requests are always
// kept.
//
// Outbound logs (sms, comax) do not go through here: they keep using
// DL.Log.start + success/error, so their request and provider response are
// still recorded in full.

import { isReadOnlyRoute } from './routeKind.js'

const OFF = /^(0|off|false|no)$/i

// Read lazily: server/router.js is imported before boot() loads .env, so a
// module-level constant would miss REQUEST_LOG / REQUEST_LOG_SAMPLE values that
// live in .env (production passes them as real environment variables).
export function requestLogEnabled() {
    return !OFF.test(String(process.env.REQUEST_LOG ?? '').trim())
}

function numberEnv(name, fallback) {
    const value = Number(process.env[name])
    return Number.isFinite(value) ? value : fallback
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

// Fraction of successful read requests that are logged. Mutations, errors and
// requests at/over REQUEST_LOG_SLOW_MS are never sampled out.
export function requestLogSampleRate() {
    return clamp(numberEnv('REQUEST_LOG_SAMPLE', 0.1), 0, 1)
}

export function requestLogSlowMs() {
    return Math.max(0, numberEnv('REQUEST_LOG_SLOW_MS', 500))
}

// Responses above this size are stored as { omitted, bytes, keys } instead of
// the body: the logs UI needs to know what was returned, not 54 KB of an admin
// CSV or tree.
export const MAX_LOGGED_RESPONSE_BYTES = 4 * 1024

const utf8Bytes = value => Buffer.byteLength(String(value), 'utf8')

export function summarizeLogValue(value, maxBytes = MAX_LOGGED_RESPONSE_BYTES) {
    if (value == null) return value
    if (Array.isArray(value)) return `[${value.length} elements]`
    if (typeof value === 'string') {
        const bytes = utf8Bytes(value)
        return bytes <= maxBytes ? value : { omitted: true, bytes }
    }
    if (typeof value !== 'object') return value

    let json
    try {
        json = JSON.stringify(value)
    } catch {
        return { omitted: true }
    }
    if (json == null) return value
    const bytes = utf8Bytes(json)
    if (bytes <= maxBytes) return value
    return { omitted: true, bytes, keys: Object.keys(value).slice(0, 20) }
}

// Pure decision so it can be tested without a request. Errors (>=400) and slow
// requests are always logged; mutations are always logged; only successful
// reads are sampled.
export function shouldLogRequest({
    route,
    httpStatus,
    durationMs,
    sampleRate = requestLogSampleRate(),
    slowMs = requestLogSlowMs(),
    random = Math.random
}) {
    if (Number(httpStatus) >= 400) return true
    if (Number(durationMs) >= slowMs) return true
    if (!isReadOnlyRoute(route)) return true
    return random() < sampleRate
}
