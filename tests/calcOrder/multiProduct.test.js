import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeProduct, makeSale, salesMap, calc, total, splitByProduct } from './helpers.js'

// Multi-product amount sales: a 3-for-10 bundle spread over different
// products splits the agora leftover (3.33 + 3.33 + 3.34 = 10).
function bundleSale() {
    return makeSale({ id: 'S1', kind: 'amount', amount: 3, price: 10, barcodes: ['A', 'B', 'C'] })
}

describe('multi-product amount sales', () => {
    it('splits one bundle over 3 different products (3.33/3.33/3.34)', () => {
        const cart = [
            makeProduct({ id: 'pa', barcode: 'A', price: 12, amount: 1 }),
            makeProduct({ id: 'pb', barcode: 'B', price: 18, amount: 1 }),
            makeProduct({ id: 'pc', barcode: 'C', price: 25, amount: 1 }),
        ]
        const r = calc(cart, salesMap(bundleSale()))
        assert.equal(total(r), 10)
        const perUnit = Object.values(splitByProduct(r)).map((s) => s.sale).sort()
        assert.deepEqual(perUnit, [3.33, 3.33, 3.34])
    })

    it('charges full price when the bundle threshold is not met across products', () => {
        const cart = [
            makeProduct({ id: 'pa', barcode: 'A', price: 12, amount: 1 }),
            makeProduct({ id: 'pb', barcode: 'B', price: 18, amount: 1 }),
        ]
        const r = calc(cart, salesMap(bundleSale()))
        assert.equal(total(r), 12 + 18)
    })

    it('charges bundle + regular for the leftover unit (2xA + 2xB)', () => {
        const cart = [
            makeProduct({ id: 'pa', barcode: 'A', price: 12, amount: 2 }),
            makeProduct({ id: 'pb', barcode: 'B', price: 18, amount: 2 }),
        ]
        const r = calc(cart, salesMap(bundleSale()))
        // cheapest units fill the bundle first; the leftover (most expensive
        // unit) is charged at its regular price.
        const split = splitByProduct(r)
        const saleTotal = split.pa.sale + split.pb.sale
        const regularTotal = split.pa.regular + split.pb.regular
        assert.equal(saleTotal, 10)
        assert.equal(regularTotal, 18)
        assert.equal(total(r), 28)
    })
})
