import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import update from '../../server/api/setting/update.js'

function makeDL(setting) {
    const calls = []
    return {
        calls,
        DL: {
            Setting: {
                readById: async () => setting,
                updateOne: async (filter, doc) => {
                    calls.push({ filter, doc })
                    return { ...setting, ...doc }
                }
            },
            Domain: { readById: async () => ({ id: 'd1' }) }
        }
    }
}

describe('setting update', () => {
    it('drops the captured pixel size when the value is edited by hand', async () => {
        const setting = {
            id: 's1', key: 'ogImage', category: 'seo', domainId: 'd1',
            value: 'images/settings/d1/ogImage/v1/l.webp', width: 1200, height: 630
        }
        const { DL, calls } = makeDL(setting)
        await update({ id: 's1', value: 'images/settings/d1/ogImage/v2/l.webp' }, { DL })

        assert.equal(calls.length, 1)
        assert.equal(calls[0].doc.value, 'images/settings/d1/ogImage/v2/l.webp')
        assert.equal(calls[0].doc.width, null)
        assert.equal(calls[0].doc.height, null)
    })

    it('leaves the pixel size alone when a save does not change the value', async () => {
        const setting = {
            id: 's1', key: 'ogImage', category: 'seo', domainId: 'd1',
            value: 'images/settings/d1/ogImage/v1/l.webp', width: 1200, height: 630
        }
        const { DL, calls } = makeDL(setting)
        const result = await update({ id: 's1', value: setting.value }, { DL })

        assert.deepEqual(result, setting)
        assert.equal(calls.length, 0)
    })
})
