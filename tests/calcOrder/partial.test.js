import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeProduct, makeSale, salesMap, calc, total } from './helpers.js'

// Rule 3: partial supply is charged at the relative sale price.
// Ordered 3 in a 3-for-10 sale, supplied 2 => 2 * (10/3) = 6.66.
// (pick_complete re-runs calcOrderSum with finalAmount = packed qty.)
const REGULAR = 15

function amountSale(over = {}) {
    return makeSale({ id: 'S1', kind: 'amount', amount: 3, price: 10, barcodes: ['B1'], ...over })
}

describe('partial supply (finalAmount)', () => {
    it('charges the relative sale price when partly supplied (ordered 3, packed 2)', () => {
        const r = calc(
            [makeProduct({ barcode: 'B1', price: REGULAR, amount: 3, finalAmount: 2 })],
            salesMap(amountSale())
        )
        assert.equal(total(r), 6.66)
    })

    it('charges the full bundle price when fully supplied', () => {
        const r = calc(
            [makeProduct({ barcode: 'B1', price: REGULAR, amount: 3, finalAmount: 3 })],
            salesMap(amountSale())
        )
        assert.equal(total(r), 10)
    })

    it('charges one relative unit when supplied 1 of 3', () => {
        const r = calc(
            [makeProduct({ barcode: 'B1', price: REGULAR, amount: 3, finalAmount: 1 })],
            salesMap(amountSale())
        )
        assert.equal(total(r), 3.33)
    })

    it('charges zero for a fully missing line', () => {
        const r = calc(
            [makeProduct({ barcode: 'B1', price: REGULAR, amount: 3, finalAmount: 0, missing: true })],
            salesMap(amountSale())
        )
        assert.equal(total(r), 0)
    })

    it('charges the relative sale price for a partly supplied regular sale', () => {
        const sale = makeSale({ id: 'S1', kind: 'price', amount: 1, price: 10, barcodes: ['B1'] })
        const r = calc(
            [makeProduct({ barcode: 'B1', price: REGULAR, amount: 5, finalAmount: 3 })],
            salesMap(sale)
        )
        assert.equal(total(r), 30)
    })
})
