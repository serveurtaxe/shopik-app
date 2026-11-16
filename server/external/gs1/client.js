import log from '#server/utils/log.js'

const ZIP_TIMEOUT_MS = 120000
const JSON_TIMEOUT_MS = 30000

function baseUrl() {
    const raw = process.env.GS1_BASEURL || process.env.GS1_BASE_URL || ''
    if (!raw) throw new Error('GS1_BASEURL env var is required')
    return raw.startsWith('http') ? raw.replace(/\/$/, '') : `https://${raw.replace(/\/$/, '')}`
}

function authHeader() {
    const user = process.env.GS1_USERNAME || ''
    const pass = process.env.GS1_PASSWORD || ''
    if (!user || !pass) throw new Error('GS1_USERNAME and GS1_PASSWORD env vars are required')
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

async function get(path, { timeoutMs = JSON_TIMEOUT_MS, binary = false, maxBytes = 0 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetch(`${baseUrl()}${path}`, {
            signal: controller.signal,
            headers: { Authorization: authHeader(), Accept: binary ? '*/*' : 'application/json' }
        })
        if (res.status === 404) return null
        if (res.status === 401) throw new Error('GS1 401 Unauthorized — check GS1_USERNAME/GS1_PASSWORD')
        // GS1 answers 400 (`pcode is cannot be null`) for a GTIN that is not in
        // OUR account's catalog — visibility is per customer and changes over
        // time. That is a lookup result, not a failure, so it is tagged instead
        // of thrown as a generic 4xx the worker would retry five times.
        if (res.status === 400)
            throw Object.assign(new Error(`GS1 400 not in our GS1 account: ${res.statusText}`), { notFound: true })
        if (res.status === 429) throw Object.assign(new Error('GS1 429 rate limited'), { rateLimited: true })
        if (res.status >= 500) throw Object.assign(new Error(`GS1 ${res.status} server error`), { transient: true })
        if (!res.ok) throw new Error(`GS1 HTTP ${res.status}: ${res.statusText}`)
        // Fail fast on declared monsters: a 200MB spin-set zip costs bandwidth
        // plus ~2x memory (arrayBuffer copy + Buffer) in a small box. The
        // caller parks over-cap barcodes as skipped instead of retrying.
        if (binary && maxBytes) {
            const declared = Number(res.headers.get('content-length') || 0)
            if (declared > maxBytes)
                throw new Error(`GS1 response too large: ${declared} bytes (content-length)`)
        }
        const buffer = Buffer.from(await res.arrayBuffer())
        if (maxBytes && buffer.length > maxBytes)
            throw new Error(`GS1 response too large: ${buffer.length} bytes`)
        return binary ? buffer : JSON.parse(buffer.toString('utf8'))
    } finally {
        clearTimeout(timer)
    }
}

// GET /external/messages_queue/get_by_date/from/{YYYY-MM-DD}/to/{YYYY-MM-DD}
// 404 = no messages in range → null
export async function getMessages(fromDate, toDate) {
    const data = await get(`/external/messages_queue/get_by_date/from/${fromDate}/to/${toDate}`)
    if (!data) return []
    return Array.isArray(data) ? data : [data]
}

// GET /external/product/{product_code}.json?hq=1 → [{product_info, media_assets, ...}]
export async function getProduct(productCode) {
    const data = await get(`/external/product/${encodeURIComponent(productCode)}.json?hq=1`)
    if (!data) return null
    const item = Array.isArray(data) ? data[0] : data
    return item || null
}

// GET /external/product/{GTIN}/files?media=all&hq=1 → zip buffer
export async function getMediaZip(gtin, { type } = {}) {
    const q = type ? `type=${encodeURIComponent(type)}&hq=1` : 'media=all&hq=1'
    const buffer = await get(`/external/product/${encodeURIComponent(gtin)}/files?${q}`, {
        timeoutMs: ZIP_TIMEOUT_MS,
        binary: true,
        maxBytes: Number(process.env.GS1_ZIP_MAX_BYTES || 50 * 1024 * 1024)
    })
    if (!buffer?.length) {
        log.warn(`[GS1] Empty media zip for GTIN ${gtin}`)
        return null
    }
    return buffer
}

export default function gs1Factory() {
    return { getMessages, getProduct, getMediaZip }
}
