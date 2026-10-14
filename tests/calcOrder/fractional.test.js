import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeProduct, makeSale, salesMap, calc, total, splitByProduct } from './helpers.js'

// Per-unit sales (price/percent with amount 1) have no bundle threshold: a
// fractional remainder the picker couldn't round to — e.g. 0.256kg over the
// ordered 3kg of cucumbers on a 1.9 sale — is charged at the sale price,
// not punished with the regular price.
function kiloSale(over = {}) {
    return makeSale({ id: 'S1', kind: 'price', amount: 1, price: 1.9, barcodes: ['CUC'], ...over })
}

function weightProduct(over = {}) {
    return makeProduct({
        barcode: 'CUC', price: 6.9, unit: { type: 'weight', baseUnit: 'kg' }, ...over,
    })
}

describe('fractional remainder at sale price', () => {
    it('charges the sale price for the fractional remainder (ordered 3, packed 3.256)', () => {
        const p = weightProduct({ id: 'cuc', amount: 3, finalAmount: 3.256 })
        const r = calc([p], salesMap(kiloSale()))
        // 3 x 1.9 + 0.256 x 1.9 (0.49) — nothing at the 6.9 regular price
        assert.equal(total(r), 6.19)
        assert.deepEqual(splitByProduct(r), { cuc: { sale: 6.19, regular: 0 } })
    })

    it('charges the sale price when the packed amount is entirely fractional', () => {
        const r = calc(
            [weightProduct({ barcode: 'CUC', price: 6.9, amount: 3, finalAmount: 0.5 })],
            salesMap(kiloSale())
        )
        assert.equal(total(r), 0.95)
    })

    it('still respects an explicit limit (limit 3, packed 3.256)', () => {
        const p = weightProduct({ id: 'cuc', amount: 3, finalAmount: 3.256 })
        const r = calc([p], salesMap(kiloSale({ limit: 3 })))
        // 3kg at sale, the 0.256 over the limit at regular price
        assert.equal(total(r), 7.47)
        assert.deepEqual(splitByProduct(r), { cuc: { sale: 5.7, regular: 1.77 } })
    })

    it('does not extend the fractional treatment to bundle (amount) sales', () => {
        const sale = makeSale({ id: 'S1', kind: 'amount', amount: 3, price: 10, barcodes: ['CUC'] })
        const r = calc(
            [weightProduct({ barcode: 'CUC', price: 15, amount: 2.5, finalAmount: 2.5 })],
            salesMap(sale)
        )
        // below the 3-unit bundle threshold: full regular price
        assert.equal(total(r), 2.5 * 15)
    })

    it('discounts a fractional remainder on percent sales too', () => {
        const sale = makeSale({ id: 'S1', kind: 'percent', amount: 1, price: undefined, percent: 20, barcodes: ['CUC'] })
        const p = weightProduct({ id: 'cuc', amount: 3, finalAmount: 3.256 })
        const r = calc([p], salesMap(sale))
        // 3 x 5.52 + 0.256 x 5.52 (1.41)
        assert.equal(total(r), 17.97)
        assert.deepEqual(splitByProduct(r), { cuc: { sale: 17.97, regular: 0 } })
    })

    it('still bundles over-supplied packed units (ordered 5, packed 8, 4-for-11)', () => {
        const sale = makeSale({ id: 'S1', kind: 'price', amount: 4, price: 11, barcodes: ['B1'] })
        const r = calc(
            [makeProduct({ barcode: 'B1', price: 3.9, amount: 5, finalAmount: 8 })],
            salesMap(sale)
        )
        assert.equal(total(r), 22)
    })
})
