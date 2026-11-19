import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planAliasRows, resolveCategory } from '../../server/services/barcodeAliases/index.js'
import { parseAliasCsv } from '../../server/services/barcodeAliases/parse.js'

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden', ARCHIVED: 'archived' }

const EGGS = { id: 'nc:206:2027', name: 'ביצים', parentIds: ['nc:206'] }
const LOOKUP = {
    mapByCode: new Map([['10110', EGGS.id], ['10112', EGGS.id]]),
    categoriesById: new Map([[EGGS.id, EGGS]]),
    flagsByCode: new Map([
        ['10110', { categoryActive: true, showOnSite: true, requireKashrut: false }],
        ['10112', { categoryActive: true, showOnSite: true, requireKashrut: false }]
    ]),
    hasMap: true
}

const product = (barcode, overrides = {}) => ({
    _id: `id-${barcode}`,
    id: `p-${barcode}`,
    barcode,
    name: `מוצר ${barcode}`,
    status: STATUS.HIDDEN,
    storeIds: [],
    totalSalesUnits: 0,
    prices: [{ domainId: 'dom', price: 12 }],
    buyingPrice: 8,
    images: { product: [{ url: 'https://example.com/a.jpg' }] },
    scannableBarcodes: [],
    ...overrides
})

const comaxRow = (barcode, overrides = {}) => ({
    barcode,
    price: 12,
    buyingPrice: 8,
    storeIds: ['store-a'],
    salesLastDays: 10,
    showInWeb: true,
    archived: false,
    subGroupCode: '10110',
    ...overrides
})

const CSV = [
    'שם מוצר,ברקוד ראשי,ברקוד משני',
    'ביצים 12 יח׳ M,1111111111111,2222222222222 3333333333333',
    'ביצים 30 יח׳ L,4444444444444,5555555555555'
].join('\n')

const planOf = (rows, options = {}) => planAliasRows({
    rows,
    products: [product('1111111111111'), product('2222222222222'), product('4444444444444')],
    comaxRows: [comaxRow('1111111111111', { salesLastDays: 519 }), comaxRow('2222222222222', { salesLastDays: 207 })],
    categoryLookup: LOOKUP,
    defaultDomainId: 'dom',
    statuses: STATUS,
    ...options
}).plans

