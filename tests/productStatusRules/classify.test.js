import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyProduct, normBarcode } from '../../server/scripts/applyProductStatusRules.js'

const ACTIVE = 'active', HIDDEN = 'hidden', ARCHIVED = 'archived'
const S = { ACTIVE, HIDDEN, ARCHIVED }
const img = { product: [{ main: true }] }
const prices = [{ domainId: 'd', price: 10 }]
const report = new Set(['7290000000001'])

const p = over => ({ barcode: '7290000000001', buyingPrice: 5, prices, images: img, ...over })

describe('classifyProduct', () => {
    it('active when buying price + image + in report', () => {
        assert.equal(classifyProduct(p(), report, S), ACTIVE)
    })

    it('hidden when image present but not in report', () => {
        assert.equal(classifyProduct(p({ barcode: '7290000000002' }), report, S), HIDDEN)
    })

    it('hidden when in report without an image', () => {
        assert.equal(classifyProduct(p({ images: { product: [] } }), report, S), HIDDEN)
    })

    it('archived when buying price is missing/zero even with image and report', () => {
        assert.equal(classifyProduct(p({ buyingPrice: 0 }), report, S), ARCHIVED)
        assert.equal(classifyProduct(p({ buyingPrice: null }), report, S), ARCHIVED)
    })

    it('archived when no regular price', () => {
        assert.equal(classifyProduct(p({ prices: [{ domainId: 'd', price: 0 }] }), report, S), ARCHIVED)
        assert.equal(classifyProduct(p({ prices: [] }), report, S), ARCHIVED)
    })
})

describe('normBarcode', () => {
    it('strips leading zeros from numeric barcodes only', () => {
        assert.equal(normBarcode('0762497844030'), '762497844030')
        assert.equal(normBarcode('7290000000001'), '7290000000001')
        assert.equal(normBarcode('ABC-1'), 'ABC-1')
    })
})
