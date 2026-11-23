import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import setupSecurity from '../../server/middleware/security.js'

let server
let base

before(async () => {
    const app = express()
    await setupSecurity(app, {})
    app.use((req, res) => res.end('ok'))
    server = app.listen(0)
    await new Promise(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${server.address().port}`
})

after(() => new Promise(resolve => server.close(resolve)))

describe('security headers', () => {
    // helmet's default is `no-referrer`, which also empties document.referrer and
    // keeps HTTP_REFERER off cross-origin requests. Vee's accessibility toolbar
    // answers such a request with "No referer" and never renders, so this header
    // is load-bearing for the widget — not a cosmetic preference.
    it('sends an origin-only referrer cross-origin', async () => {
        const res = await fetch(`${base}/`)
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')
    })

    it('keeps the other helmet protections in place', async () => {
        const res = await fetch(`${base}/`)
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
        assert.equal(res.headers.get('content-security-policy'), null)
    })
})
