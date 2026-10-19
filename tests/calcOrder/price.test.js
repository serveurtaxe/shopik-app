import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeProduct, makeSale, salesMap, calc, total, splitByProduct } from './helpers.js'

// Rule 1: regular sale (10 instead of 15 for one unit) applies up to the
// sale limit — units above the limit are charged at the regular price.
const REGULAR = 15
const SALE_PRICE = 10

function priceSale(over = {}) {
    return makeSale({ id: 'S1', kind: 'price', amount: 1, price: SALE_PRICE, barcodes: ['B1'], ...over })
}

describe('regular (price) sales', () => {
    it('charges the sale price for one unit', () => {
        const r = calc([makeProduct({ barcode: 'B1', price: REGULAR, amount: 1 })], salesMap(priceSale()))
        assert.equal(total(r), 10)
    })

    it('charges the sale price for every unit when there is no limit', () => {
        const r = calc([makeProduct({ barcode: 'B1', price: REGULAR, amount: 3 })], salesMap(priceSale()))
        assert.equal(total(r), 30)
    })

    it('charges regular price above the limit (limit 2, buy 3)', () => {
        const p = makeProduct({ id: 'p1', barcode: 'B1', price: REGULAR, amount: 3 })
        const r = calc([p], salesMap(priceSale({ limit: 2 })))
        assert.equal(total(r), 2 * SALE_PRICE + 1 * REGULAR)
        assert.deepEqual(splitByProduct(r), { p1: { sale: 20, regular: 15 } })
    })

    it('charges all units at sale price when amount equals the limit', () => {
        const r = calc(
            [makeProduct({ barcode: 'B1', price: REGULAR, amount: 2 })],
            salesMap(priceSale({ limit: 2 }))
        )
        assert.equal(total(r), 20)
    })

    it('ignores products whose barcode is not in the sale', () => {
        const r = calc(
            [makeProduct({ barcode: 'OTHER', price: REGULAR, amount: 2 })],
            salesMap(priceSale())
        )
        assert.equal(total(r), 2 * REGULAR)
    })
})
