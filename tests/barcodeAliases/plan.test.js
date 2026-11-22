import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planAliasRows } from '../../server/services/barcodeAliases/index.js'
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
    it('plans a family: sheet name, sheet aliases, summed sales, stock union', () => {
        const { rows } = parseAliasCsv(CSV)
        const [first] = planOf(rows)

        assert.equal(first.blocked, false)
        assert.equal(first.mainId, 'p-1111111111111')
        assert.equal(first.update.name, 'ביצים 12 יח׳ M')
        assert.equal(first.update.nameLocked, true)
        assert.deepEqual(first.update.scannableBarcodes, ['2222222222222', '3333333333333'])
        assert.deepEqual(first.aliasesRemoved, [])
        assert.equal(first.update.totalSalesUnits, 726)
        assert.deepEqual(first.update.storeIds, ['store-a'])
        assert.equal(first.statusAfter, STATUS.ACTIVE)
        // The old duplicate doc is what gets removed, with everything the
        // restore script needs to put it back.
        assert.deepEqual(first.duplicates.map(dup => dup.barcode), ['2222222222222'])
    })

    it('counts only what Comax reports for the family, never a stored total', () => {
        const { rows } = parseAliasCsv('שם מוצר,ברקוד ראשי,ברקוד משני\nביצים 12 יח׳ M,1111111111111,2222222222222')
        const [plan] = planAliasRows({
            rows,
            products: [
                product('1111111111111', { totalSalesUnits: 519 }),
                // A retired code: Comax stopped reporting it. Its doc still has
                // a total, but that number is not Comax's and must not be added.
                product('2222222222222', { totalSalesUnits: 206 })
            ],
            comaxRows: [comaxRow('1111111111111', { salesLastDays: 519 })],
            categoryLookup: LOOKUP,
            defaultDomainId: 'dom',
            statuses: STATUS
        }).plans

        assert.equal(plan.update.totalSalesUnits, 519)
        assert.equal(plan.salesAfter, 519)
    })

    it('removes an alias the sheet no longer lists — the sheet is the source of truth', () => {
        const { rows } = parseAliasCsv(CSV)
        const plans = planAliasRows({
            rows,
            products: [product('1111111111111', { scannableBarcodes: ['9999999999999', '2222222222222'] })],
            comaxRows: [],
            categoryLookup: LOOKUP,
            defaultDomainId: 'dom',
            statuses: STATUS
        }).plans

        assert.deepEqual(plans[0].aliases, ['2222222222222', '3333333333333'])
        assert.deepEqual(plans[0].aliasesRemoved, ['9999999999999'])
        assert.deepEqual(plans[0].update.scannableBarcodes, ['2222222222222', '3333333333333'])
    })

    it('clears the family when the row lists no secondary barcode', () => {
        const { rows } = parseAliasCsv('שם מוצר,ברקוד ראשי,ברקוד משני\nביצים 12 יח׳ M,1111111111111,')
        const [first] = planAliasRows({
            rows,
            products: [product('1111111111111', { scannableBarcodes: ['2222222222222'] })],
            comaxRows: [],
            categoryLookup: LOOKUP,
            defaultDomainId: 'dom',
            statuses: STATUS
        }).plans

        assert.deepEqual(first.aliasesRemoved, ['2222222222222'])
        assert.deepEqual(first.update.scannableBarcodes, [])
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

    it('drops the main label when an alias carries a different brand', () => {
        const { rows } = parseAliasCsv('שם מוצר,ברקוד ראשי,ברקוד משני\nביצים 30 M,1111111111111,2222222222222')
        const [plan] = planAliasRows({
            rows,
            products: [
                product('1111111111111', { label: 'ביצי רמות השבים' }),
                // First import: the alias doc is still there to ask.
                product('2222222222222', { label: 'ביצי אחר' })
            ],
            comaxRows: [comaxRow('1111111111111'), comaxRow('2222222222222')],
            categoryLookup: LOOKUP,
            defaultDomainId: 'dom',
            statuses: STATUS
        }).plans

        assert.equal(plan.update.label, '')
    })

    it('reads the alias brand from its snapshot once the doc is gone', () => {
        const { rows } = parseAliasCsv('שם מוצר,ברקוד ראשי,ברקוד משני\nביצים 30 M,1111111111111,2222222222222')
        const [plan] = planAliasRows({
            rows,
            products: [product('1111111111111', { label: 'רמות', scannableBarcodes: ['2222222222222'] })],
            comaxRows: [comaxRow('1111111111111')],
            deletedLabels: new Map([['2222222222222', 'ביצי אחר']]),
            categoryLookup: LOOKUP,
            defaultDomainId: 'dom',
            statuses: STATUS
        }).plans

        assert.equal(plan.update.label, '')
    })

    it('leaves a uniform family label alone', () => {
        const { rows } = parseAliasCsv('שם מוצר,ברקוד ראשי,ברקוד משני\nביצים 30 M,1111111111111,2222222222222')
        const [plan] = planAliasRows({
            rows,
            products: [product('1111111111111', { label: 'רמות', scannableBarcodes: ['2222222222222'] })],
            comaxRows: [comaxRow('1111111111111')],
            deletedLabels: new Map([['2222222222222', 'רמות']]),
            categoryLookup: LOOKUP,
            defaultDomainId: 'dom',
            statuses: STATUS
        }).plans

        assert.equal('label' in plan.update, false)
    })

    it('blocks a secondary token that is not a barcode instead of dropping it', () => {
        const { rows } = parseAliasCsv('ברקוד ראשי,ברקוד משני\n1111111111111,2222222222222 729O001201589')
        const plans = planOf(rows)

        assert.deepEqual(plans[0].blockers, [{ barcode: '729O001201589', reason: 'invalid_secondary' }])
        assert.equal(plans[0].blocked, true)
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
