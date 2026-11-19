import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pick_complete from '../../server/api/order/ops/pick_complete.js'

const ADMIN = { id: 'a1', name: { first: 'Av', last: 'Admin' } }

// `read` pages at 30 docs by default. A cart with more distinct sale ids than
// that used to lose the tail: the sales never reached the pricing engine and
// the lines were charged full price (order 100336 was overcharged 68.50 this way).
const SALE = {
    id: 's1',
    kind: 'price',
    amount: 2,
    price: 15,
    barcodes: ['111', '112'],
    limit: 0,
    status: 'active',
    name: 'ביחד 2ב15',
    displayName: 'ביחד 2ב15'
}

const line = (barcode, saleIds, over = {}) => ({
    id: barcode,
    name: `product ${barcode}`,
    barcode,
    amount: 1,
    finalAmount: 1,
    price: 10,
    vat: true,
    saleIds,
    unit: { type: 'item', baseUnit: 'unit', minAmount: 1, step: 1 },
    priceDistribution: [{ type: 'regular', totalSum: 10, amount: 1, saleName: '', salePrice: 10 }],
    totalSum: 10,
    regularSum: 10,
    saleSum: 0,
    missing: false,
    ...over
})

function harness({ cart, sales }) {
    const calls = { saleReads: [], updates: [] }
    const order = { id: 'o1', status: 'picking', picker: { adminId: ADMIN.id }, cart, coupons: [] }

    const DL = {
        Order: {
            readById: async () => order,
            updateOne: async (filter, update) => {
                calls.updates.push(update)
                return true
            }
        },
        Owner: { updateOne: async () => true },
        PickHistory: { create: async () => ({}) },
        Timeline: { constants: { EVENT_TYPES: { ORDER_STATUS_UPDATE: 'order_status_update' } } },
        Sale: {
            defaultSelect: undefined,
            read: async (filter, select, options) => {
                calls.saleReads.push({ filter, select, options })
                return sales
            }
        }
    }
    const utils = { data: { timeline: { record: async () => {}, adminActor: () => ({}) } } }

    return { DL, utils, calls }
}

describe('pick_complete reads every sale the cart references', () => {
    it('asks for the whole id list instead of the default 30-doc page', async () => {
        const cart = [line('111', ['s1']), line('112', ['s1'])]
        const { DL, utils, calls } = harness({ cart, sales: [SALE] })

        await pick_complete({ id: 'o1' }, { DL, _admin: ADMIN, utils })

        assert.equal(calls.saleReads.length, 1)
        assert.deepEqual(calls.saleReads[0].filter, { id: { $in: ['s1'] } })
        assert.equal(calls.saleReads[0].options.limit, 0)
    })

    it('prices the bundle at the sale price and writes it to the order', async () => {
        const cart = [line('111', ['s1']), line('112', ['s1'])]
        const { DL, utils, calls } = harness({ cart, sales: [SALE] })

        await pick_complete({ id: 'o1' }, { DL, _admin: ADMIN, utils })

        const written = calls.updates[0].$set
        assert.equal(written.sum, 15)
        assert.equal(written.finalSum, 15)
        assert.equal(written.finalSumNoCoupon, 15)
        assert.equal(written.cart[0].saleSum + written.cart[1].saleSum, 15)
    })

    it('keeps the regular price when a sale really is gone', async () => {
        const cart = [line('111', ['s1']), line('112', ['s1'])]
        const { DL, utils, calls } = harness({ cart, sales: [] })

        await pick_complete({ id: 'o1' }, { DL, _admin: ADMIN, utils })

        assert.equal(calls.updates[0].$set.sum, 20)
    })
})
