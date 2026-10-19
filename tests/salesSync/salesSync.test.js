import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runSalesSync } from '../../server/cron/salesSync.js'

// In-memory redis stub for acquireLock (set NX / get / del).
function fakeRedis() {
    const store = new Map()
    return {
        async set(key, value, ...args) {
            if (args.includes('NX') && store.has(key)) return null
            store.set(key, value)
            return 'OK'
        },
        async get(key) {
            return store.get(key) ?? null
        },
        async del(key) {
            store.delete(key)
            return 1
        },
        has(key) {
            return store.has(key)
        },
    }
}

describe('sales sync cron', () => {
    it('imports from Comax, then syncs sales+products, then releases the lock', async () => {
        const calls = []
        const redis = fakeRedis()
        const result = await runSalesSync(
            { DL: { redis }, external: {} },
            {
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
        assert.equal(redis.has('sales-sync:lock'), false)
    })

    it('skips when another instance holds the lock (no import, no sync)', async () => {
        const calls = []
        const redis = fakeRedis()
        await redis.set('sales-sync:lock', 'other-instance', 'EX', 60, 'NX')
        await runSalesSync(
            { DL: { redis }, external: {} },
            {
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
        const redis = fakeRedis()
        await assert.rejects(
            runSalesSync(
                { DL: { redis }, external: {} },
                {
                    importFn: async () => {
                        throw new Error('comax down')
                    },
                    syncFn: async () => ({}),
                }
            ),
            /comax down/
        )
        assert.equal(redis.has('sales-sync:lock'), false)
    })
})
