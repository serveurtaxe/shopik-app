import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import bodyParsers from '../../server/middleware/bodyParsers.js'

let server
let base

before(async () => {
    const app = express()
    const [parseJson, parseUrlencoded] = bodyParsers()
    app.use(parseJson)
    app.use(parseUrlencoded)
    app.use((req, res) => res.json({ ok: true, size: req.body?.blob?.length || 0 }))
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.type || err.message }))
    server = app.listen(0)
    await new Promise(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${server.address().port}`
})

after(() => new Promise(resolve => server.close(resolve)))

const bigJson = () => JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) })

const postJson = path => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bigJson()
})

describe('per-route body limits', () => {
    it('rejects a 2MB JSON body on an ordinary route', async () => {
        const res = await postJson('/api/product/update')
        assert.equal(res.status, 413)
        assert.equal((await res.json()).error, 'entity.too.large')
    })

    it('accepts the same body on an upload route', async () => {
        const res = await postJson('/api/product/upload_image')
        assert.equal(res.status, 200)
        assert.equal((await res.json()).size, 2 * 1024 * 1024)
    })

    it('accepts it on the csv import routes, whose own cap is above 1MB', async () => {
        for (const path of ['/api/comax_product/backfill_catalog', '/api/product/load_kashrut']) {
            const res = await postJson(path)
            assert.equal(res.status, 200, path)
            assert.equal((await res.json()).size, 2 * 1024 * 1024, path)
        }
    })

    it('accepts it with a trailing slash too', async () => {
        const res = await postJson('/api/product/upload_image/')
        assert.equal(res.status, 200)
    })

    it('still parses normal bodies on ordinary routes', async () => {
        const res = await fetch(`${base}/api/product/update`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ blob: 'ok' })
        })
        assert.equal(res.status, 200)
        assert.equal((await res.json()).size, 2)
    })

    it('applies the same route split to urlencoded bodies', async () => {
        const headers = { 'content-type': 'application/x-www-form-urlencoded' }
        const body = 'blob=' + 'x'.repeat(2 * 1024 * 1024)
        const small = await fetch(`${base}/api/product/update`, { method: 'POST', headers, body })
        assert.equal(small.status, 413)
        const large = await fetch(`${base}/api/product/upload_image`, { method: 'POST', headers, body })
        assert.equal(large.status, 200)
    })
})
