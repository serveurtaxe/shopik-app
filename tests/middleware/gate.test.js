import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import cookieParser from 'cookie-parser'
import createGate, {
    GATE_COOKIE,
    GATE_LOGIN_PATH,
    GATE_LOGOUT_PATH,
    createGateToken,
    parseGateLinks
} from '../../server/middleware/gate.js'
import setupNoindex, { NOINDEX_VALUE } from '../../server/middleware/noindex.js'

const PASSWORD = 'let-me-in'
const SECRET = 'test-secret'

async function withApp(build, run) {
    const app = express()
    build(app)
    app.use((req, res) => res.json({ ok: true, path: req.path }))
    const server = app.listen(0)
    await new Promise(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
        await run(base)
    } finally {
        await new Promise(resolve => server.close(resolve))
    }
}

const withGate = (options, run) => withApp(app => {
    app.use(cookieParser())
    app.use(createGate({ password: PASSWORD, secret: SECRET, ...options }))
}, run)

function login(base, { password = PASSWORD, next } = {}) {
    const body = new URLSearchParams({ password })
    if (next) body.set('next', next)
    return fetch(`${base}${GATE_LOGIN_PATH}`, { method: 'POST', body, redirect: 'manual' })
}

const cookieOf = res => res.headers.getSetCookie()[0].split(';')[0]

