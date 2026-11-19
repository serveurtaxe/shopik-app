import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { clearFeedMemoryCache, getFeedFile } from '../../server/services/feed/cache.js'
import { clearFeedSignatureCache } from '../../server/services/feed/signature.js'

const DOMAIN = {
    domainId: 'd1',
    name: 'חנות לדוגמה',
    url: 'shop.example.com',
    origin: 'https://shop.example.com'
}

const PRODUCTS = [{
    id: '1',
    name: 'מוצר 1',
    description: 'תיאור',
    barcode: '7290000000001',
    prices: [{ domainId: 'd1', price: 10 }],
    images: { product: [{ main: true, hash: 'h1', sizes: { xl: 'x' } }] },
    saleIds: [],
    category: { title: 'חלב', pathIds: ['c1'] },
    producer: 'מותג',
    unit: { type: 'item', baseUnit: 'unit' },
    netContentText: '500 מ"ל',
    updatedAt: '2026-01-02T03:04:05.000Z'
}]

function fakeRedis() {
    const data = new Map()
    return {
        status: 'ready',
        data,
        async get(key) {
            return data.has(key) ? data.get(key) : null
        },
        async set(key, value) {
            data.set(key, value)
            return 'OK'
        }
    }
}

function fakeDL(products = PRODUCTS) {
    const state = { productFindCalls: 0 }
    const model = (count, latest) => ({
        countDocuments: async () => count,
        findOne: () => ({ sort: () => ({ lean: async () => latest ? { updatedAt: latest } : null }) })
    })
    const cursorOf = docs => ({
        sort() { return this },
        batchSize() { return this },
        lean() { return this },
        cursor() {
            return (async function* () {
                for (const doc of docs) yield doc
            })()
        }
    })
    const DL = {
        redis: fakeRedis(),
        Product: {
            constants: { STATUS: { ACTIVE: 'active' } },
            Model: {
                find() {
                    state.productFindCalls += 1
                    return cursorOf(products)
                },
                ...model(products.length, products.at(-1)?.updatedAt)
            }
        },
        Sale: {
            constants: { STATUS: { ACTIVE: 'active' } },
            Model: model(0, null),
            read: async () => []
        },
        Category: {
            Model: model(1, '2026-01-01T00:00:00.000Z'),
            read: async () => [{ id: 'c1', path: 'dairy' }]
        },
        DisplayBlock: {
            constants: { KIND: { PRODUCT_CAROUSEL: 'product_carousel' } },
            Model: {
                find: () => ({ lean: async () => [] }),
                ...model(0, null)
            }
        }
    }
    return { DL, state }
}

const lockFn = async () => async () => { }

beforeEach(() => {
    clearFeedMemoryCache()
    clearFeedSignatureCache()
})

describe('feed cache', () => {
    it('builds once on a cold request and publishes meta after the files', async () => {
        const { DL, state } = fakeDL()
        const result = await getFeedFile({ DL, domain: DOMAIN, file: 'sitemap-index', lockFn })

        assert.match(result.xml, /<sitemapindex/)
        assert.match(result.xml, /sitemap-products-1\.xml/)
        assert.match(result.etag, /-sitemap-index"$/)
        assert.equal(state.productFindCalls, 1)

        const meta = JSON.parse(DL.redis.data.get('feed:meta:v1:d1'))
        assert.equal(meta.gen, result.etag.slice(1, -1).replace('-sitemap-index', ''))
        assert.equal(meta.chunks, 1)
        assert.equal(meta.products, 1)
    })

    it('serves the stored generation without scanning when the signature is unchanged', async () => {
        const { DL, state } = fakeDL()
        const first = await getFeedFile({ DL, domain: DOMAIN, file: 'google-feed', lockFn })
        clearFeedSignatureCache()
        const second = await getFeedFile({ DL, domain: DOMAIN, file: 'google-feed', lockFn })

        assert.equal(state.productFindCalls, 1, 'second request must not rescan the catalog')
        assert.equal(first.etag, second.etag)
        assert.equal(first.xml, second.xml)
    })

    it('answers an out-of-range chunk with an empty urlset instead of a 404', async () => {
        const { DL } = fakeDL()
        const result = await getFeedFile({ DL, domain: DOMAIN, file: 'sitemap-products-9', lockFn })

        assert.match(result.xml, /<urlset/)
        assert.doesNotMatch(result.xml, /<url>/)
        assert.match(result.etag, /-empty"$/)
    })

    it('falls back to the in-process store when Redis is down', async () => {
        const { DL } = fakeDL()
        DL.redis.status = 'down'

        const first = await getFeedFile({ DL, domain: DOMAIN, file: 'sitemap-pages', lockFn })
        assert.match(first.xml, /<urlset/)

        clearFeedSignatureCache()
        const second = await getFeedFile({ DL, domain: DOMAIN, file: 'sitemap-pages', lockFn })
        assert.equal(second.xml, first.xml)
    })
})
