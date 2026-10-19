import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeProduct, makeSale, salesMap, calc, total, splitByProduct } from './helpers.js'

// Percent sales: `percent` is the discount (20 = 20% off), applied per unit.
// `limit` caps how many units get the discount — the rest pay regular price.
function percentSale(over = {}) {
    return makeSale({ id: 'S1', kind: 'percent', amount: 1, price: undefined, percent: 20, barcodes: ['B1'], ...over })
}

describe('percent sales', () => {
    it('applies the discount to one unit (20% off 15)', () => {
        const r = calc([makeProduct({ barcode: 'B1', price: 15, amount: 1 })], salesMap(percentSale()))
        assert.equal(total(r), 12)
    })

    it('applies the discount to every unit when there is no limit', () => {
        const r = calc([makeProduct({ barcode: 'B1', price: 15, amount: 3 })], salesMap(percentSale()))
        assert.equal(total(r), 36)
        assert.equal(r.totals.sumBeforeDiscounts, 45)
        assert.equal(r.totals.salesDiscount, 9)
    })

    it('charges regular price above the limit (limit 2, buy 3)', () => {
        const p = makeProduct({ id: 'p1', barcode: 'B1', price: 15, amount: 3 })
        const r = calc([p], salesMap(percentSale({ limit: 2 })))
        assert.equal(total(r), 2 * 12 + 15)
        assert.deepEqual(splitByProduct(r), { p1: { sale: 24, regular: 15 } })
    })

    it('shares one limit pool across products (cheapest units first)', () => {
        const cart = [
            makeProduct({ id: 'pa', barcode: 'A', price: 12, amount: 1 }),
            makeProduct({ id: 'pb', barcode: 'B', price: 18, amount: 2 }),
        ]
        const sale = percentSale({ barcodes: ['A', 'B'], limit: 2 })
        const r = calc(cart, salesMap(sale))
        // 9.6 (A discounted) + 14.4 (one B discounted) + 18 (one B regular)
        assert.equal(total(r), 42)
        assert.deepEqual(splitByProduct(r), {
            pa: { sale: 9.6, regular: 0 },
            pb: { sale: 14.4, regular: 18 },
        })
    })

    it('discounts only packed units on partial supply (ordered 5, packed 3)', () => {
        const r = calc(
            [makeProduct({ barcode: 'B1', price: 15, amount: 5, finalAmount: 3 })],
            salesMap(percentSale())
        )
        assert.equal(total(r), 3 * 12)
    })

    it('supports amount > 1 as a multi-unit threshold (2+ units at 10% off)', () => {
        const sale = percentSale({ amount: 2, percent: 10 })
        const two = calc([makeProduct({ barcode: 'B1', price: 20, amount: 2 })], salesMap(sale))
        assert.equal(total(two), 2 * 18)
        const three = calc([makeProduct({ barcode: 'B1', price: 20, amount: 3 })], salesMap(sale))
        assert.equal(total(three), 2 * 18 + 20)
    })
})
