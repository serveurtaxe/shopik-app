import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getProductImageUrl, getProductImageUrls } from '../../common/functions/productImageUrl.js'

describe('product image URLs', () => {
    it('builds main and alternate paths from the product id', () => {
        const urls = getProductImageUrls('p1', [{ main: true }, { main: false }, { main: false }], 'm')

        assert.equal(urls.length, 3)
        assert.ok(urls[0].endsWith('/images/products/p1/m.webp'))
        assert.ok(urls[1].endsWith('/images/products/p1/alt-1/m.webp'))
        assert.ok(urls[2].endsWith('/images/products/p1/alt-2/m.webp'))
    })

    it('supports a keyed size directly', () => {
        assert.ok(getProductImageUrl('p1', 'xl', 'alt-1').endsWith('/images/products/p1/alt-1/xl.webp'))
    })

    it('returns no URLs when the product has no images', () => {
        assert.deepEqual(getProductImageUrls('p1', [], 'm'), [])
    })
})
