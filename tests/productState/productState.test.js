import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getProductState } from '../../common/functions/productState.js'

const SALE = { amount: 1, kind: 'percent', percent: 15 }

// The two axes form a 2x2. `action` is the cart axis (border only), `price`
// is the sale axis (border + button + price). The button colour intentionally
// ignores the cart axis.
const MATRIX = [
    { name: 'regular', amount: 0, sale: null, action: 'regular', price: 'regular' },
    { name: 'in cart', amount: 3, sale: null, action: 'inCart', price: 'regular' },
    { name: 'sale', amount: 0, sale: SALE, action: 'regular', price: 'sale' },
    { name: 'in cart + sale', amount: 12, sale: SALE, action: 'inCart', price: 'sale' },
]

describe('getProductState', () => {
    for (const { name, amount, sale, action, price } of MATRIX) {
        it(`maps ${name} to action=${action} price=${price}`, () => {
            const state = getProductState({ amount, sale })
            assert.equal(state.action, action)
            assert.equal(state.price, price)
            assert.equal(state.inCart, amount > 0)
            assert.equal(state.onSale, !!sale)
        })
    }

    it('never reports action="sale" — sale is the price axis', () => {
        // Guards against the old redundant state, which overlapped with
        // data-price and made the border ambiguous.
        for (const { amount, sale } of MATRIX) {
            assert.notEqual(getProductState({ amount, sale }).action, 'sale')
        }
    })

    it('treats missing, undefined and zero amounts as not in cart', () => {
        for (const amount of [undefined, null, 0, '', NaN]) {
            assert.equal(getProductState({ amount, sale: null }).inCart, false)
            assert.equal(getProductState({ amount, sale: null }).action, 'regular')
        }
    })

    it('accepts numeric strings as in cart', () => {
        assert.equal(getProductState({ amount: '2', sale: null }).inCart, true)
    })

    it('defaults to regular with no arguments', () => {
        assert.equal(getProductState().action, 'regular')
        assert.equal(getProductState().price, 'regular')
    })
})