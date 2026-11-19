import { randomBytes } from 'node:crypto'
import { getFirstSale } from '#common/functions/salePrice.js'
import {
    cleanText,
    encodePath,
    renderGoogleFeed,
    renderGoogleFeedItem,
    renderSitemapIndex,
    renderSitemapUrl,
    renderUrlset
} from './render.js'
import { readFeedSignatureDetails } from './signature.js'

// Sitemap protocol allows 50 000 URLs / 50 MB uncompressed per file. 20 000
// leaves headroom for long Hebrew slugs and keeps each Redis value modest.
export const SITEMAP_CHUNK_SIZE = (() => {
    const value = Number(process.env.FEED_SITEMAP_CHUNK_SIZE)
    return Number.isFinite(value) && value > 0 ? Math.min(value, 50_000) : 20_000
})()

// Mongo's default cursor batch. Small enough to keep memory flat, large enough
// that a 40k-product catalog is ~40 `getMore`s rather than 40 000 round trips.
export const PRODUCT_BATCH_SIZE = (() => {
    const value = Number(process.env.FEED_PRODUCT_BATCH_SIZE)
    return Number.isFinite(value) && value > 0 ? value : 1_000
})()

const STATIC_PAGES = ['/', '/products', '/sales', '/terms', '/privacy']

export function productSelect(domainId) {
    return {
        _id: 0,
        id: 1,
        updatedAt: 1,
        name: 1,
        description: 1,
        barcode: 1,
        // Only this domain's price row — not every domain's prices.
        prices: { $elemMatch: { domainId } },
        'images.product': 1,
        saleIds: 1,
        googleCategory: 1,
        'category.title': 1,
        'category.pathIds': 1,
        producer: 1,
        'unit.type': 1,
        'unit.baseUnit': 1,
        netContentText: 1
    }
}

export function productCursor(DL, domainId, { batchSize = PRODUCT_BATCH_SIZE } = {}) {
    const status = DL.Product.constants?.STATUS?.ACTIVE || 'active'
    return DL.Product.Model.find(
        { status, 'prices.domainId': domainId },
        productSelect(domainId)
    )
        .sort({ id: 1 })
        .batchSize(batchSize)
        .lean()
        .cursor()
}

export function domainPrice(product, domainId) {
    const entry = (product?.prices || []).find(price => price?.domainId === domainId)
    return entry?.price
}

export function makeGenerationId(now = new Date()) {
    const stamp = new Date(now).toISOString().replace(/[-:.TZ]/g, '')
    return `${stamp}-${randomBytes(4).toString('hex')}`
}

const isoDate = value => {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

async function readActiveSales(DL) {
    const status = DL.Sale.constants?.STATUS?.ACTIVE || 'active'
    const sales = await DL.Sale.read(
        { status },
        { _id: 0, id: 1, kind: 1, price: 1, percent: 1, amount: 1, start: 1, end: 1 },
        { limit: 0 }
    )
    const byId = {}
    for (const sale of sales || []) {
        if (sale?.id) byId[sale.id] = sale
    }
    return byId
}

/**
 * One product scan produces both artifacts:
 *   - /sitemap.xml, /sitemap-pages.xml, /sitemap-products-<n>.xml
 *   - /google-feed.xml
 *
 * `writeFile(name, xml)` is called as each file is ready, so the caller can put
 * it in Redis while the scan continues. Returns the meta to publish; nothing is
 * visible to readers until the caller swaps the meta pointer.
 */
export async function generateFeeds({
    DL,
    domain,
    gen = makeGenerationId(),
    now = new Date(),
    writeFile,
    chunkSize = SITEMAP_CHUNK_SIZE,
    batchSize = PRODUCT_BATCH_SIZE
}) {
    if (!domain?.domainId) throw new Error('generateFeeds: domainId required')
    if (typeof writeFile !== 'function') throw new Error('generateFeeds: writeFile required')

    const domainId = domain.domainId
    const origin = domain.origin || `https://${domain.url}`
    // The signature pass already reads the visible carousels, so reuse them
    // instead of querying DisplayBlock a second time.
    const { signature, carousels } = await readFeedSignatureDetails(DL, domainId, { now })
    const sales = await readActiveSales(DL)

    const categoryIds = new Set()
    const feedItems = []
    let chunk = []
    let chunks = 0
    let products = 0

    const flushChunk = async () => {
        chunks += 1
        await writeFile(`sitemap-products-${chunks}`, renderUrlset(chunk))
        chunk = []
    }

    for await (const product of productCursor(DL, domainId, { batchSize })) {
        const id = String(product?.id || '')
        if (!id) continue
        products += 1

        for (const categoryId of product.category?.pathIds || []) {
            if (categoryId) categoryIds.add(String(categoryId))
        }

        chunk.push(renderSitemapUrl({
            loc: `${origin}/product/${encodeURIComponent(id)}`,
            lastmod: isoDate(product.updatedAt)
        }))

        const item = renderGoogleFeedItem({
            product,
            price: domainPrice(product, domainId),
            sale: getFirstSale(product, sales),
            origin,
            now
        })
        if (item) feedItems.push(item)

        if (chunk.length >= chunkSize) await flushChunk()
    }
    if (chunk.length) await flushChunk()

    // An empty $in is stripped by the DL filter sanitizer and would turn this
    // into "every active category", so skip the read entirely when there are
    // no products.
    const categories = categoryIds.size
        ? await DL.Category.read(
            { id: { $in: [...categoryIds] }, active: true },
            { _id: 0, id: 1, path: 1 },
            { limit: 0, sort: { path: 1 } }
        )
        : []

    const pageUrls = [
        ...STATIC_PAGES.map(page => `${origin}${page}`),
        ...(categories || [])
            .map(category => category?.path ? `${origin}/products/${encodePath(category.path)}` : null)
            .filter(Boolean),
        ...(carousels || [])
            .map(block => block?.id ? `${origin}/carousel/${encodeURIComponent(block.id)}` : null)
            .filter(Boolean)
    ]
    await writeFile('sitemap-pages', renderUrlset(pageUrls.map(loc => renderSitemapUrl({ loc }))))

    const generatedAt = new Date(now).toISOString()
    const indexEntries = [
        { loc: `${origin}/sitemap-pages.xml`, lastmod: generatedAt },
        ...Array.from({ length: chunks }, (_, index) => ({
            loc: `${origin}/sitemap-products-${index + 1}.xml`,
            lastmod: generatedAt
        }))
    ]
    await writeFile('sitemap-index', renderSitemapIndex(indexEntries))

    const title = cleanText(domain.name) || 'Shopik'
    await writeFile('google-feed', renderGoogleFeed({
        title,
        link: `${origin}/`,
        description: `${title} — קטלוג מוצרים`,
        items: feedItems
    }))

    return {
        gen,
        signature,
        chunks,
        products,
        items: feedItems.length,
        generatedAt
    }
}
