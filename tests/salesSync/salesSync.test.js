import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runSalesSync } from '../../server/cron/salesSync.js'

// In-memory stand-in for the `cron_locks` collection: one row per key, and the
// unique index on `key` is what makes "take it only if absent or expired" atomic.
function fakeLockModel(row = null) {
    const state = { row }
    const Model = {
        findOneAndUpdate(filter, update) {
            return {
                async lean() {
                    const held = state.row?.key === filter.key &&
                        !(state.row.expiresAt < filter.expiresAt.$lt)
                    if (held)
                        throw Object.assign(new Error('E11000: duplicate key'), { code: 11000 })
                    state.row = { key: filter.key, ...update.$set }
                    return { ...state.row }
                }
            }
        },
        async deleteOne(filter) {
            if (state.row?.key === filter.key && state.row?.token === filter.token)
                state.row = null
            return { deletedCount: 1 }
        }
    }
    return { Model, state }
}

describe('sales sync cron', () => {
    it('imports from Comax, then syncs sales+products, then releases the lock', async () => {
        const calls = []
        const { Model, state } = fakeLockModel()
        const result = await runSalesSync(
            { DL: {}, external: {} },
            {
                lockModel: Model,
                importFn: async () => {
                    calls.push('import')
                    return { count: 3 }
                },
                syncFn: async () => {
                    calls.push('sync')
                    return {
                        synced: 2, created: 1, updated: 1,
                        saleUpdates: { updatedToDone: 1, updatedToActive: 2, updatedProducts: 10, clearedProducts: 4 },
                    }
                },
            }
        )
        assert.deepEqual(calls, ['import', 'sync'])
        assert.equal(result.importResult.count, 3)
        assert.equal(result.syncResult.synced, 2)
        assert.equal(result.syncResult.saleUpdates.updatedProducts, 10)
        assert.equal(state.row, null)
    })

    it('skips when another instance holds the lock (no import, no sync)', async () => {
        const calls = []
        const { Model } = fakeLockModel({
            key: 'sales-sync:lock',
            token: 'other-instance',
            expiresAt: new Date(Date.now() + 60_000)
        })
        await runSalesSync(
            { DL: {}, external: {} },
            {
                lockModel: Model,
                importFn: async () => {
                    calls.push('import')
                },
                syncFn: async () => {
                    calls.push('sync')
                },
            }
        )
        assert.deepEqual(calls, [])
    })

    it('releases the lock and rethrows when a step fails', async () => {
        const { Model, state } = fakeLockModel()
        await assert.rejects(
            runSalesSync(
                { DL: {}, external: {} },
                {
                    lockModel: Model,
                    importFn: async () => {
                        throw new Error('comax down')
                    },
                    syncFn: async () => ({}),
                }
            ),
            /comax down/
        )
        assert.equal(state.row, null)
    })
})
