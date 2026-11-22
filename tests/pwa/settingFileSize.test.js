import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getSettingFileSize, getSettingFileUrl } from '../../common/functions/settingFileUrl.js'

process.env.FILES_BASE_URL = 'https://files.shopik.co.il'

describe('getSettingFileSize', () => {
    it('uses the standard l variant by default', () => {
        assert.equal(getSettingFileSize({ key: 'logo' }), 'l')
    })

    it('uses the first declared custom size', () => {
        assert.equal(getSettingFileSize({ key: 'ogImage', sizes: { full: null } }), 'full')
    })

    it('appIcon uses the fixed OS-standard 192 preview (no per-setting sizes)', () => {
        assert.equal(getSettingFileSize({ key: 'appIcon' }), '192.png')
    })
})

describe('getSettingFileUrl with named sizes', () => {
    it('appends .webp for plain size names', () => {
        assert.equal(getSettingFileUrl('images/settings/d1/ogImage/v1', 'full'),
            'https://files.shopik.co.il/images/settings/d1/ogImage/v1/full.webp')
    })

    it('uses named file sizes as-is (appIcon PNG variants)', () => {
        assert.equal(getSettingFileUrl('images/settings/d1/appIcon/v1', getSettingFileSize({ key: 'appIcon' })),
            'https://files.shopik.co.il/images/settings/d1/appIcon/v1/192.png')
    })
})