describe('access gate', () => {
    it('is a pass-through when no password is configured', async () => {
        await withGate({ password: '' }, async base => {
            const res = await fetch(`${base}/`)
            assert.equal(res.status, 200)
            assert.equal(res.headers.get('x-robots-tag'), null)
        })
    })

    it('returns 401 with the login form for anonymous page requests', async () => {
        await withGate({}, async base => {
            const res = await fetch(`${base}/product/abc?ref=1`)
            assert.equal(res.status, 401)
            assert.match(res.headers.get('x-robots-tag') || '', /noindex/)

            const html = await res.text()
            assert.match(html, /name="password"/)
            assert.match(html, /name="robots" content="noindex/)
            assert.match(html, /value="\/product\/abc\?ref=1"/)
        })
    })

    it('returns JSON 401 for anonymous API requests', async () => {
        await withGate({}, async base => {
            const res = await fetch(`${base}/api/product/get`)
            assert.equal(res.status, 401)
            assert.deepEqual(await res.json(), { error: 'unauthorized' })
        })
    })

    it('lets the provider payment callback through without a cookie', async () => {
        // Hyp redirects the payment iframe from its own domain back to the
        // callback; a cross-site iframe never carries the SameSite=Lax gate
        // cookie, so gating it would 401 the callback and leave orders in cart.
        await withGate({}, async base => {
            const res = await fetch(`${base}/api/payment/hyp/callback?Order=10000066&Id=512933518&CCode=0`)
            assert.equal(res.status, 200)
            assert.deepEqual(await res.json(), { ok: true, path: '/api/payment/hyp/callback' })

            const trailing = await fetch(`${base}/api/payment/hyp/callback/?Order=1`)
            assert.equal(trailing.status, 200)

            // sibling payment routes stay gated
            const create = await fetch(`${base}/api/payment/create`, { method: 'post' })
            assert.equal(create.status, 401)
        })
    })

    it('rejects a wrong password without setting a cookie', async () => {
        await withGate({}, async base => {
            const res = await login(base, { password: 'nope' })
            assert.equal(res.status, 401)
            assert.equal(res.headers.getSetCookie().length, 0)
            assert.match(await res.text(), /סיסמה שגויה/)
        })
    })

    it('issues a cookie and lets the request through', async () => {
        await withGate({}, async base => {
            const res = await login(base)
            assert.equal(res.status, 303)

            const cookies = res.headers.getSetCookie()
            assert.equal(cookies.length, 1)
            assert.ok(cookies[0].startsWith(`${GATE_COOKIE}=`))
            assert.match(cookies[0], /HttpOnly/i)
            assert.match(cookies[0], /SameSite=Lax/i)

            const page = await fetch(`${base}/`, { headers: { cookie: cookieOf(res) } })
            assert.equal(page.status, 200)
            assert.deepEqual(await page.json(), { ok: true, path: '/' })
        })
    })

    it('redirects back to the requested local path', async () => {
        await withGate({}, async base => {
            const res = await login(base, { next: '/product/abc?ref=1' })
            assert.equal(res.status, 303)
            assert.equal(res.headers.get('location'), '/product/abc?ref=1')
        })
    })

    it('drops external and protocol-relative next targets', async () => {
        await withGate({}, async base => {
            const absolute = await login(base, { next: 'https://evil.example/x' })
            assert.equal(absolute.headers.get('location'), '/')

            const relative = await login(base, { next: '//evil.example/x' })
            assert.equal(relative.headers.get('location'), '/')

            const backslash = await login(base, { next: '/\\evil.example/x' })
            assert.equal(backslash.headers.get('location'), '/')
        })
    })

    it('rejects a cookie signed with another password', async () => {
        await withGate({}, async base => {
            const forged = createGateToken({ password: 'other', secret: SECRET })
            const res = await fetch(`${base}/`, { headers: { cookie: `${GATE_COOKIE}=${forged}` } })
            assert.equal(res.status, 401)
        })
    })

    it('rejects an expired cookie', async () => {
        await withGate({}, async base => {
            const expired = createGateToken({ password: PASSWORD, secret: SECRET, ttlMs: -1000 })
            const res = await fetch(`${base}/`, { headers: { cookie: `${GATE_COOKIE}=${expired}` } })
            assert.equal(res.status, 401)
        })
    })

    it('rejects a cookie with a tampered expiry', async () => {
        await withGate({}, async base => {
            const [exp, signature] = createGateToken({ password: PASSWORD, secret: SECRET }).split('.')
            const tampered = `${Number(exp) + 1_000_000}.${signature}`
            const res = await fetch(`${base}/`, { headers: { cookie: `${GATE_COOKIE}=${tampered}` } })
            assert.equal(res.status, 401)
        })
    })

    it('clears the cookie on logout', async () => {
        await withGate({}, async base => {
            const res = await fetch(`${base}${GATE_LOGOUT_PATH}`, { redirect: 'manual' })
            assert.equal(res.status, 303)
            assert.equal(res.headers.get('location'), GATE_LOGIN_PATH)
            assert.match(res.headers.getSetCookie()[0], new RegExp(`${GATE_COOKIE}=;`))
        })
    })

    it('rate-limits repeated login attempts', async () => {
        await withGate({}, async base => {
            let last
            for (let attempt = 0; attempt < 11; attempt++) last = await login(base, { password: 'nope' })
            assert.equal(last.status, 429)
        })
    })

    it('renders the configured links on the gate page', async () => {
        await withGate({ links: 'store|https://shefa.click,admin|https://admin.shefa.click' }, async base => {
            const html = await (await fetch(`${base}/`)).text()
            assert.match(html, /<a href="https:\/\/shefa\.click" rel="noopener">store<\/a>/)
            assert.match(html, /<a href="https:\/\/admin\.shefa\.click" rel="noopener">admin<\/a>/)
        })
    })
})

describe('parseGateLinks', () => {
    it('keeps label|url pairs and drops anything that is not http(s)', () => {
        assert.deepEqual(
            parseGateLinks('store|https://shefa.click, admin | https://admin.shefa.click,javascript:alert(1)'),
            [
                { label: 'store', url: 'https://shefa.click' },
                { label: 'admin', url: 'https://admin.shefa.click' }
            ]
        )
        assert.deepEqual(parseGateLinks(''), [])
        assert.deepEqual(parseGateLinks(undefined), [])
    })
})

describe('noindex header', () => {
    it('is added to every response when enabled', async () => {
        await withApp(app => setupNoindex(app, { enabled: '1' }), async base => {
            const res = await fetch(`${base}/anything`)
            assert.equal(res.headers.get('x-robots-tag'), NOINDEX_VALUE)
        })
    })

    it('is absent when disabled', async () => {
        await withApp(app => setupNoindex(app, { enabled: '' }), async base => {
            const res = await fetch(`${base}/anything`)
            assert.equal(res.headers.get('x-robots-tag'), null)
        })
    })
})