describe('barcode alias import plan', () => {
    it('plans a family: sheet name, merged aliases, summed sales, stock union', () => {
        const { rows } = parseAliasCsv(CSV)
        const [first] = planOf(rows)

        assert.equal(first.blocked, false)
        assert.equal(first.mainId, 'p-1111111111111')
        assert.equal(first.update.name, 'ביצים 12 יח׳ M')
        assert.equal(first.update.nameLocked, true)
        assert.deepEqual(first.update.scannableBarcodes, ['2222222222222', '3333333333333'])
        assert.equal(first.update.totalSalesUnits, 726)
        assert.deepEqual(first.update.storeIds, ['store-a'])
        assert.equal(first.statusAfter, STATUS.ACTIVE)
        assert.equal(first.salesFromDocs, 0, 'every family barcode was measured by Comax')
        // The old duplicate doc is what gets removed, with everything the
        // restore script needs to put it back.
        assert.deepEqual(first.duplicates.map(dup => dup.barcode), ['2222222222222'])
    })

    it('keeps the sales of a duplicate Comax no longer measures', () => {
        const { rows } = parseAliasCsv('שם מוצר,ברקוד ראשי,ברקוד משני\nביצים 12 יח׳ M,1111111111111,2222222222222')
        const [plan] = planAliasRows({
            rows,
            products: [
                product('1111111111111', { totalSalesUnits: 519 }),
                // The retired code has no Comax row any more: its recorded
                // units would disappear together with its doc.
                product('2222222222222', { totalSalesUnits: 206 })
            ],
            comaxRows: [comaxRow('1111111111111', { salesLastDays: 519 })],
            categoryLookup: LOOKUP,
            defaultDomainId: 'dom',
            statuses: STATUS
        }).plans

        assert.equal(plan.salesFromDocs, 206)
        assert.equal(plan.update.totalSalesUnits, 725)
        assert.equal(plan.salesAfter, 725)
    })

    it('writes the same total when the same file is applied again', () => {
        const { rows } = parseAliasCsv('שם מוצר,ברקוד ראשי,ברקוד משני\nביצים 12 יח׳ M,1111111111111,2222222222222')
        const [plan] = planAliasRows({
            rows,
            // Re-run: the alias doc is gone, its 206 units now live only in the
            // owner's total and in the snapshot the first run left behind.
            products: [product('1111111111111', { totalSalesUnits: 725, scannableBarcodes: ['2222222222222'] })],
            comaxRows: [comaxRow('1111111111111', { salesLastDays: 519 })],
            deletedDocs: [{ barcode: '2222222222222', totalSalesUnits: 206 }],
            ownerByAlias: new Map([['2222222222222', '1111111111111']]),
            categoryLookup: LOOKUP,
            defaultDomainId: 'dom',
            statuses: STATUS
        }).plans

        assert.deepEqual(plan.duplicates, [], 'the alias has no doc to delete any more')
        assert.equal(plan.salesFromDocs, 206)
        assert.equal(plan.update.totalSalesUnits, 725)
    })

    it('keeps aliases from a previous import instead of replacing them', () => {
        const { rows } = parseAliasCsv(CSV)
        const plans = planAliasRows({
            rows,
            products: [product('1111111111111', { scannableBarcodes: ['9999999999999'] })],
            comaxRows: [],
            categoryLookup: LOOKUP,
            defaultDomainId: 'dom',
            statuses: STATUS
        }).plans

        assert.deepEqual(plans[0].aliases, ['9999999999999', '2222222222222', '3333333333333'])
    })

    it('blocks a row whose secondary barcode is another row\'s main', () => {
        const { rows } = parseAliasCsv('ברקוד ראשי,ברקוד משני\n1111111111111,4444444444444\n4444444444444,5555555555555')
        const plans = planOf(rows)

        assert.deepEqual(plans[0].blockers, [{ barcode: '4444444444444', reason: 'secondary_is_main', lines: [3] }])
        assert.equal(plans[0].blocked, true)
    })

    it('blocks a secondary barcode that is already another product\'s alias', () => {
        const { rows } = parseAliasCsv(CSV)
        const plans = planOf(rows, { ownerByAlias: new Map([['2222222222222', '8888888888888']]) })

        assert.deepEqual(plans[0].blockers, [{ barcode: '2222222222222', reason: 'already_alias', owner: '8888888888888' }])
    })

    it('blocks a duplicated main barcode and a barcode claimed by two rows', () => {
        const { rows } = parseAliasCsv('ברקוד ראשי,ברקוד משני\n1111111111111,2222222222222\n1111111111111,2222222222222')
        const plans = planOf(rows)

        for (const plan of plans)
            assert.deepEqual(plan.blockers.map(b => b.reason), ['duplicate_main', 'secondary_claimed_twice'])
    })

    it('blocks a row whose main barcode is not in the catalog', () => {
        const { rows } = parseAliasCsv('ברקוד ראשי,ברקוד משני\n9999999999999,8888888888888')
        const plans = planOf(rows)

        assert.equal(plans[0].mainFound, false)
        assert.deepEqual(plans[0].blockers, [{ reason: 'main_not_found' }])
        // Nothing to write, but the report still carries the row for the admin.
        assert.deepEqual(plans[0].update, {})
    })

    it('resolves an optional category column by id or by name', () => {
        assert.deepEqual(resolveCategory('nc:206:2027', LOOKUP), { id: EGGS.id, title: 'ביצים', pathIds: ['nc:206', EGGS.id] })
        assert.deepEqual(resolveCategory('ביצים', LOOKUP).id, EGGS.id)
        assert.equal(resolveCategory('לא קיימת', LOOKUP), null)
        assert.equal(resolveCategory('', LOOKUP), null)
    })

    it('blocks an unknown category and writes a resolved one', () => {
        const { rows } = parseAliasCsv('ברקוד ראשי,ברקוד משני,קטגוריה\n1111111111111,,ביצים\n4444444444444,,לא קיימת')
        const plans = planOf(rows)

        assert.deepEqual(plans[0].update.category, { id: EGGS.id, title: 'ביצים', pathIds: ['nc:206', EGGS.id] })
        assert.deepEqual(plans[1].blockers, [{ reason: 'category_not_found', value: 'לא קיימת' }])
    })

    it('leaves the stored price of a main that has no Comax row of its own', () => {
        const { rows } = parseAliasCsv('שם מוצר,ברקוד ראשי,ברקוד משני\nביצים 30 יח׳ L,4444444444444,5555555555555')
        const [plan] = planAliasRows({
            rows,
            products: [product('4444444444444', { prices: [{ domainId: 'dom', price: 17 }], buyingPrice: 9 })],
            comaxRows: [comaxRow('5555555555555', { price: 0, buyingPrice: 0, subGroupCode: '10112', salesLastDays: 1281 })],
            categoryLookup: LOOKUP,
            defaultDomainId: 'dom',
            statuses: STATUS,
            enforceBuyingPrice: true
        }).plans

        assert.equal(plan.statusAfter, STATUS.ACTIVE)
        assert.equal(plan.update.totalSalesUnits, 1281)
        assert.equal('prices' in plan.update, false)
        assert.equal(plan.update.comaxSubGroupCode, '10112')
    })
})
