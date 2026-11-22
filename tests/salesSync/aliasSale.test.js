import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import syncComaxSales from '../../server/api/comax_sale/sync.js'

const STATUS = { ACTIVE: 'active', PENDING: 'pending', DONE: 'done', CANCELED: 'canceled' }
const KINDS = { PRICE: 'price', PERCENT: 'percent', RECEIVE_AMOUNT: 'receive-amount', RECEIVE_PRICE: 'receive-price' }
const TYPES = { PRODUCT: 'product', CART: 'cart' }

function comaxSale(over = {}) {
    return {
        comaxId: 's1',
        name: 'family sale',
        promotionType: 1,
        quantity: 2,
        total: 9.1,
        fromDate: new Date('2020-01-01'),
        toDate: new Date('2030-01-01'),
        swActive: true,
        items: [{ Kod: '999', SwNotActive: false }],
        ...over
    }
}

// The catalog sells 111; Comax runs the promo on 999, one of its scan aliases.
// The alias has no product doc any more, so the sale has to land on 111.
function makeDL({ sale = comaxSale(), active = [], comaxRows = [], owners = [] } = {}) {
    const calls = { saleDocs: null }
    const DL = {
        ComaxSale: {
            read: async () => [sale],
            update: async () => ({})
        },
        Product: {
            constants: { STATUS: { ACTIVE: 'active' } },
            read: async () => active,
            bulkWrite: async () => ({ modifiedCount: 0 }),
            update: async () => ({ modifiedCount: 0 }),
            Model: {
                distinct: async () => [],
                find: () => ({ lean: async () => owners })
            }
        },
        ComaxProduct: {
            read: async () => comaxRows
        },
        Sale: {
            constants: { STATUS, KINDS, TYPES },
            read: async () => [],
            update: async () => ({ modifiedCount: 0 }),
            bulkWrite: async ({ docs }) => {
                calls.saleDocs = docs
                return { upsertedCount: 0, modifiedCount: 1 }
            }
        }
    }
    return { DL, calls }
}

const ACTIVE = [{ barcode: '111', prices: [{ domainId: 'd1', price: 5 }] }]
const OWNERS = [{ barcode: '111', scannableBarcodes: ['999'] }]

describe('comax sale barcode families', () => {
    it('stores a sale found on an alias on the product that owns it', async () => {
        const { DL, calls } = makeDL({
            active: ACTIVE,
            owners: OWNERS,
            comaxRows: [{ barcode: '999', comaxId: '999', trailingPrice: 0.3 }]
        })

        await syncComaxSales({}, { DL })

        const [sale] = calls.saleDocs
        assert.deepEqual(sale.barcodes, ['111'])
        // The deposit of the row Comax actually ran the promo on still counts,
        // so "2 ב-9.10" over 0.30-deposit bottles costs 9.70.
        assert.equal(sale.trailingTotal, 0.6)
        assert.equal(sale.price, 9.7)
    })

    it('keeps one barcode per family and the cheapest deposit of it', async () => {
        const { DL, calls } = makeDL({
            sale: comaxSale({ items: [{ Kod: '111' }, { Kod: '999' }] }),
            active: ACTIVE,
            owners: OWNERS,
            comaxRows: [
                { barcode: '111', comaxId: '111', trailingPrice: 0.6 },
                { barcode: '999', comaxId: '999', trailingPrice: 0.3 }
            ]
        })

        await syncComaxSales({}, { DL })

        const [sale] = calls.saleDocs
        assert.deepEqual(sale.barcodes, ['111'])
        assert.equal(sale.trailingTotal, 0.6)
    })

    it('leaves a barcode that belongs to no family alone', async () => {
        const { DL, calls } = makeDL({
            active: ACTIVE,
            owners: [{ barcode: '111', scannableBarcodes: ['888'] }],
            comaxRows: [{ barcode: '999', comaxId: '999', trailingPrice: 0 }]
        })

        await syncComaxSales({}, { DL })

        // 999 is not 111's alias: it is a different product, and 111 is not in
        // this sale. No family normalization may invent one.
        assert.equal(calls.saleDocs, null)
    })
})
