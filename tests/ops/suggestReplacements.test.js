import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import suggest_replacements from '../../server/api/order/ops/suggest_replacements.js'

const ADMIN = { id: 'a1' }
const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden', ARCHIVED: 'archived' }

function order(over = {}) {
    return {
        id: 'o1',
        status: 'picking',
        picker: { adminId: ADMIN.id },
        domainId: 'd1',
        cart: [
            { id: 'p1', barcode: 'A', category: { id: 'cat1', pathIds: ['cat1'] }, storageType: 'regular' },
            { id: 'p2', barcode: 'B', category: { id: 'cat1', pathIds: ['cat1'] }, storageType: 'regular' }
        ],
        ...over
    }
}

const prod = (id, barcode, over = {}) => ({
    id, barcode, name: `product ${barcode}`, prices: [{ domainId: 'd1', price: 10 }], status: STATUS.ACTIVE, ...over
})

function harness({ orderDoc = order(), reads = [], searchResults = [], exact = null } = {}) {
    const calls = { reads: [], searches: [], readOne: [] }
    const DL = {
        Order: { readById: async () => orderDoc },
        Product: {
            constants: { STATUS },
            read: async (filter, select, opts) => {
                calls.reads.push({ filter, opts })
                const next = reads[calls.reads.length - 1]
                return next || []
            },
            search: async (q, filter, opts) => {
                calls.searches.push({ q, filter, opts })
                return searchResults
            },
            readOne: async (filter, select) => {
                calls.readOne.push({ filter, select })
                return exact
            },
            Model: { findOne: () => ({ lean: async () => null }) }
        },
        Sale: { constants: { STATUS: { ACTIVE: 'active' } }, read: async () => [] }
    }
    const call = payload => suggest_replacements(payload, { DL, _admin: ADMIN })
    return { call, calls }
}

describe('suggest_replacements keeps cart products out of the candidates', () => {
    it('drops products the order already has and still returns the requested number', async () => {
        const all = [prod('p1', 'A'), prod('p2', 'B'), prod('p3', 'C'), prod('p4', 'D'), prod('p5', 'E')]
        const { call, calls } = harness({ reads: [all] })

        const res = await call({ id: 'o1', barcode: 'A', limit: 3 })

        assert.deepEqual(res.products.map(p => p.id), ['p3', 'p4', 'p5'])
        // Extra rows are read so the filtered list is not short of its limit.
        assert.equal(calls.reads[0].opts.limit, 5)
    })

    it('hides an exactly scanned product when the cart already has it', async () => {
        const { call } = harness({ exact: prod('p2', '1234') })
        const res = await call({ id: 'o1', barcode: 'A', search: '1234' })
        assert.deepEqual(res.products, [])
    })

    it('still returns an exactly scanned product the cart does not have', async () => {
        const { call } = harness({ exact: prod('p9', '1234') })
        const res = await call({ id: 'o1', barcode: 'A', search: '1234' })
        assert.deepEqual(res.products.map(p => p.id), ['p9'])
    })

    it('broadens to the storage type when the whole category is already in the cart', async () => {
        const category = [prod('p1', 'A'), prod('p2', 'B')]
        const broad = [prod('p1', 'A'), prod('p6', 'F'), prod('p7', 'G')]
        const { call, calls } = harness({ reads: [category, broad] })

        const res = await call({ id: 'o1', barcode: 'A', limit: 2 })

        assert.equal(calls.reads.length, 2)
        assert.equal(calls.reads[1].filter.storageType, 'regular')
        assert.deepEqual(res.products.map(p => p.id), ['p6', 'p7'])
    })

    // The category filter has to sit on the indexed key: category.id is not in any
    // index, so the planner used {status, prices.domainId, totalSalesUnits, id} and
    // walked every active product of the domain (7 201 docs for 32 candidates on the
    // prod copy). pathIds is indexed and its last element is the category id itself.
    it('scopes candidates to the indexed category.pathIds, never to category.id', async () => {
        const { call, calls } = harness({ reads: [[prod('p3', 'C')]] })
        await call({ id: 'o1', barcode: 'A', limit: 3 })

        assert.deepEqual(calls.reads[0].filter['category.pathIds'], 'cat1')
        assert.equal(calls.reads[0].filter['category.id'], undefined)
    })

    it('filters text search results too', async () => {
        const { call } = harness({
            searchResults: [prod('p1', 'A'), prod('p3', 'C')]
        })
        const res = await call({ id: 'o1', barcode: 'A', search: 'cola' })
        assert.deepEqual(res.products.map(p => p.id), ['p3'])
    })

    it('excludes a candidate that shares the cart product id under a different barcode', async () => {
        const { call } = harness({
            searchResults: [prod('p1', 'A-different')]
        })
        const res = await call({ id: 'o1', barcode: 'A', search: 'x' })
        assert.deepEqual(res.products, [])
    })
})
