import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    cleanText,
    encodePath,
    escapeXml,
    renderGoogleFeedItem,
    renderSitemapIndex,
    renderUrlset,
    unitPricing
} from '../../server/services/feed/render.js'

function product(overrides = {}) {
    return {
        id: 'p1',
        name: 'חלב טרי 3%',
        description: '<p>חלב &amp; טרי <b>מיכל</b></p>',
        barcode: '7290000000001',
        prices: [{ domainId: 'd1', price: 12.9 }],
        images: {
            product: [
                { main: true, hash: 'mainhash', sizes: { xl: 'x' } },
                { main: false, hash: 'althash', sizes: { xl: 'x' } }
            ]
        },
        saleIds: [],
        googleCategory: 'Food, Beverages & Tobacco > Beverages',
        category: { title: 'מוצרי חלב', pathIds: ['c1'] },
        producer: 'טרה',
        unit: { type: 'item', baseUnit: 'unit' },
        netContentText: '750 מ"ל',
        updatedAt: '2026-01-02T03:04:05.000Z',
        ...overrides
    }
}

const ORIGIN = 'https://shop.example.com'

describe('feed XML rendering', () => {
    it('escapes every XML-significant character', () => {
        assert.equal(escapeXml(`a&b<c>"d"'e'`), 'a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;')
    })

    it('strips HTML and collapses whitespace for Merchant text fields', () => {
        assert.equal(cleanText('<p>חלב&nbsp;טרי &amp; <b>טוב</b></p>'), 'חלב טרי & טוב')
    })

    it('encodes category paths segment by segment', () => {
        assert.equal(encodePath('מוצרי חלב/חלב טרי'), '%D7%9E%D7%95%D7%A6%D7%A8%D7%99%20%D7%97%D7%9C%D7%91/%D7%97%D7%9C%D7%91%20%D7%98%D7%A8%D7%99')
    })

    it('renders a urlset and a sitemap index', () => {
        const urlset = renderUrlset([{ loc: `${ORIGIN}/product/1`, lastmod: '2026-01-01T00:00:00.000Z' }])
        assert.match(urlset, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/)
        assert.match(urlset, /<loc>https:\/\/shop\.example\.com\/product\/1<\/loc>/)
        assert.match(urlset, /<lastmod>2026-01-01T00:00:00\.000Z<\/lastmod>/)

        const index = renderSitemapIndex([{ loc: `${ORIGIN}/sitemap-pages.xml` }])
        assert.match(index, /<sitemapindex/)
        assert.match(index, /<loc>https:\/\/shop\.example\.com\/sitemap-pages\.xml<\/loc>/)
    })
})

describe('unitPricing', () => {
    it('turns a 750 ml package into a 100 ml comparison', () => {
        assert.deepEqual(unitPricing({ unit: { type: 'item' }, netContentText: '750 מ"ל' }), {
            measure: '750 ml',
            baseMeasure: '100 ml'
        })
    })

    it('uses a 1-unit base for packages up to 100', () => {
        assert.deepEqual(unitPricing({ unit: { type: 'item' }, name: 'שוקולד 50 גרם' }), {
            measure: '50 g',
            baseMeasure: '1 g'
        })
        assert.deepEqual(unitPricing({ unit: { type: 'item' }, netContentText: '100 גרם' }), {
            measure: '100 g',
            baseMeasure: '1 g'
        })
    })

    it('switches to kg/l above 1000 so the measure stays in Google range', () => {
        assert.deepEqual(unitPricing({ unit: { type: 'item' }, netContentText: '2 ליטר' }), {
            measure: '2 l',
            baseMeasure: '100 ml'
        })
        assert.deepEqual(unitPricing({ unit: { type: 'item' }, netContentText: '3 ק"ג' }), {
            measure: '3 kg',
            baseMeasure: '100 g'
        })
    })

    it('skips packages too small to compare against a 1 g/ml base', () => {
        assert.equal(unitPricing({ unit: { type: 'item' }, netContentText: '0.5 גרם' }), null)
    })

    it('skips weighed products: their price is already per base unit', () => {
        assert.equal(unitPricing({ unit: { type: 'weight', baseUnit: 'kg' }, name: 'עגבניות' }), null)
    })
})

