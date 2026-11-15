import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import catalog from '../../server/reports/catalog.js'

const STORES = [
    { id: 'store-bat-yam', name: 'נטו בת ים' },
    { id: 'store-beitar', name: 'נטו ביתר עלית' }
]

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden', ARCHIVED: 'archived' }

const DAY = 24 * 60 * 60 * 1000

function fakeDL({
    comax = [],
    products = [],
    gs1 = [],
    categoryFlags = [],
    salesWindow = { defaultDays: 30, rules: [] },
    buyingPriceRows = 1
} = {}) {
    const list = docs => ({ sort: () => ({ lean: async () => docs }), lean: async () => docs })
    return {
        Domain: { readOne: async () => ({ id: 'default-domain' }) },
        Store: { Model: { find: () => list(STORES) } },
        ComaxProduct: {
            Model: { find: () => list(comax) },
            count: async () => buyingPriceRows
        },
        Product: {
            Model: { find: () => list(products) },
            constants: { STATUS }
        },
        CategoryMap: { read: async () => categoryFlags },
        Gs1Product: { Model: { distinct: async () => gs1 } },
        Setting: { readOne: async () => ({ value: salesWindow }) }
    }
}

const comaxRow = (overrides = {}) => ({
    barcode: '7290000000015',
    name: 'שם קומקס',
    supplier: 'ספק קומקס',
    price: 9.9,
    buyingPrice: 6.5,
    vat: true,
    showInWeb: true,
    superDepartment: 'מזון',
    department: 'שימורים',
    departmentCode: '30',
    group: 'שימורים',
    subGroup: 'שימורים',
    storeIds: ['store-bat-yam'],
    picUrl: null,
    lastSaleDate: new Date(),
    ...overrides
})

const productRow = (overrides = {}) => ({
    barcode: '7290000000015',
    name: 'שם אתר',
    prices: [{ domainId: 'default-domain', price: 12.9 }],
    kashrut: { rabbinates: [{ code: '67085' }], supervisionType: 182 },
    images: { product: [{ main: true }] },
    ...overrides
})

// Column order is part of the report contract: [0..19] fixed, then one column
// per active store in the same order the stores were read.
const row = values => ({
    superDepartment: values[0], department: values[1], group: values[2], subGroup: values[3],
    categoryShown: values[4], categoryRequires: values[5], barcode: values[6], name: values[7],
    supplier: values[8], kashrut: values[9], kashrutValid: values[10], vat: values[11],
    inGs1: values[12], buyingPrice: values[13], salePrice: values[14], hasImage: values[15],
    unitsSold: values[16], lastSaleDate: values[17], existsOnSite: values[18], reason: values[19],
    stores: values.slice(20)
})

