import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildMeta } from '../../common/functions/buildMeta.js'

process.env.FILES_BASE_URL = 'https://files.shopik.co.il'

const settings = {
    seo: {
        seoDescription: 'Store-wide description',
        ogImage: 'images/settings/d1/ogImage/v1',
        ogType: 'website',
        twitterCard: 'summary'
    },
    appearance: {
        siteName: 'Shopik',
        logo: 'images/settings/d1/logo/v1',
        appIcon: 'images/settings/d1/appIcon/v1'
    },
    // Captured by upload_file, exposed separately by getSettings.
    __imageSize: {
        'seo.ogImage': { width: 1200, height: 630 }
    }
}

describe('buildMeta', () => {
    it('per-page title/image/type win over the seo settings, description never varies', () => {
        const meta = buildMeta({
            settings,
            initData: { title: 'Product name', description: 'Product desc', image: 'https://files/x.webp', metaType: 'product' },
            page: { title: 'Product', description: 'page desc' },
            url: '/product/123',
            host: 'store-b.com'
        })
        assert.equal(meta.title, 'Shopik | Product name')
        assert.equal(meta.description, 'Store-wide description')
        assert.equal(meta.image, 'https://files/x.webp')
        assert.equal(meta.imageType, 'image/webp')
        // Per-page images have no recorded size, so hints are omitted.
        assert.equal(meta.imageWidth, '')
        assert.equal(meta.imageHeight, '')
        assert.equal(meta.type, 'product')
        assert.equal(meta.url, 'https://store-b.com/product/123')
        assert.equal(meta.siteName, 'Shopik')
    })

    it('static pages fall back to the seo settings then the route table', () => {
        const meta = buildMeta({ settings, initData: {}, page: { title: 'Home', description: 'route desc' }, url: '/', host: 'store-b.com' })
        assert.equal(meta.title, 'Shopik | Home')
        assert.equal(meta.description, 'Store-wide description')
        assert.equal(meta.image, 'https://files.shopik.co.il/images/settings/d1/ogImage/v1/l.webp')
        assert.equal(meta.imageType, 'image/webp')
        assert.equal(meta.imageWidth, 1200)
        assert.equal(meta.imageHeight, 630)
        assert.equal(meta.type, 'website')
    })

    it('an ogImage value pointing at an exact variant file is used as-is', () => {
        const meta = buildMeta({
            settings: { ...settings, seo: { ...settings.seo, ogImage: 'images/settings/d1/ogImage/v1/full.webp' } },
            initData: {},
            page: { title: 'Home' },
            url: '/',
            host: 'store-b.com'
        })
        assert.equal(meta.image, 'https://files.shopik.co.il/images/settings/d1/ogImage/v1/full.webp')
    })

    it('an unset seoDescription emits nothing, not the page description', () => {
        const meta = buildMeta({ settings: { appearance: {} }, initData: { description: 'Product desc' }, page: { description: 'route desc' }, url: '/product/1', host: 'x.com' })
        assert.equal(meta.description, '')
    })

    it('image falls back to appIcon (512) when ogImage is unset', () => {
        const meta = buildMeta({ settings: { appearance: settings.appearance }, initData: {}, page: {}, url: '/', host: 'x.com' })
        assert.equal(meta.image, 'https://files.shopik.co.il/images/settings/d1/appIcon/v1/512.png')
        assert.equal(meta.imageType, 'image/png')
        assert.equal(meta.imageWidth, '')
        assert.equal(meta.twitterCard, 'summary_large_image')
    })

    it('image falls back to appearance.logo when ogImage and appIcon are unset', () => {
        const meta = buildMeta({ settings: { appearance: { logo: settings.appearance.logo } }, initData: {}, page: {}, url: '/', host: 'x.com' })
        assert.equal(meta.image, 'https://files.shopik.co.il/images/settings/d1/logo/v1/l.webp')
        assert.equal(meta.twitterCard, 'summary_large_image')
    })

    it('twitterCard defaults to summary without an image', () => {
        const meta = buildMeta({ settings: { appearance: {} }, initData: {}, page: {}, url: '/', host: 'x.com' })
        assert.equal(meta.image, '')
        assert.equal(meta.twitterCard, 'summary')
    })

    it('404 pages emit no social tags', () => {
        const meta = buildMeta({ settings, initData: {}, page: {}, notFound: true, url: '/nope', host: 'x.com' })
        assert.equal(meta.title, '')
        assert.equal(meta.description, '')
        assert.equal(meta.image, '')
        assert.equal(meta.type, '')
        assert.equal(meta.twitterCard, '')
    })

    it('no og:url without a request host', () => {
        const meta = buildMeta({ settings, initData: {}, page: {}, url: '/', host: undefined })
        assert.equal(meta.url, '')
    })
})
