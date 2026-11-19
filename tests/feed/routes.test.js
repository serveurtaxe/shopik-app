import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import registerFeedRoutes from '../../server/routes/feed.js'
import { resolveFeedDomain } from '../../server/services/feed/domain.js'

const DOMAIN = {
    domainId: 'd1',
    name: 'חנות לדוגמה',
    url: 'shop.example.com',
    origin: 'https://shop.example.com'
}

function get(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path, headers }, res => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', chunk => { body += chunk })
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
        })
        req.on('error', reject)
    })
}

async function withApp(options, run) {
    const app = express()
    registerFeedRoutes(app, { DL: {} }, options)
    const server = app.listen(0)
    await new Promise(resolve => server.once('listening', resolve))
    try {
        await run(server.address().port)
    } finally {
        await new Promise(resolve => server.close(resolve))
    }
}

const resolveKnownHost = async req => req.headers.host === 'shop.example.com' ? DOMAIN : null
const readStub = async ({ file }) => ({ xml: `<urlset><!-- ${file} --></urlset>`, etag: `"g1-${file}"` })

describe('feed routes', () => {
    it('serves XML with per-host caching headers', async () => {
        await withApp({ resolveDomain: resolveKnownHost, readFeedFile: readStub }, async port => {
            const res = await get(port, '/sitemap.xml', { host: 'shop.example.com' })
            assert.equal(res.status, 200)
            assert.match(res.headers['content-type'], /application\/xml/)
            assert.equal(res.headers.vary, 'Host')
            assert.equal(res.headers.etag, '"g1-sitemap-index"')
            assert.match(res.headers['cache-control'], /public/)
            assert.match(res.body, /<!-- sitemap-index -->/)
        })
    })

    it('returns 304 for a matching If-None-Match', async () => {
        await withApp({ resolveDomain: resolveKnownHost, readFeedFile: readStub }, async port => {
            const res = await get(port, '/google-feed.xml', {
                host: 'shop.example.com',
                'if-none-match': '"g1-google-feed"'
            })
            assert.equal(res.status, 304)
            assert.equal(res.body, '')
        })
    })

    it('maps the product chunk route to its cache key', async () => {
        let requested = null
        await withApp({
            resolveDomain: resolveKnownHost,
            readFeedFile: async ({ file }) => {
                requested = file
                return { xml: '<urlset/>', etag: `"g1-${file}"` }
            }
        }, async port => {
            const res = await get(port, '/sitemap-products-12.xml', { host: 'shop.example.com' })
            assert.equal(res.status, 200)
        })
        assert.equal(requested, 'sitemap-products-12')
    })

    it('404s an unknown host, an admin host and a non-numeric chunk', async () => {
        await withApp({ resolveDomain: resolveKnownHost, readFeedFile: readStub }, async port => {
            assert.equal((await get(port, '/sitemap.xml', { host: 'unknown.example.com' })).status, 404)
            assert.equal((await get(port, '/sitemap-products-abc.xml', { host: 'shop.example.com' })).status, 404)
            assert.equal((await get(port, '/sitemap-products-0.xml', { host: 'shop.example.com' })).status, 404)
        })
    })

    it('404s everything when NOINDEX is on', async () => {
        await withApp({ noindex: true, resolveDomain: resolveKnownHost, readFeedFile: readStub }, async port => {
            assert.equal((await get(port, '/sitemap.xml', { host: 'shop.example.com' })).status, 404)
            assert.equal((await get(port, '/google-feed.xml', { host: 'shop.example.com' })).status, 404)
        })
    })

    it('answers 503 when no generation can be produced', async () => {
        await withApp({ resolveDomain: resolveKnownHost, readFeedFile: async () => null }, async port => {
            const res = await get(port, '/sitemap.xml', { host: 'shop.example.com' })
            assert.equal(res.status, 503)
            assert.equal(res.headers['retry-after'], '300')
        })
    })
})

describe('resolveFeedDomain', () => {
    const DL = {
        Domain: {
            async readOne(filter) {
                return filter.url === 'shop.example.com' && filter.active
                    ? { id: 'd1', name: 'חנות לדוגמה', url: 'shop.example.com' }
                    : null
            }
        }
    }

    it('resolves a known storefront host and its www alias', async () => {
        assert.deepEqual(await resolveFeedDomain({ headers: { host: 'shop.example.com' } }, DL), DOMAIN)
        assert.deepEqual(await resolveFeedDomain({ headers: { host: 'www.shop.example.com' } }, DL), DOMAIN)
        assert.deepEqual(await resolveFeedDomain({ headers: { host: 'shop.example.com:443' } }, DL), DOMAIN)
    })

    it('refuses admin, localhost and unknown hosts (no default-domain fallback)', async () => {
        assert.equal(await resolveFeedDomain({ headers: { host: 'admin.shop.example.com' } }, DL), null)
        assert.equal(await resolveFeedDomain({ headers: { host: 'www.admin.shop.example.com' } }, DL), null)
        assert.equal(await resolveFeedDomain({ headers: { host: 'localhost' } }, DL), null)
        assert.equal(await resolveFeedDomain({ headers: { host: 'unknown.example.com' } }, DL), null)
    })
})