describe('catalog report', () => {
    it('adds one availability column per active store', async () => {
        const { columns } = await catalog.build(fakeDL({ comax: [comaxRow()] }))

        assert.equal(columns.length, 22)
        assert.deepEqual(columns.slice(4, 6).map(column => column.text), [
            'קטגוריה מוצגת באתר',
            'קטגוריה דורשת כשרות'
        ])
        assert.deepEqual(columns.slice(16, 20).map(column => column.text), [
            'מכר',
            'תאריך מכירה אחרונה',
            'קיים באתר',
            'סיבת אי הצגה באתר'
        ])
        assert.deepEqual(columns.slice(20).map(column => column.text), [
            'האם בסניף נטו בת ים',
            'האם בסניף נטו ביתר עלית'
        ])
    })

    it('prefers the Product name and default-domain price, falling back to Comax', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow()],
            products: [productRow({ prices: [] })]
        }))

        assert.equal(rows[0][7], 'שם אתר')
        assert.equal(rows[0][14], 9.9)
        assert.equal(rows[0][8], 'ספק קומקס')
        assert.equal(rows[0][13], 6.5)

        const { rows: priced } = await catalog.build(fakeDL({
            comax: [comaxRow()],
            products: [productRow()]
        }))
        assert.equal(priced[0][14], 12.9)
    })

    it('joins on the barcode with leading zeros stripped', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow({ barcode: '0007290000000015' })],
            products: [productRow()]
        }))

        assert.equal(rows[0][6], '0007290000000015')
        assert.equal(rows[0][7], 'שם אתר')
        assert.equal(rows[0][15], 'כן')
    })

    it('renders kashrut, VAT, GS1 and image flags', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow()],
            products: [productRow()],
            gs1: ['7290000000015']
        }))
        const reportRow = row(rows[0])

        assert.equal(reportRow.kashrut, 'בד"ץ העדה החרדית ירושלים (חלבי)')
        assert.equal(reportRow.kashrutValid, 'כן')
        assert.equal(reportRow.vat, 'true')
        assert.equal(reportRow.inGs1, 'כן')
        assert.equal(reportRow.hasImage, 'כן')
    })

    it('marks כשרות מתאימה only by valid codes, same rule as the status ladder', async () => {
        const build = kashrut => catalog.build(fakeDL({
            comax: [comaxRow()],
            products: [productRow({ kashrut })]
        }))

        const valid = (await build({ rabbinates: [{ code: '99999' }, { code: '67093', name: 'בדצ בית יוסף' }] })).rows[0]
        assert.equal(row(valid).kashrutValid, 'כן')

        const unknown = (await build({ rabbinates: [{ code: '99999' }] })).rows[0]
        assert.equal(row(unknown).kashrutValid, 'לא')

        const nameOnly = (await build({ rabbinates: [{ name: 'רבנות אחרת' }] })).rows[0]
        assert.equal(row(nameOnly).kashrutValid, 'לא')

        const none = (await build(undefined)).rows[0]
        assert.equal(row(none).kashrutValid, 'לא')
    })

    it('reads קטגוריה דורשת כשרות from the sub-group requireKashrut flag', async () => {
        const built = async categoryFlags => (await catalog.build(fakeDL({
            comax: [comaxRow({ subGroupCode: '90200' })],
            categoryFlags
        }))).rows[0][5]

        assert.equal(await built([{ subGroupCode: '90200', requireKashrut: true }]), 'כן')
        assert.equal(await built([{ subGroupCode: '90200', requireKashrut: false }]), 'לא')
        // A category_map row the flags file never set means no requirement,
        // like the status ladder treats it.
        assert.equal(await built([{ subGroupCode: '90200' }]), 'לא')
        // A sub-group with no category_map row is unknown, like a Comax row
        // without a sub-group code at all.
        assert.equal(await built([{ subGroupCode: '90201', requireKashrut: true }]), '')
        assert.equal(await built([]), '')
        assert.equal((await catalog.build(fakeDL({ comax: [comaxRow()] }))).rows[0][5], '')
    })

    it('reads קטגוריה מוצגת באתר from the sub-group showOnSite flag', async () => {
        const built = async categoryFlags => (await catalog.build(fakeDL({
            comax: [comaxRow({ subGroupCode: '90200' })],
            categoryFlags
        }))).rows[0][4]

        assert.equal(await built([{ subGroupCode: '90200', showOnSite: false }]), 'לא')
        assert.equal(await built([{ subGroupCode: '90200', showOnSite: true }]), 'כן')
        // A category_map row the flags file never set defaults to show, like
        // the status ladder treats it.
        assert.equal(await built([{ subGroupCode: '90200' }]), 'כן')
        // A sub-group with no category_map row is unknown, like a Comax row
        // without a sub-group code at all.
        assert.equal(await built([{ subGroupCode: '90201', showOnSite: false }]), '')
        assert.equal(await built([]), '')
        assert.equal((await catalog.build(fakeDL({ comax: [comaxRow()] }))).rows[0][4], '')
    })

    it('marks the stores the product is in stock in', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow({ storeIds: ['store-beitar'] })]
        }))

        assert.deepEqual(rows[0].slice(20), ['לא', 'כן'])
    })

    it('sorts by category and puts rows with no category last', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [
                comaxRow({ barcode: '1', superDepartment: '', department: '' }),
                comaxRow({ barcode: '2', superDepartment: 'מזון', department: 'שימורים' }),
                comaxRow({ barcode: '3', superDepartment: 'מזון', department: 'ירקות' })
            ]
        }))

        // Plain codepoint order (ירקות < שימורים), which is what the previous
        // report produced; only the empty categories are forced to the end.
        assert.deepEqual(rows.map(values => values[6]), ['3', '2', '1'])
    })

    it('leaves the supplier empty when Comax has none', async () => {
        const { rows } = await catalog.build(fakeDL({ comax: [comaxRow({ supplier: null })] }))
        assert.equal(rows[0][8], '')
    })

    it('shows the last sale date, and leaves it empty when the item never sold', async () => {
        const sold = (await catalog.build(fakeDL({
            comax: [comaxRow({ lastSaleDate: new Date(2020, 0, 15) })]
        }))).rows[0]
        assert.equal(row(sold).lastSaleDate, '15/01/2020')

        const never = (await catalog.build(fakeDL({
            comax: [comaxRow({ lastSaleDate: null })]
        }))).rows[0]
        assert.equal(row(never).lastSaleDate, '')
    })

    it('shows the units sold over the window, empty when never measured', async () => {
        const measured = (await catalog.build(fakeDL({
            comax: [comaxRow({ salesLastDays: 12.5 })]
        }))).rows[0]
        assert.equal(row(measured).unitsSold, 12.5)

        // Measured zero sales is a fact, not a missing value.
        const zero = (await catalog.build(fakeDL({
            comax: [comaxRow({ salesLastDays: 0 })]
        }))).rows[0]
        assert.equal(row(zero).unitsSold, 0)

        const unmeasured = (await catalog.build(fakeDL({
            comax: [comaxRow({ salesLastDays: undefined })]
        }))).rows[0]
        assert.equal(row(unmeasured).unitsSold, null)
    })

    it('marks an item on site only when every rule passes', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow()],
            products: [productRow()]
        }))
        const reportRow = row(rows[0])

        assert.equal(reportRow.existsOnSite, 'כן')
        assert.equal(reportRow.reason, '')
    })

    it('lists the rule that keeps a new item off the site (no buying price)', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow({ buyingPrice: 0 })],
            products: []
        }))
        const reportRow = row(rows[0])

        assert.equal(reportRow.existsOnSite, 'לא')
        assert.match(reportRow.reason, /חסר מחיר קנייה/)
    })

    it('does not enforce the buying-price rule before any buying price exists', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow({ buyingPrice: 0 })],
            products: [productRow()],
            buyingPriceRows: 0
        }))

        assert.equal(row(rows[0]).reason, '')
    })

    it('lists every violated rule, not just the first', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow({ buyingPrice: 0, picUrl: null })],
            products: [productRow({ images: { product: [] }, kashrut: undefined })]
        }))
        const reportRow = row(rows[0])

        assert.match(reportRow.reason, /חסר מחיר קנייה/)
        assert.match(reportRow.reason, /חסרה תמונה/)
    })

    it('reports no stores, inactive category and kashrut as separate rules', async () => {
        const noStores = (await catalog.build(fakeDL({
            comax: [comaxRow({ storeIds: [] })],
            products: [productRow()]
        }))).rows[0]
        assert.match(row(noStores).reason, /לא קיים באף סניף/)

        const inactive = (await catalog.build(fakeDL({
            comax: [comaxRow({ subGroupCode: '90200' })],
            products: [productRow()],
            categoryFlags: [{ subGroupCode: '90200', categoryActive: false }]
        }))).rows[0]
        assert.match(row(inactive).reason, /הקטגוריה לא פעילה באתר/)

        const hiddenSubGroup = (await catalog.build(fakeDL({
            comax: [comaxRow({ subGroupCode: '90200' })],
            products: [productRow()],
            categoryFlags: [{ subGroupCode: '90200', showOnSite: false }]
        }))).rows[0]
        assert.match(row(hiddenSubGroup).reason, /תת הקטגוריה מוסתרת באתר/)

        const noKashrut = (await catalog.build(fakeDL({
            comax: [comaxRow({ subGroupCode: '90200' })],
            products: [productRow({ kashrut: undefined })],
            categoryFlags: [{ subGroupCode: '90200', requireKashrut: true }]
        }))).rows[0]
        assert.match(row(noKashrut).reason, /חסרה כשרות מתאימה/)
    })

    it('reports a Comax archive as the reason', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow({ archived: true })],
            products: [productRow()]
        }))

        assert.match(row(rows[0]).reason, /המוצר הועבר לארכיון בקומקס/)
    })

    it('explains an image that exists only as a Comax picUrl', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow({ picUrl: 'https://example.com/a.jpg' })],
            products: [productRow({ images: { product: [] } })]
        }))
        const reportRow = row(rows[0])

        assert.equal(reportRow.hasImage, 'כן')
        assert.match(reportRow.reason, /תמונה טרם נטענה מקומקס/)
    })

    it('adds a stale-sales reason when the item has not sold inside its window', async () => {
        const stale = (await catalog.build(fakeDL({
            comax: [comaxRow({ lastSaleDate: new Date(Date.now() - 40 * DAY) })]
        }))).rows[0]
        assert.match(row(stale).reason, /לא נמכר מאז /)

        const never = (await catalog.build(fakeDL({
            comax: [comaxRow({ lastSaleDate: null })]
        }))).rows[0]
        assert.match(row(never).reason, /לא נמכר \(אין מכירה מתועדת\)/)

        const fresh = (await catalog.build(fakeDL({
            comax: [comaxRow({ lastSaleDate: new Date() })]
        }))).rows[0]
        assert.doesNotMatch(row(fresh).reason, /לא נמכר/)
    })

    it('uses the per-department sales window', async () => {
        const tenDaysAgo = new Date(Date.now() - 10 * DAY)
        const staleWith5Days = (await catalog.build(fakeDL({
            comax: [comaxRow({ departmentCode: '30', lastSaleDate: tenDaysAgo })],
            salesWindow: { defaultDays: 30, rules: [{ days: 5, departments: ['30'] }] }
        }))).rows[0]
        assert.match(row(staleWith5Days).reason, /לא נמכר מאז /)

        const freshWith30Days = (await catalog.build(fakeDL({
            comax: [comaxRow({ departmentCode: '30', lastSaleDate: tenDaysAgo })],
            salesWindow: { defaultDays: 30, rules: [] }
        }))).rows[0]
        assert.doesNotMatch(row(freshWith30Days).reason, /לא נמכר/)
    })

    it('keeps the reason empty for an on-site row with an old sale date', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow({ lastSaleDate: new Date(2020, 0, 15) })],
            products: [productRow()]
        }))
        const reportRow = row(rows[0])

        assert.equal(reportRow.existsOnSite, 'כן')
        assert.equal(reportRow.reason, '')
        assert.equal(reportRow.lastSaleDate, '15/01/2020')
    })
})
