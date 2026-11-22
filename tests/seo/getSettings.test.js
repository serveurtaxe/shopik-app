import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import getSettings from '../../server/utils/data/getSettings.js'

describe('getSettings', () => {
    it('exposes captured image sizes outside the value tree', async () => {
        const rows = [
            { category: 'seo', key: 'ogImage', value: 'images/settings/d1/ogImage/v1/full.webp', width: 1200, height: 630 },
            { category: 'seo', key: 'ogType', value: 'website' },
            { category: 'appearance', key: 'siteName', value: 'Shopik' }
        ]
        const DL = { Setting: { read: async () => rows } }
        const settings = await getSettings({ DL, domainId: 'd1' })

        assert.equal(settings.seo.ogImage, 'images/settings/d1/ogImage/v1/full.webp')
        assert.equal(settings.seo.ogType, 'website')
        assert.equal(settings.appearance.siteName, 'Shopik')
        assert.deepEqual(settings.__imageSize, { 'seo.ogImage': { width: 1200, height: 630 } })
    })

    it('omits the size map when no upload recorded dimensions', async () => {
        const rows = [{ category: 'seo', key: 'ogImage', value: '' }]
        const DL = { Setting: { read: async () => rows } }
        const settings = await getSettings({ DL, domainId: 'd1' })

        assert.equal(settings.seo.ogImage, '')
        assert.equal(settings.__imageSize, undefined)
    })

    it('scopes the read to the request domain', async () => {
        let filter
        const DL = { Setting: { read: async f => { filter = f; return [] } } }
        await getSettings({ DL, domainId: 'd1' })

        assert.deepEqual(filter, { active: true, public: true, domainId: 'd1' })
    })
})
