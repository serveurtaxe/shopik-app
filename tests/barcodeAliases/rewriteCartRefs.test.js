import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteCartRefs } from '../../server/services/barcodeAliases/index.js'

// Minimal stand-in for the order/guest-cart model: it only has to honour the
// filters and arrayFilters the rewrite actually issues, plus id keyset paging.
function fakeModel(docs) {
    const calls = []

    // Supports the operators the rewrite issues: plain equality, $gt and $in.
    const one = (actual, wanted) => {
        if (wanted && typeof wanted === 'object' && !Array.isArray(wanted)) {
            if (wanted.$in) return wanted.$in.includes(actual)
            if (wanted.$gt !== undefined) return actual > wanted.$gt
        }
        return actual === wanted
    }
    const matches = (doc, filter) => Object.entries(filter).every(([key, value]) => {
        if (key === '$or') return value.some(sub => matches(doc, sub))
        if (key === 'id') return one(doc.id, value)
        if (key === 'cart.barcode') return doc.cart.some(item => one(item.barcode, value))
        if (key === 'cart.id') return doc.cart.some(item => one(item.id, value))
        return false
    })

    return {
        docs,
        calls,
        find(filter) {
            const found = docs.filter(doc => matches(doc, filter)).sort((a, b) => a.id.localeCompare(b.id))
            let cap = 0
            const chain = {
                sort: () => chain,
                limit: n => { cap = n; return chain },
                lean: async () => found.slice(0, cap || found.length)
            }
            return chain
        },
        async updateMany(filter, update, options = {}) {
            calls.push({ filter, update, options })
            let modifiedCount = 0
            for (const doc of docs) {
                if (!matches(doc, filter)) continue
                let changed = 0
                for (const item of doc.cart) {
                    const hit = (options.arrayFilters || []).every(rule => {
                        const [key, wanted] = Object.entries(rule)[0]
                        return item[key.replace(/^item\./, '')] === wanted
                    })
                    if (!hit) continue
                    for (const [key, value] of Object.entries(update.$set))
                        if (key.startsWith('cart.$[item].')) item[key.split('.').pop()] = value
                    changed++
                }
                modifiedCount += changed
            }
            return { modifiedCount }
        }
    }
}

const MAPPING = { barcode: '2222222222222', id: 'p-dup', ownerBarcode: '1111111111111', ownerId: 'p-main' }

describe('order and cart reference rewrite', () => {
    it('points a scanned barcode line at the owning product and keeps the snapshot', async () => {
        const Model = fakeModel([
            { id: 'o1', cart: [{ id: 'p-dup', barcode: '2222222222222', name: 'ביצים 12', price: 12, image: 'x.png' }] }
        ])

        assert.equal(await rewriteCartRefs(Model, [MAPPING]), 1)
        assert.deepEqual(Model.docs[0].cart[0], {
            id: 'p-main',
            barcode: '1111111111111',
            name: 'ביצים 12',
            price: 12,
            image: 'x.png'
        })
    })

    it('rewrites a line that only carries the old product id', async () => {
        const Model = fakeModel([
            { id: 'o1', cart: [{ id: 'p-dup', name: 'ביצים 12', count: 2 }]
            }
        ])

        assert.equal(await rewriteCartRefs(Model, [MAPPING]), 1)
        assert.equal(Model.docs[0].cart[0].barcode, '1111111111111')
        assert.equal(Model.docs[0].cart[0].id, 'p-main')
        assert.equal(Model.docs[0].cart[0].count, 2)
    })

    it('leaves other lines of the same order alone', async () => {
        const Model = fakeModel([
            {
                id: 'o1',
                cart: [
                    { id: 'p-dup', barcode: '2222222222222' },
                    { id: 'p-other', barcode: '5555555555555' }
                ]
            }
        ])

        assert.equal(await rewriteCartRefs(Model, [MAPPING]), 1)
        assert.deepEqual(Model.docs[0].cart[1], { id: 'p-other', barcode: '5555555555555' })
    })

    it('touches only id and barcode, and keeps paging until the matches run out', async () => {
        const docs = Array.from({ length: 140 }, (_, i) => ({
            id: `o${String(i).padStart(3, '0')}`,
            cart: [{ id: 'p-dup', barcode: '2222222222222' }]
        }))
        const Model = fakeModel(docs)

        assert.equal(await rewriteCartRefs(Model, [MAPPING]), 140)
        for (const doc of docs) {
            assert.equal(doc.cart[0].id, 'p-main')
            assert.equal(doc.cart[0].barcode, '1111111111111')
        }
        for (const call of Model.calls)
            assert.deepEqual(Object.keys(call.update.$set).sort(), ['cart.$[item].barcode', 'cart.$[item].id'])
    })

    it('does nothing without a model or a mapping', async () => {
        assert.equal(await rewriteCartRefs(null, [MAPPING]), 0)
        assert.equal(await rewriteCartRefs(fakeModel([]), []), 0)
    })
})
