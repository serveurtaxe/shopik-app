import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    buildAliasIndex,
    buildFamilyUpdate,
    familyBarcodes,
    pickEffectiveComaxRow,
    sumFamilySales,
    unionStoreIds
} from '../../server/services/productFamily.js'

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden', ARCHIVED: 'archived' }

// One mapped sub-group (biצים) plus the flags shape loadCategoryLookup returns.
const EGGS = { id: 'nc:206:2027', name: 'ביצים', parentIds: ['nc:206'] }
const LOOKUP = {
    mapByCode: new Map([['10110', EGGS.id]]),
    categoriesById: new Map([[EGGS.id, EGGS]]),
    flagsByCode: new Map([['10110', { categoryActive: true, showOnSite: true, requireKashrut: false }]]),
    hasMap: true
}

const IMAGES = { product: [{ url: 'https://example.com/a.jpg' }] }

const owner = (overrides = {}) => ({
    id: 'p-main',
    barcode: '1111111111111',
    scannableBarcodes: ['2222222222222'],
    images: IMAGES,
    prices: [{ domainId: 'dom', price: 12 }],
    buyingPrice: 8,
    ...overrides
})

const row = (overrides = {}) => ({
    barcode: '1111111111111',
    price: 12,
    buyingPrice: 8,
    storeIds: ['store-a'],
    salesLastDays: 10,
    showInWeb: true,
    archived: false,
    subGroupCode: '10110',
    ...overrides
})

const plan = (overrides = {}) => buildFamilyUpdate({
    owner: owner(overrides.owner),
    rows: overrides.rows ?? [row()],
    categoryLookup: LOOKUP,
    defaultDomainId: 'dom',
    statuses: STATUS,
    ...overrides
})

describe('product barcode families', () => {
    it('lists the product barcode first and dedupes its aliases', () => {
        assert.deepEqual(
            familyBarcodes({ barcode: '111', scannableBarcodes: ['222', '222', '333'] }),
            ['111', '222', '333']
        )
    })

    it('maps an alias to its owner and ignores an alias equal to the barcode', () => {
        const { ownerByAlias, ambiguous } = buildAliasIndex([
            { barcode: '111', scannableBarcodes: ['222', '111'] }
        ])
        assert.deepEqual([...ownerByAlias], [['222', '111']])
        assert.deepEqual(ambiguous, [])
    })

    it('drops an alias two products claim instead of guessing a winner', () => {
        const { ownerByAlias, ambiguous } = buildAliasIndex([
            { barcode: '111', scannableBarcodes: ['222'] },
            { barcode: '333', scannableBarcodes: ['222'] }
        ])
        assert.equal(ownerByAlias.has('222'), false)
        assert.deepEqual(ambiguous, ['222'])
    })

    it('prefers an in-season row, then the best stocked, for the family', () => {
        const rows = [
            row({ barcode: '2222222222222', archived: true, storeIds: ['s1', 's2', 's3'] }),
            row({ barcode: '3333333333333', archived: false, storeIds: ['s1'] })
        ]
        assert.equal(pickEffectiveComaxRow(rows).barcode, '3333333333333')
        assert.equal(pickEffectiveComaxRow([]), null)
    })

    it('sums the family sales and leaves the total alone when nothing was measured', () => {
        assert.equal(sumFamilySales([row({ salesLastDays: 10.5 }), row({ barcode: '2', salesLastDays: 4 })]), 14.5)
        assert.equal(sumFamilySales([row({ salesLastDays: undefined }), row({ barcode: '2', salesLastDays: undefined })]), null)
        assert.equal(sumFamilySales([row({ salesLastDays: 1 }), row({ barcode: '2', salesLastDays: 1.4449 })]), 2.445)
    })

    it('unions the stores of the whole family and keeps "never tracked" unknown', () => {
        assert.deepEqual(unionStoreIds([row({ storeIds: ['b', 'a'] }), row({ barcode: '2', storeIds: ['c'] })]), ['a', 'b', 'c'])
        assert.equal(unionStoreIds([row({ storeIds: undefined })]), null)
    })

    it('writes the stock union and the sales sum of the family, not of one row', () => {
        const { update } = plan({
            rows: [
                row({ salesLastDays: 519, storeIds: [] }),
                row({ barcode: '2222222222222', salesLastDays: 207, storeIds: ['store-b'] })
            ]
        })

        assert.equal(update.status, STATUS.ACTIVE)
        assert.deepEqual(update.storeIds, ['store-b'])
        assert.equal(update.totalSalesUnits, 726)
    })

    it('ignores Comax rows outside the family', () => {
        const { update, familyRows } = plan({
            rows: [row(), row({ barcode: '9999999999999', salesLastDays: 5000 })]
        })
        assert.equal(update.totalSalesUnits, 10)
        assert.equal(familyRows.length, 1)
    })

    it('hides the product only when no barcode in the family is on a shelf', () => {
        const { update } = plan({
            rows: [row({ storeIds: [] }), row({ barcode: '2222222222222', storeIds: [] })]
        })
        assert.equal(update.status, STATUS.HIDDEN)
        assert.deepEqual(update.storeIds, [])
    })

    it('keeps the family live while any barcode is still in season', () => {
        const { update } = plan({
            rows: [row(), row({ barcode: '2222222222222', archived: true })]
        })
        assert.notEqual(update.status, STATUS.ARCHIVED)
    })

    it('archives the family only when every barcode is archived', () => {
        const { update } = plan({
            rows: [row({ archived: true, storeIds: [] }), row({ barcode: '2222222222222', archived: true })]
        })
        assert.equal(update.status, STATUS.ARCHIVED)
    })

    it('keeps the stored price when the product has no Comax row of its own', () => {
        const { update } = plan({
            owner: {
                barcode: '1111111111111',
                scannableBarcodes: ['2222222222222'],
                images: IMAGES,
                prices: [{ domainId: 'dom', price: 12 }],
                buyingPrice: 8
            },
            rows: [row({ barcode: '2222222222222', price: 0, buyingPrice: 0, salesLastDays: 48 })],
            enforceBuyingPrice: true
        })

        assert.equal(update.status, STATUS.ACTIVE)
        // Category and sub-group come from the sibling row so it sits with them.
        assert.deepEqual(update.category, { id: EGGS.id, title: 'ביצים', pathIds: ['nc:206', EGGS.id] })
        assert.equal(update.comaxSubGroupCode, '10110')
        assert.equal(update.totalSalesUnits, 48)
    })

    it('writes nothing for a product whose family has no Comax row', () => {
        assert.equal(plan({ rows: [row({ barcode: '9999999999999' })] }), null)
        assert.equal(plan({ rows: [] }), null)
    })
})
