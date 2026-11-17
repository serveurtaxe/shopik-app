// HTTP client for the running server: admin-platform headers, a tiny cookie jar,
// and the router's envelope shape ({ requestId, data, status }) — errors arrive
// with HTTP 200 + a body status, so classification must read the body.

export class StressClient {
    constructor({ baseUrl, origin }) {
        this.baseUrl = baseUrl.replace(/\/$/, '')
        this.origin = origin
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

    async call(routePath, payload = {}, { timeoutMs = 30_000, extraHeaders = {}, rawUrl = null } = {}) {
        const url = rawUrl || `${this.baseUrl}/api/${routePath}`
        const start = Date.now()
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    platform: 'admin',
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
            return { ok: response.ok && status === 200, status, kind: classify(response, status, body), ms, body }
        } catch (err) {
            return { ok: false, status: 0, kind: err.name === 'AbortError' ? 'timeout' : 'network', ms: Date.now() - start, body: null }
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
