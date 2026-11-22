import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateFeeds } from '../../server/services/feed/build.js'

const DOMAIN = {
    domainId: 'd1',
    name: 'חנות לדוגמה',
    url: 'shop.example.com',
    origin: 'https://shop.example.com'
}

function makeProduct(id, overrides = {}) {
    return {
        id,
        name: `מוצר ${id}`,
        description: `<p>תיאור ${id}</p>`,
        barcode: `72900000000${id}`,
        prices: [{ domainId: 'd1', price: 10 }],
        images: { product: [{ main: true, hash: `h${id}`, sizes: { xl: 'x' } }] },
        saleIds: [],
        googleCategory: 'Food, Beverages & Tobacco',
        category: { title: 'חלב', pathIds: ['c1'] },
        producer: 'מותג',
        unit: { type: 'item', baseUnit: 'unit' },
        netContentText: '500 מ"ל',
        updatedAt: '2026-01-02T03:04:05.000Z',
        ...overrides
    }
}

function cursorOf(products) {
    return {
        sort() { return this },
        batchSize() { return this },
        lean() { return this },
        cursor() {
            return (async function* () {
                for (const product of products) yield product
            })()
        }
    }
}

describe('generateFeeds', () => {
    it('builds sitemap chunks and the Google feed from one product scan', async () => {
        const products = [
            makeProduct('1'),
            makeProduct('2', { images: { product: [] } }),
            makeProduct('3', { prices: [{ domainId: 'd1', price: 0 }] }),
            makeProduct('4', { saleIds: ['s1'] }),
            makeProduct('5', { category: { title: 'גבינות', pathIds: ['c1', 'c2'] } })
        ]
        const sales = [{
            id: 's1', kind: 'percent', percent: 10, amount: 1,
            start: '2026-01-01T00:00:00.000Z', end: '2099-01-01T00:00:00.000Z'
        }]
        const categories = [
            { id: 'c1', path: 'מוצרי חלב' },
            { id: 'c2', path: 'מוצרי חלב/גבינות' }
        ]
        const blocks = [
            { id: 'live', schedule: {} },
            { id: 'expired', schedule: { end: '2020-01-01T00:00:00.000Z' } }
        ]

        let productFindCalls = 0
        let saleReadCalls = 0
        let categoryReads = 0
        let categoryFilter = null
        let blockFindCalls = 0

        const DL = {
            Product: {
                constants: { STATUS: { ACTIVE: 'active' } },
                Model: {
                    find() {
                        productFindCalls += 1
                        return cursorOf(products)
                    },
                    countDocuments: async () => products.length,
                    findOne: () => ({ sort: () => ({ lean: async () => ({ updatedAt: products.at(-1).updatedAt }) }) })
                }
            },
            Sale: {
                constants: { STATUS: { ACTIVE: 'active' } },
                Model: {
                    countDocuments: async () => sales.length,
                    findOne: () => ({ sort: () => ({ lean: async () => ({ updatedAt: '2026-01-01T00:00:00.000Z' }) }) })
                },
                async read() {
                    saleReadCalls += 1
                    return sales
                }
            },
            Category: {
                async read(filter) {
                    // The signature reads all active categories (from the Redis
                    // hashset in production); the pages pass reads a subset.
                    if (!filter.id?.$in) {
                        return categories.map(category => ({ id: category.id, updatedAt: category.updatedAt }))
                    }
                    categoryReads += 1
                    categoryFilter = filter
                    return categories.filter(category => filter.id.$in.includes(category.id))
                }
            },
            DisplayBlock: {
                constants: { KIND: { PRODUCT_CAROUSEL: 'product_carousel' } },
                Model: {
                    find() {
                        blockFindCalls += 1
                        return { lean: async () => blocks }
                    },
                    countDocuments: async () => blocks.length,
                    findOne: () => ({ sort: () => ({ lean: async () => ({ updatedAt: '2026-01-01T00:00:00.000Z' }) }) })
                }
            }
        }

        const files = {}
        const meta = await generateFeeds({
            DL,
            domain: DOMAIN,
            gen: 'g1',
            now: new Date('2026-06-01T00:00:00.000Z'),
            chunkSize: 2,
            writeFile: async (name, xml) => { files[name] = xml }
        })

        assert.equal(meta.gen, 'g1')
        assert.equal(meta.chunks, 3)
        assert.equal(meta.products, 5)
        assert.equal(meta.items, 3)
        assert.equal(productFindCalls, 1, 'one product scan feeds both artifacts')
        assert.equal(saleReadCalls, 1)
        assert.equal(categoryReads, 1)
        assert.equal(blockFindCalls, 1)

        assert.deepEqual(Object.keys(files).sort(), [
            'google-feed',
            'sitemap-index',
            'sitemap-pages',
            'sitemap-products-1',
            'sitemap-products-2',
            'sitemap-products-3'
        ])

        const chunkIds = [1, 2, 3].flatMap(number => {
            const xml = files[`sitemap-products-${number}`]
            return [...xml.matchAll(/\/product\/(\d+)<\/loc>/g)].map(match => match[1])
        })
        assert.deepEqual(chunkIds, ['1', '2', '3', '4', '5'])

        assert.match(files['sitemap-pages'], /<loc>https:\/\/shop\.example\.com\/<\/loc>/)
        assert.match(files['sitemap-pages'], /<loc>https:\/\/shop\.example\.com\/products<\/loc>/)
        assert.match(files['sitemap-pages'], /<loc>https:\/\/shop\.example\.com\/products\/%D7%9E%D7%95%D7%A6%D7%A8%D7%99%20%D7%97%D7%9C%D7%91<\/loc>/)
        assert.match(files['sitemap-pages'], /<loc>https:\/\/shop\.example\.com\/products\/%D7%9E%D7%95%D7%A6%D7%A8%D7%99%20%D7%97%D7%9C%D7%91\/%D7%92%D7%91%D7%99%D7%A0%D7%95%D7%AA<\/loc>/)
        assert.match(files['sitemap-pages'], /<loc>https:\/\/shop\.example\.com\/carousel\/live<\/loc>/)
        assert.doesNotMatch(files['sitemap-pages'], /carousel\/expired/)

        assert.match(files['sitemap-index'], /sitemap-pages\.xml/)
        for (const number of [1, 2, 3]) {
            assert.match(files['sitemap-index'], new RegExp(`sitemap-products-${number}\\.xml`))
        }

        assert.equal((files['google-feed'].match(/<item>/g) || []).length, 3)
        assert.match(files['google-feed'], /<g:title>מוצר 4<\/g:title>/)
        assert.match(files['google-feed'], /<g:sale_price>9\.00 ILS<\/g:sale_price>/)
        assert.doesNotMatch(files['google-feed'], /מוצר 2/)
        assert.doesNotMatch(files['google-feed'], /מוצר 3/)

        assert.deepEqual(categoryFilter.id.$in.sort(), ['c1', 'c2'])
        assert.equal(categoryFilter.active, true)
    })

    it('writes an empty index and feed for a domain with no products', async () => {
        const DL = {
            Product: {
                constants: { STATUS: { ACTIVE: 'active' } },
                Model: {
                    find: () => cursorOf([]),
                    countDocuments: async () => 0,
                    findOne: () => ({ sort: () => ({ lean: async () => null }) })
                }
            },
            Sale: {
                constants: { STATUS: { ACTIVE: 'active' } },
                Model: {
                    countDocuments: async () => 0,
                    findOne: () => ({ sort: () => ({ lean: async () => null }) })
                },
                read: async () => []
            },
            Category: {
                async read(filter) {
                    // The signature always reads the (empty) active category set;
                    // the pages pass must be skipped when the catalog is empty.
                    if (filter.id?.$in) {
                        throw new Error('category read must be skipped when there are no products')
                    }
                    return []
                }
            },
            DisplayBlock: {
                constants: { KIND: { PRODUCT_CAROUSEL: 'product_carousel' } },
                Model: {
                    find: () => ({ lean: async () => [] }),
                    countDocuments: async () => 0,
                    findOne: () => ({ sort: () => ({ lean: async () => null }) })
                }
            }
        }

        const files = {}
        const meta = await generateFeeds({
            DL,
            domain: DOMAIN,
            gen: 'g0',
            writeFile: async (name, xml) => { files[name] = xml }
        })

        assert.equal(meta.chunks, 0)
        assert.equal(meta.products, 0)
        assert.equal(meta.items, 0)
        assert.match(files['sitemap-index'], /sitemap-pages\.xml/)
        assert.doesNotMatch(files['sitemap-index'], /sitemap-products/)
        assert.match(files['google-feed'], /<channel>/)
        assert.doesNotMatch(files['google-feed'], /<item>/)
    })
})
