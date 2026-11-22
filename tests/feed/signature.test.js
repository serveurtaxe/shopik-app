import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    clearFeedSignatureCache,
    readFeedSignature,
    readFeedSignatureCached,
    readVisibleCarousels,
    seedFeedSignatureCache
} from '../../server/services/feed/signature.js'

const state = {
    products: { count: 0, latest: null },
    sales: { count: 0, latest: null },
    categories: [],
    blocks: [],
    categoryDelayMs: 0,
    calls: { productCount: 0, productLatest: 0, saleCount: 0, saleLatest: 0, categoryRead: 0 }
}

function modelFor(key, countKey, latestKey) {
    return {
        async countDocuments() {
            state.calls[countKey] += 1
            return state[key].count
        },
        findOne() {
            state.calls[latestKey] += 1
            return {
                sort() {
                    return this
                },
                async lean() {
                    return state[key].latest ? { updatedAt: state[key].latest } : null
                }
            }
        }
    }
}

const DL = {
    Product: { constants: { STATUS: { ACTIVE: 'active' } }, Model: modelFor('products', 'productCount', 'productLatest') },
    Sale: { constants: { STATUS: { ACTIVE: 'active' } }, Model: modelFor('sales', 'saleCount', 'saleLatest') },
    Category: {
        // Signature reads the category hashset; tests only need the shape the
        // real DL returns.
        async read(filter) {
            state.calls.categoryRead += 1
            if (state.categoryDelayMs) {
                await new Promise(resolve => setTimeout(resolve, state.categoryDelayMs))
            }
            return state.categories.filter(category => filter.active ? category.active !== false : true)
        }
    },
    DisplayBlock: {
        constants: { KIND: { PRODUCT_CAROUSEL: 'product_carousel' } },
        Model: {
            find() {
                return { async lean() { return state.blocks } }
            }
        }
    }
}

function fakeRedis() {
    const data = new Map()
    const sets = []
    return {
        status: 'ready',
        data,
        sets,
        async get(key) {
            return data.has(key) ? data.get(key) : null
        },
        async set(key, value, ...args) {
            data.set(key, String(value))
            sets.push([key, String(value), ...args])
            return 'OK'
        }
    }
}

beforeEach(() => {
    clearFeedSignatureCache()
    state.products = { count: 10, latest: '2026-01-01T00:00:00.000Z' }
    state.sales = { count: 2, latest: '2026-01-02T00:00:00.000Z' }
    state.categories = [
        { id: 'c1', active: true, updatedAt: '2026-01-03T00:00:00.000Z' },
        { id: 'c2', active: true, updatedAt: '2026-01-04T00:00:00.000Z' },
        { id: 'c3', active: false, updatedAt: '2026-01-05T00:00:00.000Z' }
    ]
    state.blocks = [
        { id: 'b1', schedule: { start: '2020-01-01T00:00:00.000Z', end: '2099-01-01T00:00:00.000Z' } }
    ]
    state.categoryDelayMs = 0
    state.calls = { productCount: 0, productLatest: 0, saleCount: 0, saleLatest: 0, categoryRead: 0 }
})

describe('feed signature', () => {
    it('is stable while nothing changes', async () => {
        const first = await readFeedSignature(DL, 'd1')
        const second = await readFeedSignature(DL, 'd1')
        assert.equal(first, second)
    })

    it('changes when a product is edited', async () => {
        const before = await readFeedSignature(DL, 'd1')
        state.products.latest = '2026-02-01T00:00:00.000Z'
        assert.notEqual(await readFeedSignature(DL, 'd1'), before)
    })

    it('changes when a product is deleted even if the newest updatedAt is unchanged', async () => {
        const before = await readFeedSignature(DL, 'd1')
        state.products.count -= 1
        assert.notEqual(await readFeedSignature(DL, 'd1'), before)
    })

    it('watches sale edits: a changed sale price must refresh the feed', async () => {
        const before = await readFeedSignature(DL, 'd1')
        state.sales.latest = '2026-02-01T00:00:00.000Z'
        assert.notEqual(await readFeedSignature(DL, 'd1'), before)
    })

    it('watches category renames: paths feed the pages sitemap', async () => {
        const before = await readFeedSignature(DL, 'd1')
        state.categories[0].updatedAt = '2026-02-01T00:00:00.000Z'
        assert.notEqual(await readFeedSignature(DL, 'd1'), before)
    })

    it('ignores inactive categories', async () => {
        const before = await readFeedSignature(DL, 'd1')
        state.categories.push({ id: 'c4', active: false, updatedAt: '2026-03-01T00:00:00.000Z' })
        assert.equal(await readFeedSignature(DL, 'd1'), before)
    })

    it('changes when a carousel schedule opens or closes', async () => {
        const before = await readFeedSignature(DL, 'd1')
        state.blocks = [
            { id: 'b1', schedule: { start: '2020-01-01T00:00:00.000Z', end: '2025-01-01T00:00:00.000Z' } },
            { id: 'b2', schedule: {} }
        ]
        assert.notEqual(await readFeedSignature(DL, 'd1'), before)
    })
})

