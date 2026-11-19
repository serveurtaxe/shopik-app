import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildProduct, syncProductFamilies } from '../../server/api/comax_product/sync.js'

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden', ARCHIVED: 'archived' }
const CONSTANTS = {
    STATUS,
    UNIT: { ITEM: 'item', WEIGHT: 'weight' },
    BASE_UNIT: { UNIT: 'unit', KG: 'kg' }
}

const EGGS = { id: 'nc:206:2027', name: 'ביצים', parentIds: ['nc:206'] }
const LOOKUP = {
    mapByCode: new Map([['10110', EGGS.id]]),
    categoriesById: new Map([[EGGS.id, EGGS]]),
    flagsByCode: new Map([['10110', { categoryActive: true, showOnSite: true, requireKashrut: false }]]),
    hasMap: true
}

// Product.find stand-in: enough to honour the filters the family pass uses
// ('scannableBarcodes.0' exists, barcode keyset) plus select/sort/limit/lean.
function fakeProductModel(docs) {
    const calls = []
    return {
        calls,
        find(filter = {}) {
            calls.push(filter)
            const after = filter.barcode?.$gt
            const found = (docs || [])
                .filter(doc => (doc.scannableBarcodes || []).length)
                .filter(doc => !after || doc.barcode > after)
                .sort((a, b) => String(a.barcode).localeCompare(String(b.barcode)))
            let cap = 0
            const chain = {
                select: () => chain,
                sort: () => chain,
                limit: n => { cap = n; return chain },
                lean: async () => found.slice(0, cap || found.length)
            }
            return chain
        }
    }
}

function makeDL({ owners = [], comaxRows = [] }) {
    const Model = fakeProductModel(owners)
    const writes = []
    return {
        writes,
        calls: Model.calls,
        DL: {
            Product: {
                Model,
                constants: CONSTANTS,
                bulkWrite: async ({ docs, getFilter, getUpsert, getUpdate }) => {
                    for (const doc of docs)
                        writes.push({ filter: getFilter(doc), upsert: getUpsert(doc), update: getUpdate(doc) })
                    return { modifiedCount: docs.length }
                }
            },
            ComaxProduct: {
                read: async (filter = {}) => (comaxRows || []).filter(row => (filter.barcode?.$in || []).includes(row.barcode))
            }
        }
    }
}

const owner = (barcode, scannableBarcodes, overrides = {}) => ({
    id: `p-${barcode}`,
    barcode,
    scannableBarcodes,
    images: { product: [{ url: 'https://example.com/a.jpg' }] },
    prices: [{ domainId: 'dom', price: 12 }],
    buyingPrice: 8,
    ...overrides
})

const comaxRow = (barcode, overrides = {}) => ({
    barcode,
    price: 12,
    buyingPrice: 8,
    storeIds: ['store-a'],
    salesLastDays: 10,
    showInWeb: true,
    archived: false,
    subGroupCode: '10110',
    ...overrides
})

const runPass = (options, overrides = {}) => syncProductFamilies({
    select: {},
    defaultDomainId: 'dom',
    categoryLookup: LOOKUP,
    enforceBuyingPrice: false,
    ...options,
    ...overrides
})

describe('comax sync family pass', () => {
    it('writes the stock union and the summed sales of the family', async () => {
        const { writes, DL } = makeDL({
            owners: [owner('1111111111111', ['2222222222222'])],
            comaxRows: [
                comaxRow('1111111111111', { storeIds: [], salesLastDays: 519 }),
                comaxRow('2222222222222', { storeIds: ['store-b'], salesLastDays: 207 })
            ]
        })

        assert.deepEqual(await runPass({ DL }), { owners: 1, updated: 1 })
        assert.equal(writes.length, 1)
        assert.deepEqual(writes[0].filter, { barcode: '1111111111111' })
        // Never upserts: an alias owner already exists or the family is unknown.
        assert.equal(writes[0].upsert, false)
        assert.deepEqual(writes[0].update.$set, {
            status: STATUS.ACTIVE,
            storeIds: ['store-b'],
            totalSalesUnits: 726
        })
    })

    it('pages by barcode so a large family set neither loops nor skips an owner', async () => {
        const { writes, calls, DL } = makeDL({
            owners: [owner('1111111111111', ['2222222222222']), owner('4444444444444', ['5555555555555'])],
            comaxRows: [comaxRow('1111111111111'), comaxRow('4444444444444')]
        })

        assert.deepEqual(await runPass({ DL }, { batchSize: 1 }), { owners: 2, updated: 2 })
        assert.deepEqual(writes.map(w => w.filter.barcode), ['1111111111111', '4444444444444'])
        // Three reads: two owners and the empty page that ends the loop.
        assert.equal(calls.length, 3)
        assert.deepEqual(calls[1].barcode, { $gt: '1111111111111' })
    })

    it('leaves a family with no Comax row of its own untouched', async () => {
        const { writes, DL } = makeDL({
            owners: [owner('1111111111111', ['2222222222222'])],
            comaxRows: [comaxRow('9999999999999')]
        })

        assert.deepEqual(await runPass({ DL }), { owners: 1, updated: 0 })
        assert.deepEqual(writes, [])
    })
})

describe('comax sync name lock', () => {
    const existing = { images: { product: [{ url: 'x.jpg' }] } }
    const comax = { barcode: '1111111111111', name: 'שם מהספק', price: 12, buyingPrice: 8, showInWeb: true }
    const DL = { Product: { constants: CONSTANTS } }

    it('copies the supplier name when nothing locked it', () => {
        assert.equal(buildProduct(comax, DL, 'dom', existing, false, LOOKUP).name, 'שם מהספק')
    })

    it('writes every other field but never replaces a locked name', () => {
        const product = buildProduct(
            { ...comax, name: 'שם חדש מהספק' },
            DL, 'dom', { ...existing, nameLocked: true, name: 'שם שבחרנו' }, false, LOOKUP
        )

        assert.equal('name' in product, false)
        assert.equal(product.status, STATUS.ACTIVE)
        assert.equal(product.barcode, '1111111111111')
    })
})
