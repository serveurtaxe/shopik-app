import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildBackfillFilter, pickBuyingPrice } from '../../server/api/comax_product/backfill_buying_price_api.js'

describe('buildBackfillFilter', () => {
    it('selects only products with a comaxId/barcode and no positive buying price', () => {
        const filter = buildBackfillFilter()
        assert.deepEqual(filter.comaxId, { $nin: ['', null] })
        assert.deepEqual(filter.barcode, { $nin: ['', null] })
        assert.deepEqual(filter.$or, [
            { buyingPrice: { $exists: false } },
            { buyingPrice: null },
            { buyingPrice: { $lte: 0 } }
        ])
    })
})

describe('pickBuyingPrice', () => {
    it('prefers the product matching comaxId', () => {
        const products = [
            { comaxId: 'B', price: 7 },
            { comaxId: 'A', price: 5 }
        ]
        assert.equal(pickBuyingPrice(products, 'A'), 5)
    })

    it('falls back to the first product when no id matches', () => {
        assert.equal(pickBuyingPrice([{ comaxId: 'X', price: 3 }], 'A'), 3)
    })

    it('returns null for empty results or non-positive prices', () => {
        assert.equal(pickBuyingPrice([], 'A'), null)
        assert.equal(pickBuyingPrice(undefined, 'A'), null)
        assert.equal(pickBuyingPrice([{ comaxId: 'A', price: 0 }], 'A'), null)
        assert.equal(pickBuyingPrice([{ comaxId: 'A', price: undefined }], 'A'), null)
    })
})