describe('signature cache', () => {
    it('shares one computation between concurrent callers', async () => {
        state.categoryDelayMs = 25
        const values = await Promise.all([
            readFeedSignatureCached(DL, 'd1'),
            readFeedSignatureCached(DL, 'd1'),
            readFeedSignatureCached(DL, 'd1')
        ])

        assert.equal(values[0], values[1])
        assert.equal(values[1], values[2])
        assert.equal(state.calls.productCount, 1, 'only the first caller may query the DB')
        assert.equal(state.calls.categoryRead, 1)
    })

    it('publishes the computed signature to Redis with the TTL', async () => {
        const redis = fakeRedis()
        const value = await readFeedSignatureCached({ ...DL, redis }, 'd1', { ttlMs: 60_000 })

        assert.equal(redis.data.get('feed:sig:v1:d1'), value)
        assert.deepEqual(redis.sets.find(([key]) => key === 'feed:sig:v1:d1'), [
            'feed:sig:v1:d1', value, 'PX', 60_000
        ])
    })

    it('reuses a signature another instance published, with no DB reads', async () => {
        const redis = fakeRedis()
        redis.data.set('feed:sig:v1:d1', '1:2:3:4:5:6:abc')
        const value = await readFeedSignatureCached({ ...DL, redis }, 'd1')

        assert.equal(value, '1:2:3:4:5:6:abc')
        assert.equal(state.calls.productCount, 0)
        assert.equal(state.calls.categoryRead, 0)
    })

    it('seeds both the local cache and Redis after a generation', async () => {
        const redis = fakeRedis()
        const DLWithRedis = { ...DL, redis }
        await seedFeedSignatureCache(DLWithRedis, 'd1', 'seeded-value')

        assert.equal(await readFeedSignatureCached(DLWithRedis, 'd1'), 'seeded-value')
        assert.equal(redis.data.get('feed:sig:v1:d1'), 'seeded-value')
        assert.equal(state.calls.productCount, 0)
    })

    it('ttl 0 always recomputes and never touches Redis', async () => {
        const redis = fakeRedis()
        const first = await readFeedSignatureCached({ ...DL, redis }, 'd1', { ttlMs: 0 })
        const second = await readFeedSignatureCached({ ...DL, redis }, 'd1', { ttlMs: 0 })

        assert.equal(first, second)
        assert.equal(state.calls.productCount, 2)
        assert.equal(redis.sets.length, 0)
        assert.equal(redis.data.size, 0)
    })

    it('keeps working when Redis is unavailable', async () => {
        const value = await readFeedSignatureCached({ ...DL, redis: { status: 'down' } }, 'd1')
        assert.match(value, /^10:/)
    })
})

describe('readVisibleCarousels', () => {
    it('drops blocks outside their schedule and keeps the rest', async () => {
        state.blocks = [
            { id: 'past', schedule: { end: '2020-01-01T00:00:00.000Z' } },
            { id: 'future', schedule: { start: '2099-01-01T00:00:00.000Z' } },
            { id: 'now', schedule: { start: '2020-01-01T00:00:00.000Z', end: '2099-01-01T00:00:00.000Z' } },
            { id: 'always', schedule: {} }
        ]
        const visible = await readVisibleCarousels(DL, 'd1', new Date('2026-06-01T00:00:00.000Z'))
        assert.deepEqual(visible.map(block => block.id), ['now', 'always'])
    })
})
