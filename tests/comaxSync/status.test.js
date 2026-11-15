import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { explainStatus, deriveStatus, STATUS_REASON } from '../../server/api/comax_product/status.js'

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden', ARCHIVED: 'archived' }

const IMAGE = { images: { product: [{ url: 'https://example.com/a.jpg' }] } }
const EDGE = (overrides = {}) => ({
    barcode: '7290000000000',
    price: 10,
    buyingPrice: 6,
    showInWeb: true,
    storeIds: ['store-a'],
    ...overrides
})

function explain({ comax = {}, existing = IMAGE, flags, enforceBuyingPrice = false } = {}) {
    return explainStatus({
        comax: EDGE(comax),
        existing,
        flags,
        status: STATUS,
        enforceBuyingPrice
    })
}

describe('product status ladder', () => {
    it('is active when every rule passes', () => {
        assert.deepEqual(explain(), { status: STATUS.ACTIVE, reasons: [] })
    })

    it('archives a Comax-archived item', () => {
        const result = explain({ comax: { archived: true } })
        assert.equal(result.status, STATUS.ARCHIVED)
        assert.deepEqual(result.reasons, [STATUS_REASON.COMAX_ARCHIVED])
    })

    it('archives an item with no selling price', () => {
        const result = explain({ comax: { price: 0 } })
        assert.equal(result.status, STATUS.ARCHIVED)
        assert.deepEqual(result.reasons, [STATUS_REASON.NO_PRICE])
    })

    it('archives an item with no buying price only when the rule is enforced', () => {
        const enforced = explain({ comax: { buyingPrice: 0 }, enforceBuyingPrice: true })
        assert.equal(enforced.status, STATUS.ARCHIVED)
        assert.deepEqual(enforced.reasons, [STATUS_REASON.NO_BUYING_PRICE])

        const relaxed = explain({ comax: { buyingPrice: 0 }, enforceBuyingPrice: false })
        assert.equal(relaxed.status, STATUS.ACTIVE)
        assert.deepEqual(relaxed.reasons, [])
    })

    it('hides an item with no stored image', () => {
        const result = explain({ existing: { images: { product: [] } } })
        assert.equal(result.status, STATUS.HIDDEN)
        assert.deepEqual(result.reasons, [STATUS_REASON.NO_IMAGE])
    })

    it('hides an item with an empty store list, but not a missing one', () => {
        const empty = explain({ comax: { storeIds: [] } })
        assert.equal(empty.status, STATUS.HIDDEN)
        assert.deepEqual(empty.reasons, [STATUS_REASON.NO_STORES])

        const missing = explain({ comax: { storeIds: undefined } })
        assert.equal(missing.status, STATUS.ACTIVE)
        assert.deepEqual(missing.reasons, [])
    })

    it('hides an item that Comax does not show in the web', () => {
        const result = explain({ comax: { showInWeb: false } })
        assert.equal(result.status, STATUS.HIDDEN)
        assert.deepEqual(result.reasons, [STATUS_REASON.NOT_IN_WEB])
    })

    it('hides an item in an inactive category', () => {
        const result = explain({ flags: { categoryActive: false } })
        assert.equal(result.status, STATUS.HIDDEN)
        assert.deepEqual(result.reasons, [STATUS_REASON.CATEGORY_INACTIVE])
    })

    it('hides an item in a sub-group marked hide on site', () => {
        const result = explain({ flags: { showOnSite: false } })
        assert.equal(result.status, STATUS.HIDDEN)
        assert.deepEqual(result.reasons, [STATUS_REASON.SUBGROUP_HIDDEN])
    })

    it('hides an item in a kashrut-required sub-group with invalid kashrut', () => {
        const result = explain({
            existing: { ...IMAGE, kashrut: { rabbinates: [{ code: '99999' }] } },
            flags: { requireKashrut: true }
        })
        assert.equal(result.status, STATUS.HIDDEN)
        assert.deepEqual(result.reasons, [STATUS_REASON.KASHRUT_MISSING])
    })

    it('keeps an item with a valid rabbinate code active', () => {
        const result = explain({
            existing: { ...IMAGE, kashrut: { rabbinates: [{ code: '67085' }] } },
            flags: { requireKashrut: true }
        })
        assert.deepEqual(result, { status: STATUS.ACTIVE, reasons: [] })
    })

    it('reports every violated rule, in ladder order, with archive winning', () => {
        const result = explain({
            comax: { archived: true, price: 0, buyingPrice: 0, storeIds: [] },
            existing: { images: { product: [] } },
            enforceBuyingPrice: true
        })

        assert.equal(result.status, STATUS.ARCHIVED)
        assert.deepEqual(result.reasons, [
            STATUS_REASON.COMAX_ARCHIVED,
            STATUS_REASON.NO_PRICE,
            STATUS_REASON.NO_BUYING_PRICE,
            STATUS_REASON.NO_IMAGE,
            STATUS_REASON.NO_STORES
        ])
    })

    it('deriveStatus returns only the status', () => {
        assert.equal(deriveStatus({
            comax: EDGE({ price: 0 }),
            existing: IMAGE,
            status: STATUS,
            enforceBuyingPrice: false
        }), STATUS.ARCHIVED)
    })
})
