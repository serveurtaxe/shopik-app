import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { runFeedBenchmark, FEED_ENDPOINTS } from '../../scripts/stress/feed.js'

const HOST = 'shopik.co.il'
const BODIES = {
    '/sitemap.xml': '<?xml version="1.0"?><sitemapindex/>',
    '/sitemap-pages.xml': '<?xml version="1.0"?><urlset/>',
    '/sitemap-products-1.xml': `<urlset>${'<url><loc>https://x/p/1</loc></url>'.repeat(20)}</urlset>`,
    '/google-feed.xml': `<rss>${'<item><g:id>1</g:id></item>'.repeat(500)}</rss>`
}

async function withStub(run) {
    const server = http.createServer((req, res) => {
        if (req.headers.host !== HOST) {
            res.writeHead(404)
            return res.end('unknown host')
        }
        const body = BODIES[req.url]
        if (!body) {
            res.writeHead(404)
            return res.end()
        }
        if (req.headers['if-none-match'] === '"v1"') {
            res.writeHead(304, { ETag: '"v1"' })
            return res.end()
        }
        res.writeHead(200, {
            'content-type': 'application/xml',
            'cache-control': 'public, max-age=3600',
            ETag: '"v1"',
            'content-length': Buffer.byteLength(body)
        })
        res.end(body)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
        await run(`http://127.0.0.1:${server.address().port}`)
    } finally {
        await new Promise(resolve => server.close(resolve))
    }
}

const quiet = { log: () => { }, table: () => { } }

describe('feed stress benchmark', () => {
    it('measures every feed endpoint, the 304 path and host routing', async () => {
        await withStub(async baseUrl => {
            const { results, hostChecks } = await runFeedBenchmark({
                baseUrl, host: HOST, calls: 2, concurrency: 2, ...quiet
            })

            assert.equal(results.length, FEED_ENDPOINTS.length)
            for (const entry of results) {
                assert.equal(entry.first.status, 200, `${entry.endpoint} first hit`)
                assert.equal(entry.warm.ok, 2, `${entry.endpoint} warm calls`)
                assert.equal(entry.warm.notOk, 0)
                assert.equal(entry.conditional.status, 304, `${entry.endpoint} revalidates`)
                assert.ok(entry.warm.medianBytes > 0)
            }

            assert.deepEqual(
                hostChecks.map(check => [check.label, check.status]),
                [['unknown', 404], ['admin', 404], ['configured', 200]]
            )
        })
    })

    it('filters endpoints with --only', async () => {
        await withStub(async baseUrl => {
            const { results } = await runFeedBenchmark({
                baseUrl, host: HOST, calls: 1, concurrency: 1, only: 'google', ...quiet
            })
            assert.deepEqual(results.map(entry => entry.endpoint), ['google-feed'])
        })
    })

    it('reports a missing endpoint as a failed first request', async () => {
        const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        try {
            const { results } = await runFeedBenchmark({
                baseUrl: `http://127.0.0.1:${server.address().port}`,
                host: HOST, calls: 1, concurrency: 1, only: 'sitemap-index', ...quiet
            })
            assert.equal(results[0].first.status, 404)
            assert.equal(results[0].conditional, null)
            // The host-routing probe already sees 404s, so it stays cheap.
            assert.equal(results[0].warm.ok, 0)
        } finally {
            await new Promise(resolve => server.close(resolve))
        }
    })
})
