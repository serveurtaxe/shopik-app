import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeProduct, makeSale, salesMap, calc, total } from './helpers.js'

// Rule 2: amount sale (3 for 10) applies only when enough units were bought.
// Below the threshold the customer pays the full regular price.
const REGULAR = 15

function amountSale(over = {}) {
    return makeSale({ id: 'S1', kind: 'amount', amount: 3, price: 10, barcodes: ['B1'], ...over })
}

describe('amount (N-for-M) sales', () => {
    it('charges full price when buying below the threshold (2 of 3-for-10)', () => {
        const r = calc([makeProduct({ barcode: 'B1', price: REGULAR, amount: 2 })], salesMap(amountSale()))
        assert.equal(total(r), 2 * REGULAR)
    })

    it('charges the bundle price at exactly the threshold (3 for 10)', () => {
        const r = calc([makeProduct({ barcode: 'B1', price: REGULAR, amount: 3 })], salesMap(amountSale()))
        assert.equal(total(r), 10)
    })

    it('charges bundle + one regular unit for 4 (3-for-10)', () => {
        const r = calc([makeProduct({ barcode: 'B1', price: REGULAR, amount: 4 })], salesMap(amountSale()))
        assert.equal(total(r), 10 + REGULAR)
    })

    it('charges two bundles for 6', () => {
        const r = calc([makeProduct({ barcode: 'B1', price: REGULAR, amount: 6 })], salesMap(amountSale()))
        assert.equal(total(r), 20)
    })

    it('charges two bundles + one regular unit for 7', () => {
        const r = calc([makeProduct({ barcode: 'B1', price: REGULAR, amount: 7 })], salesMap(amountSale()))
        assert.equal(total(r), 20 + REGULAR)
    })
})
