import log from '#server/utils/log.js'
import { getFeedFile } from '#server/services/feed/cache.js'
import { resolveFeedDomain } from '#server/services/feed/domain.js'

// Served behind the access gate and after compression. Registered before
// ssr()/router(), because server/ssr.js rejects every path with an extension
// (path.extname !== '') before the SSR renderer sees it.

const PRODUCT_FILE = /^([1-9]\d*)\.xml$/

function isNotModified(req, etag) {
    const header = req.headers?.['if-none-match']
    if (!header) return false
    const values = String(header).split(',').map(value => value.trim())
    return values.includes('*') || values.includes(etag) || values.includes(`W/${etag}`)
}

function sendXml(req, res, { xml, etag }) {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    // The document differs per host; without this a shared proxy/CDN can leak
    // one store's sitemap to another store's domain. `append` keeps the
    // `Accept-Encoding` that compression already added.
    res.append('Vary', 'Host')
    res.setHeader('ETag', etag)
    if (isNotModified(req, etag)) return res.status(304).end()
    return res.send(xml)
}

function unavailable(res) {
    res.setHeader('Retry-After', '300')
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    return res.status(503).send('feed is being generated, retry shortly')
}

export default function registerFeedRoutes(app, bootData, {
    noindex = !!process.env.NOINDEX,
    resolveDomain = resolveFeedDomain,
    readFeedFile = getFeedFile
} = {}) {
    const { DL } = bootData

    const handler = file => async (req, res) => {
        // NOINDEX deployments must not expose a crawlable sitemap or feed.
        if (noindex) return res.status(404).end()

        try {
            const domain = await resolveDomain(req, DL)
            if (!domain) return res.status(404).end()

            const name = typeof file === 'function' ? file(req) : file
            if (!name) return res.status(404).end()

            const result = await readFeedFile({ DL, domain, file: name })
            if (!result) return unavailable(res)
            return sendXml(req, res, result)
        } catch (error) {
            log.error('[Feed] Route failed:', error?.message || error)
            if (!res.headersSent) return unavailable(res)
        }
    }

    app.get('/sitemap.xml', handler('sitemap-index'))
    app.get('/sitemap-pages.xml', handler('sitemap-pages'))
    app.get('/google-feed.xml', handler('google-feed'))
    app.get('/sitemap-products-:file', handler(req => {
        const match = PRODUCT_FILE.exec(String(req.params.file || ''))
        return match ? `sitemap-products-${match[1]}` : null
    }))
}
