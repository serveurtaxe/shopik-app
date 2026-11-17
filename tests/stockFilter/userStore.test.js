import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import getUserStore, { invalidateUserStore } from '../../server/utils/data/getUserStore.js'
import { resolveStockContext } from '../../server/utils/data/withStock.js'

// Stock filtering reads the cart order's store on every storefront request, so the
// resolved store is cached per user. The cache is only safe while every store write
// invalidates it — these fakes stand in for Redis and the cart order.
// `status: 'ready'` matters: a cache is only used while its client can answer.
const fakeRedis = () => {
    const store = {}
    return {
        status: 'ready',
        get: async (key) => store[key] ?? null,
        set: async (key, value) => { store[key] = value },
        del: async (key) => { delete store[key]; return 1 }
    }
}

const fakeBoot = ({ redis, order, authUser }) => {
    let authCalls = 0
    return {
        DL: {
            redis,
            Setting: { readOne: async () => ({ value: 'filter' }) },
            CashRegister: { readOne: async () => ({ storeId: 'store-a' }) },
            Order: { readOne: async () => order },
            GuestCart: { readOne: async () => null }
        },
        utils: {
            data: { getUserStore },
            auth: {
                getUser: async () => {
                    authCalls++
                    if (!authUser) throw new Error('session re-resolved')
                    return authUser
                }
            }
        },
        authCalls: () => authCalls
    }
}

describe('user store cache', () => {
    it('uses the injected user instead of re-resolving the session', async () => {
        const boot = fakeBoot({ redis: fakeRedis(), order: { storeId: 'store-a' }, authUser: null })
        const { storeId } = await resolveStockContext({}, { ...boot, _user: { id: 'u1' } })
        assert.equal(storeId, 'store-a')
        assert.equal(boot.authCalls(), 0)
    })

    it('keeps the cached store until it is invalidated', async () => {
        const redis = fakeRedis()
        const first = fakeBoot({ redis, order: { storeId: 'store-a' }, authUser: { id: 'u1' } })
        await resolveStockContext({}, { ...first, _user: { id: 'u1' } })

        // The cart order moved to another store, but the cache still answers.
        const second = fakeBoot({ redis, order: { storeId: 'store-b' }, authUser: { id: 'u1' } })
        assert.equal((await resolveStockContext({}, { ...second, _user: { id: 'u1' } })).storeId, 'store-a')

        await invalidateUserStore(first.DL, 'u1')
        assert.equal((await resolveStockContext({}, { ...second, _user: { id: 'u1' } })).storeId, 'store-b')
    })

    it('does nothing without a user or without redis', async () => {
        await invalidateUserStore({ redis: { del: async () => 1 } }, undefined)
        await invalidateUserStore({}, 'u1')
    })
})
