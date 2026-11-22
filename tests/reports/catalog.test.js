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

    // The report reads gs1_products through a filter, so the fixture is docs.
    // A bare barcode string means "GS1 answered and the raw is stored".
    const gs1Docs = gs1.map(doc => typeof doc === 'string' ? { barcode: doc, raw: {} } : doc)

    // Just enough query semantics to honour the filters the report actually uses.
    const matching = (docs, filter = {}) => docs.filter(doc =>
        Object.entries(filter).every(([key, rule]) => {
            const value = key.split('.').reduce((obj, part) => obj?.[part], doc)
            if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
                if ('$ne' in rule) return value !== rule.$ne
                if ('$in' in rule) return rule.$in.includes(value)
                if ('$exists' in rule) return (value !== undefined) === rule.$exists
            }
            return value === rule
        }))

    return {
        Domain: { readOne: async () => ({ id: 'default-domain' }) },
        Store: { Model: { find: () => list(STORES) } },
        ComaxProduct: {
            Model: { find: filter => list(matching(comax, filter)) },
            count: async () => buyingPriceRows
        },
        Product: {
            Model: { find: () => list(products) },
            constants: { STATUS }
        },
        CategoryMap: { read: async () => categoryFlags },
        Gs1Product: {
            Model: {
                distinct: async (field, filter = {}) => matching(gs1Docs, filter).map(doc => doc[field]),
                find: filter => ({ lean: async () => matching(gs1Docs, filter) })
            }
        },
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

// Column order is part of the report contract: [0..21] fixed, then one column
// per active store in the same order the stores were read.
const row = values => ({
    superDepartment: values[0], department: values[1], group: values[2], subGroup: values[3],
    categoryShown: values[4], categoryRequires: values[5], barcode: values[6], name: values[7],
    supplier: values[8], kashrut: values[9], kashrutValid: values[10], vat: values[11],
    inGs1: values[12], buyingPrice: values[13], salePrice: values[14], noComaxPrice: values[15],
    hasImage: values[16], unitsSold: values[17], lastSaleDate: values[18], existsOnSite: values[19],
    siteStatus: values[20], reason: values[21],
    stores: values.slice(22)
})

describe('catalog report', () => {
    it('adds one availability column per active store', async () => {
        const { columns } = await catalog.build(fakeDL({ comax: [comaxRow()] }))

        assert.equal(columns.length, 24)
        assert.deepEqual(columns.slice(4, 6).map(column => column.text), [
            'קטגוריה מוצגת באתר',
            'קטגוריה דורשת כשרות'
        ])
        assert.deepEqual(columns.slice(13, 16).map(column => column.text), [
            'מחיר קנייה',
            'מחיר מכירה',
            'ללא מחיר בקומקס'
        ])
        assert.deepEqual(columns.slice(16, 22).map(column => column.text), [
            'האם יש תמונה',
            'מכר',
            'תאריך מכירה אחרונה',
            'קיים באתר',
            'סטטוס לפי כללי האתר',
            'סיבת אי הצגה באתר'
        ])
        assert.deepEqual(columns.slice(22).map(column => column.text), [
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
        // The price-gap column sits between the two prices and the image flag.
        assert.equal(rows[0][15], 'לא')
        assert.equal(rows[0][16], 'כן')
    })

    it('reads a Comax row for a scan alias as the product that owns it', async () => {
        const { rows } = await catalog.build(fakeDL({
            // The alias still has its Comax row, but its product doc was folded
            // into the owner by the barcode-alias import.
            comax: [comaxRow({ barcode: '7290000000099' })],
            products: [productRow({ barcode: '7290000000015', scannableBarcodes: ['7290000000099'] })]
        }))

        assert.equal(rows.length, 1)
        assert.equal(rows[0][6], '7290000000099')
        assert.equal(rows[0][7], 'שם אתר')
        assert.equal(rows[0][16], 'כן', 'the family image is the catalog image')
        // Active through the owner, not "hidden, no doc".
        assert.equal(rows[0][19], 'כן')
        assert.equal(rows[0][20], 'פעיל')
        assert.equal(rows[0][21], '')
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

    it('says when a barcode was checked in GS1 and is not in our account', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow()],
            products: [productRow()],
            gs1: [{ barcode: '7290000000015', status: 'skipped', skipReason: 'no-gs1-record', syncedAt: new Date(2026, 10, 15) }]
        }))

        assert.equal(row(rows[0]).inGs1, 'לא (נבדק 15/11/2026)')
    })

    it('outranks a failed check with the GS1 data it already holds', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow()],
            products: [productRow()],
            gs1: [{
                barcode: '7290000000015', raw: {}, status: 'skipped',
                skipReason: 'no-gs1-record', syncedAt: new Date(2026, 10, 15)
            }]
        }))

        assert.equal(row(rows[0]).inGs1, 'כן')
    })

    it('never claims GS1 for a barcode the collection holds under another key', async () => {
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow()],
            products: [productRow()],
            gs1: [{ barcode: '7290000000099', raw: {} }]
        }))

        assert.equal(row(rows[0]).inGs1, 'לא')
    })

    it('reads kashrut and media from the GS1 dump when the row has no Product doc', async () => {
        // A backfilled row without a buying price never gets a Product doc (the
        // sync gate), so the GS1 dump is the only place its content can live.
        // The UPC here is 12 digits in Comax and 13 (0-padded) in the GS1 dump,
        // which is the pair the lookup has to bridge.
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow({ barcode: '729000000001', storeIds: [] })],
            products: [],
            gs1: [{
                barcode: '0729000000001',
                assetCount: 4,
                raw: {
                    product_info: {
                        Kashrut: {
                            Rabbinate: [{ value: 'בד"ץ העדה החרדית', code: '67085' }],
                            Kosher_Supervision_Type: [{ code: '182' }]
                        }
                    }
                }
            }]
        }))
        const reportRow = row(rows[0])

        assert.equal(reportRow.inGs1, 'כן')
        assert.equal(reportRow.kashrut, 'בד"ץ העדה החרדית (חלבי)')
        assert.equal(reportRow.kashrutValid, 'כן')
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

        assert.deepEqual(rows[0].slice(22), ['לא', 'כן'])
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

    it('says whose archive a price-less row is in: ours, not Comax', async () => {
        // A live Comax item with no buying price is archived by OUR ladder. The
        // status column and the reason both say it, so the row reads as "add it
        // to the price list" instead of looking like a Comax archive row.
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow({ barcode: '7290000000022', buyingPrice: 0, storeIds: [] })],
            products: []
        }))
        const reportRow = row(rows[0])

        assert.equal(reportRow.siteStatus, 'ארכיון באתר')
        assert.match(reportRow.reason, /^ארכיון באתר: חסר מחיר קנייה/)
    })

    it('leaves both price columns empty for an item Comax carries without a price list', async () => {
        // The import writes 0 and null for these rows so a stale price cannot
        // survive the write. In the sheet 0 and an absent field must read the same
        // way: an empty cell, next to a reason that names both missing prices.
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow({ barcode: '43001', price: 0, buyingPrice: null, storeIds: [] })],
            products: []
        }))
        const reportRow = row(rows[0])

        assert.equal(reportRow.buyingPrice, null)
        assert.equal(reportRow.salePrice, null)
        assert.equal(reportRow.noComaxPrice, 'כן')
        assert.equal(reportRow.siteStatus, 'ארכיון באתר')
        assert.match(reportRow.reason, /חסר מחיר מכירה בקומקס/)
        assert.match(reportRow.reason, /חסר מחיר קנייה/)
    })

    it('says the selling price is not Comax when the site has one and Comax does not', async () => {
        // A price typed into the admin stays on the site, and the sheet has to say
        // plainly that Comax has nothing behind it: that row is a price-list gap,
        // not a priced item.
        const { rows } = await catalog.build(fakeDL({
            comax: [comaxRow({ barcode: '43001', price: 0, buyingPrice: 20, storeIds: [] })],
            products: [productRow({ barcode: '43001' })]
        }))
        const reportRow = row(rows[0])

        assert.equal(reportRow.salePrice, 12.9)
        assert.equal(reportRow.noComaxPrice, 'כן')
    })

    it('shows the ladder status for active and hidden rows as well', async () => {
        const active = (await catalog.build(fakeDL({
            comax: [comaxRow()],
            products: [productRow()]
        }))).rows[0]
        const hidden = (await catalog.build(fakeDL({
            comax: [comaxRow({ storeIds: [] })],
            products: [productRow()]
        }))).rows[0]

        assert.equal(row(active).siteStatus, 'פעיל')
        assert.equal(row(hidden).siteStatus, 'מוסתר')
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

    it('reports no archived, inactive or trailing Comax row', async () => {
        // Archived products have their own export and are never stored by the
        // backfill, so a report row is always an item Comax still sells.
        const { rows } = await catalog.build(fakeDL({
            comax: [
                comaxRow({ barcode: '1', archived: true }),
                comaxRow({ barcode: '2', active: false }),
                comaxRow({ barcode: '3', isTrailingItem: true }),
                comaxRow({ barcode: '4' })
            ],
            products: [productRow()]
        }))

        assert.deepEqual(rows.map(values => values[6]), ['4'])
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
