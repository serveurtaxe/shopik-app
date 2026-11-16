import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import sourceVersion, { REPORT_FORMAT_VERSION } from '../../server/reports/version.js'

function fakeDL(overrides = {}) {
    const one = value => ({ sort: () => ({ lean: async () => value }) })
    const data = {
        domain: { id: 'default-domain' },
        stores: [{ id: 'store-a', name: 'סניף א' }],
        comaxCount: 100,
        comaxLast: { updatedAt: new Date('2026-11-12T00:00:00Z') },
        productCount: 80,
        productLast: { updatedAt: new Date('2026-11-12T00:00:00Z') },
        gs1Count: 5,
        categoryMapCount: 20,
        categoryMapLast: { updatedAt: new Date('2026-11-10T00:00:00Z') },
        salesWindow: { defaultDays: 30, rules: [] },
        comaxSync: { finishedAt: new Date('2026-11-12T00:00:00Z') },
        gs1Sync: { lastSyncAt: new Date('2026-11-12T00:00:00Z') },
        ...overrides
    }

    return {
        Domain: { readOne: async () => data.domain },
        Store: { Model: { find: () => one(data.stores) } },
        ComaxProduct: {
            Model: {
                countDocuments: async () => data.comaxCount,
                findOne: () => one(data.comaxLast)
            }
        },
        Product: {
            Model: {
                countDocuments: async () => data.productCount,
                findOne: () => one(data.productLast)
            }
        },
        Gs1Product: { Model: { countDocuments: async () => data.gs1Count } },
        CategoryMap: {
            Model: {
                countDocuments: async () => data.categoryMapCount,
                findOne: () => one(data.categoryMapLast)
            }
        },
        Setting: { readOne: async () => ({ value: data.salesWindow }) },
        ComaxSyncState: { readOne: async () => data.comaxSync },
        Gs1SyncState: { readOne: async () => data.gs1Sync }
    }
}

describe('catalog report source version', () => {
    it('is stable for unchanged sources', async () => {
        const first = await sourceVersion(fakeDL())
        const second = await sourceVersion(fakeDL())

        assert.equal(first, second)
        assert.equal(first.length, 20)
    })

    it('exposes the report format version', () => {
        assert.equal(REPORT_FORMAT_VERSION, 4)
    })

    it('moves when a category flag row changes', async () => {
        const before = await sourceVersion(fakeDL())
        const after = await sourceVersion(fakeDL({
            categoryMapLast: { updatedAt: new Date('2026-11-11T00:00:00Z') }
        }))

        assert.notEqual(before, after)
    })

    it('moves when the sales window changes', async () => {
        const before = await sourceVersion(fakeDL())
        const after = await sourceVersion(fakeDL({
            salesWindow: { defaultDays: 60, rules: [] }
        }))

        assert.notEqual(before, after)
    })
})
