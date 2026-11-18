// HTTP client for the running server: one session per instance (admin or
// storefront platform header + its own cookie jar), and the router's envelope
// shape ({ requestId, data, status }) — errors arrive with HTTP 200 + a body
// status, so classification must read the body.

export class StressClient {
    constructor({ baseUrl, origin, platform = 'admin' }) {
        this.baseUrl = baseUrl.replace(/\/$/, '')
        this.origin = origin
        // getPlatform() trusts an explicit header, and both session helpers
        // reject a token whose tokens[platform] doesn't match the platform of
        // the call — so every client states its platform once, up front.
        this.platform = platform
        this.cookies = new Map()
    }

    cookieHeader() {
        return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    }

    absorbCookies(response) {
        const setCookies = typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : [response.headers.get('set-cookie')].filter(Boolean)
        for (const raw of setCookies) {
            const [pair] = String(raw).split(';')
            const eq = pair.indexOf('=')
            if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
        }
    }

    async call(routePath, payload = {}, { timeoutMs = 30_000, extraHeaders = {}, rawUrl = null, keepBody = false } = {}) {
        const url = rawUrl || `${this.baseUrl}/api/${routePath}`
        const start = Date.now()
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    platform: this.platform,
                    origin: this.origin,
                    cookie: this.cookieHeader(),
                    ...extraHeaders
                },
                body: typeof payload === 'string' ? payload : JSON.stringify(payload),
                signal: AbortSignal.timeout(timeoutMs)
            })
            this.absorbCookies(response)
            const ms = Date.now() - start
            let body = null
            const text = await response.text()
            try { body = JSON.parse(text) } catch { body = null }
            const status = body?.status ?? response.status
            const kind = classify(response, status, body)
            return {
                ok: response.ok && status === 200,
                status,
                kind,
                ms,
                bytes: text.length,
                items: dataItems(body),
                // The parsed body is NOT returned (keepBody is for the login routes, which
                // need the token out of it): a burst holds every response it counted, and
                // routes like category/tree answer ~1MB each — retaining bodies OOMs a sweep.
                error: kind === 'ok' ? null : String(body?.message || body?.error || kind).slice(0, 200),
                body: keepBody ? body : null
            }
        } catch (err) {
            const kind = err.name === 'AbortError' ? 'timeout' : 'network'
            return { ok: false, status: 0, kind, ms: Date.now() - start, bytes: 0, items: null, error: kind, body: null }
        }
    }

    // The gate answers API requests with HTTP 401 { error: 'unauthorized' }.
    async gateLogin(password) {
        const response = await fetch(`${this.baseUrl}/__gate`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', origin: this.origin },
            body: new URLSearchParams({ password: String(password), next: '/' }).toString(),
            redirect: 'manual',
            signal: AbortSignal.timeout(10_000)
        })
        this.absorbCookies(response)
        return response.status === 303
    }
}

function classify(response, status, body) {
    if (response.status === 401 && body?.error === 'unauthorized') return 'gate'
    if (status >= 200 && status < 300) return 'ok'
    if (status === 400) return 'bad-payload'
    if (status === 401 || status === 403) return 'auth'
    if (status === 429) return 'rate-limited'
    if (status >= 500) return 'server-error'
    return 'other'
}

// How much a call actually handed back. The envelope is { requestId, data, status },
// so data is the payload: [] → 0, {} → 0 keys, a scalar/true → 1. null when the
// body is not the envelope at all (a streamed file), which the report shows as '—'
// rather than as an empty answer.
function dataItems(body) {
    const data = body?.data
    if (data == null) return null
    if (Array.isArray(data)) return data.length
    if (typeof data === 'object') return Object.keys(data).length
    return 1
}
