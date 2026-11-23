import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import enrichCart, { enrichOrders } from '../../server/utils/data/enrichCart.js'

const OWNER = {
    id: 'p-main',
    barcode: '1111111111111',
    scannableBarcodes: ['2222222222222'],
    images: { product: [{ main: true, sizes: { l: 'https://example.com/a.webp' } }] },
    label: 'מותג',
    producer: 'מפעל',
    netContentText: '12 יח׳',
    category: { id: 'nc:206:2027', title: 'ביצים', pathIds: ['nc:206'] },
    storageType: 'regular',
    picking: { minShelflife: 3 },
    unit: { type: 'item', baseUnit: 'unit', minAmount: 1, step: 1 }
}

function makeDL(products = [OWNER]) {
    const calls = []
    return {
        calls,
        DL: {
            Product: {
                Model: {
                    find: (query, select) => {
                        calls.push({ query, select })
                        return { lean: async () => products }
                    }
                }
            }
        }
    }
}

// An order placed before the import: the line names the alias barcode, and the
// doc that used to hold its image/unit was folded into the owner.
const line = (over = {}) => ({
    id: 'p-deleted',
    barcode: '2222222222222',
    name: 'ביצים 12',
    price: 12,
    amount: 1,
    ...over
})

describe('enrichCart', () => {
    it('fills a line whose barcode is now an alias from the product that owns it', async () => {
        const { DL } = makeDL()
        const order = { cart: [line()] }

        await enrichCart(order, DL)

        const [item] = order.cart
        assert.deepEqual(item.images, OWNER.images)
        assert.equal(item.label, 'מותג')
        assert.equal(item.category.id, 'nc:206:2027')
        assert.equal(item.unit.step, 1)
        assert.equal(item.unit.minAmount, 1)
    })

    it('asks Mongo for the alias, not just the line barcode', async () => {
        const { DL, calls } = makeDL()
        await enrichCart({ cart: [line()] }, DL)

        const clauses = calls[0].query.$or
        assert.ok(clauses.some(clause => clause.scannableBarcodes?.$in?.includes('2222222222222')))
        assert.equal(calls[0].select.scannableBarcodes, 1)
    })

    it('gives the pick screen the family barcodes in the pick response too', async () => {
        // pick_item answers with the order through enrichCart and the ops screen
        // swaps it into state — the next scan reads this list.
        const { DL } = makeDL()
        const order = {
            cart: [line({
                id: 'p-main',
                barcode: '1111111111111',
                images: { product: [{ main: true }] },
                storageType: 'regular',
                netContentText: '12 יח׳',
                unit: { type: 'item', baseUnit: 'unit', minAmount: 1, step: 1 }
            })]
        }

        await enrichCart(order, DL)

        assert.deepEqual(order.cart[0].scannableBarcodes, ['2222222222222'])
    })

    it('returns the order untouched when the line matches nothing', async () => {
        const { DL } = makeDL([])
        const order = { cart: [line()] }

        assert.equal(await enrichCart(order, DL), order)
        assert.deepEqual(order.cart[0], line())
    })

    it('does the same for a list of orders', async () => {
        const { DL } = makeDL()
        const orders = [{ cart: [line()] }, { cart: [] }]

        await enrichOrders(orders, DL)

        assert.equal(orders[0].cart[0].unit.step, 1)
        assert.deepEqual(orders[1], { cart: [] })
    })

    it('gives the pick screen the family barcodes of a complete line', async () => {
        const { DL, calls } = makeDL()
        // A fresh order: every display field is in the snapshot, so nothing used
        // to be read — but the scan modal still needs the aliases of the product.
        const item = line({
            id: 'p-main',
            barcode: '1111111111111',
            images: { product: [{ main: true }] },
            storageType: 'regular',
            netContentText: '12 יח׳',
            unit: { type: 'item', baseUnit: 'unit', minAmount: 1, step: 1 }
        })
        const orders = [{ cart: [item] }]

        await enrichOrders(orders, DL)

        assert.deepEqual(orders[0].cart[0].scannableBarcodes, ['2222222222222'])
        assert.equal(calls.length, 1)
    })
})