describe('renderGoogleFeedItem', () => {
    it('renders the full Merchant attribute set', () => {
        const xml = renderGoogleFeedItem({ product: product(), price: 12.9, origin: ORIGIN })

        assert.match(xml, /^<item>/)
        assert.match(xml, /<g:id>p1<\/g:id>/)
        assert.match(xml, /<g:title>חלב טרי 3%<\/g:title>/)
        assert.match(xml, /<g:description>חלב &amp; טרי מיכל<\/g:description>/)
        assert.match(xml, /<g:link>https:\/\/shop\.example\.com\/product\/p1<\/g:link>/)
        assert.match(xml, /<g:image_link>https:\/\/files\.shopik\.co\.il\/images\/products\/p1\/xl\.webp\?v=mainhash<\/g:image_link>/)
        assert.match(xml, /<g:additional_image_link>/)
        assert.match(xml, /<g:availability>in_stock<\/g:availability>/)
        assert.match(xml, /<g:condition>new<\/g:condition>/)
        assert.match(xml, /<g:price>12\.90 ILS<\/g:price>/)
        assert.match(xml, /<g:gtin>7290000000001<\/g:gtin>/)
        assert.match(xml, /<g:brand>טרה<\/g:brand>/)
        assert.match(xml, /<g:identifier_exists>yes<\/g:identifier_exists>/)
        assert.match(xml, /<g:google_product_category>/)
        assert.match(xml, /<g:product_type>מוצרי חלב<\/g:product_type>/)
        assert.match(xml, /<g:unit_pricing_measure>750 ml<\/g:unit_pricing_measure>/)
        assert.match(xml, /<g:unit_pricing_base_measure>100 ml<\/g:unit_pricing_base_measure>/)
    })

    it('emits a single-unit percentage sale with its effective window', () => {
        const xml = renderGoogleFeedItem({
            product: product({ saleIds: ['s1'] }),
            price: 10,
            sale: {
                id: 's1',
                kind: 'percent',
                percent: 20,
                amount: 1,
                start: '2026-01-01T00:00:00.000Z',
                end: '2099-01-01T00:00:00.000Z'
            },
            origin: ORIGIN,
            now: new Date('2026-02-01T00:00:00.000Z')
        })
        assert.match(xml, /<g:sale_price>8\.00 ILS<\/g:sale_price>/)
        assert.match(xml, /<g:sale_price_effective_date>2026-01-01T00:00:00\.000Z\/2099-01-01T00:00:00\.000Z<\/g:sale_price_effective_date>/)
    })

    it('never turns a quantity bundle (3 ב-10) into a per-unit sale price', () => {
        const xml = renderGoogleFeedItem({
            product: product({ saleIds: ['s1'] }),
            price: 10,
            sale: {
                id: 's1',
                kind: 'price',
                price: 10,
                amount: 3,
                start: '2026-01-01T00:00:00.000Z',
                end: '2099-01-01T00:00:00.000Z'
            },
            origin: ORIGIN,
            now: new Date('2026-02-01T00:00:00.000Z')
        })
        assert.doesNotMatch(xml, /<g:sale_price>/)
    })

    it('does not resurrect an expired sale price', () => {
        const xml = renderGoogleFeedItem({
            product: product(),
            price: 10,
            sale: {
                id: 's1',
                kind: 'percent',
                percent: 50,
                amount: 1,
                start: '2025-01-01T00:00:00.000Z',
                end: '2025-02-01T00:00:00.000Z'
            },
            origin: ORIGIN,
            now: new Date('2026-02-01T00:00:00.000Z')
        })
        assert.doesNotMatch(xml, /<g:sale_price>/)
    })

    it('does not publish a not-yet-started sale', () => {
        const xml = renderGoogleFeedItem({
            product: product({ saleIds: ['s1'] }),
            price: 10,
            sale: {
                id: 's1',
                kind: 'percent',
                percent: 50,
                amount: 1,
                start: '2027-01-01T00:00:00.000Z',
                end: '2027-02-01T00:00:00.000Z'
            },
            origin: ORIGIN,
            now: new Date('2026-02-01T00:00:00.000Z')
        })
        assert.doesNotMatch(xml, /<g:sale_price>/)
    })

    it('ignores receive-* promotions: they add an item, they do not discount one', () => {
        const xml = renderGoogleFeedItem({
            product: product({ saleIds: ['s1'] }),
            price: 10,
            sale: {
                id: 's1',
                kind: 'receive-price',
                price: 1,
                amount: 1,
                start: '2026-01-01T00:00:00.000Z',
                end: '2099-01-01T00:00:00.000Z'
            },
            origin: ORIGIN,
            now: new Date('2026-02-01T00:00:00.000Z')
        })
        assert.doesNotMatch(xml, /<g:sale_price>/)
    })

    it('marks identifier_exists=no when the GTIN is invalid or the brand is missing', () => {
        const invalid = renderGoogleFeedItem({ product: product({ barcode: 'abc' }), price: 10, origin: ORIGIN })
        assert.doesNotMatch(invalid, /<g:gtin>/)
        assert.match(invalid, /<g:identifier_exists>no<\/g:identifier_exists>/)

        const noBrand = renderGoogleFeedItem({ product: product({ producer: '' }), price: 10, origin: ORIGIN })
        assert.match(noBrand, /<g:gtin>7290000000001<\/g:gtin>/)
        assert.match(noBrand, /<g:identifier_exists>no<\/g:identifier_exists>/)
    })

    it('skips products without a price, without a main image, or without a title', () => {
        assert.equal(renderGoogleFeedItem({ product: product(), price: 0, origin: ORIGIN }), null)
        assert.equal(renderGoogleFeedItem({ product: product({ images: { product: [] } }), price: 10, origin: ORIGIN }), null)
        assert.equal(renderGoogleFeedItem({ product: product({ name: '' }), price: 10, origin: ORIGIN }), null)
    })

    it('caps title and description to Merchant limits by code point', () => {
        const xml = renderGoogleFeedItem({
            product: product({ name: 'א'.repeat(200), description: 'ב'.repeat(6000) }),
            price: 10,
            origin: ORIGIN
        })
        const title = xml.match(/<g:title>(.*?)<\/g:title>/)[1]
        const description = xml.match(/<g:description>(.*?)<\/g:description>/)[1]
        assert.equal(Array.from(title).length, 150)
        assert.equal(Array.from(description).length, 5000)
    })
})
