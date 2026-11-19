import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    clearFeedSignatureCache,
    readFeedSignature,
    readVisibleCarousels
} from '../../server/services/feed/signature.js'

const state = {
    products: { count: 0, latest: null },
    sales: { count: 0, latest: null },
    categories: { count: 0, latest: null },
    blocks: []
}

function modelFor(key) {
    return {
        async countDocuments() {
            return state[key].count
        },
        findOne() {
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
    Product: { constants: { STATUS: { ACTIVE: 'active' } }, Model: modelFor('products') },
    Sale: { constants: { STATUS: { ACTIVE: 'active' } }, Model: modelFor('sales') },
    Category: { Model: modelFor('categories') },
    DisplayBlock: {
        constants: { KIND: { PRODUCT_CAROUSEL: 'product_carousel' } },
        Model: {
            find() {
                return { async lean() { return state.blocks } }
            }
        }
    }
}

beforeEach(() => {
    clearFeedSignatureCache()
    state.products = { count: 10, latest: '2026-01-01T00:00:00.000Z' }
    state.sales = { count: 2, latest: '2026-01-02T00:00:00.000Z' }
    state.categories = { count: 3, latest: '2026-01-03T00:00:00.000Z' }
    state.blocks = [
        { id: 'b1', schedule: { start: '2020-01-01T00:00:00.000Z', end: '2099-01-01T00:00:00.000Z' } }
    ]
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
        state.categories.latest = '2026-02-01T00:00:00.000Z'
        assert.notEqual(await readFeedSignature(DL, 'd1'), before)
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
