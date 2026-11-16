import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import syncComax from '../../server/api/comax_product/sync.js'

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden', ARCHIVED: 'archived' }
const BATCH = 1000
const TOTAL = 2501

// 2,501 rows in pages of 1,000. What the test guards is HOW the pages are asked
// for: MongoDB bounds a blocking sort by skip + limit, so skip-paging the whole
// catalog aborted the nightly sync at page 24 of 24,160 rows with
// 'Sort exceeded memory limit of 33554432 bytes'. A barcode cursor keeps every
// page a TopK sort of BATCH rows.
const barcodes = Array.from({ length: TOTAL }, (_, i) => String(i + 1).padStart(5, '0'))

// The sync reads the catalog twice over: the inactive sweep (filter active:false)
// and the main loop (the sync filter). Only the main loop is measured here.
const fakeDL = (pages, inactivePages) => ({
    ComaxProduct: {
        count: async () => TOTAL,
        read: async (filter, select, options) => {
            const target = filter.active === false && !filter.isTrailingItem ? inactivePages : pages
            target.push({ filter, options })
            const after = filter.barcode?.$gt
            return barcodes
                .filter(barcode => !after || barcode > after)
                .slice(0, options.limit)
                .map(barcode => ({
                    barcode,
                    comaxId: `c${barcode}`,
                    name: `p${barcode}`,
                    superDepartmentCode: '1',
                    departmentCode: '10',
                    groupCode: '100',
                    price: 10,
                    buyingPrice: 5,
                    showInWeb: true,
                    archived: false
                }))
        },
        update: async () => ({ modifiedCount: 1 })
    },
    Domain: { readOne: async () => ({ id: 'domain-1' }) },
    Category: { read: async () => [] },
    CategoryMap: { read: async () => [] },
    Product: {
        constants: {
            STATUS,
            UNIT: { ITEM: 'item', WEIGHT: 'weight' },
            BASE_UNIT: { UNIT: 'unit', KG: 'kg' }
        },
        read: async () => [],
        update: async () => ({ modifiedCount: 0 }),
        bulkWrite: async ({ docs }) => ({ upsertedCount: docs.length, modifiedCount: 0 })
    }
})

const run = async () => {
    const pages = []
    const inactivePages = []
    const result = await syncComax({ skipImageEnqueue: true }, { DL: fakeDL(pages, inactivePages) })
    return { pages, inactivePages, result }
}

describe('comax sync pagination', () => {
    it('walks the catalog by barcode cursor over three pages', async () => {
        const { pages, result } = await run()

        assert.equal(result.synced, TOTAL)
        assert.equal(result.created, TOTAL)
        assert.deepEqual(pages.map(page => page.options), [
            { limit: BATCH, sort: { barcode: 1 } },
            { limit: BATCH, sort: { barcode: 1 } },
            { limit: BATCH, sort: { barcode: 1 } }
        ])
        // Page 1 reads the catalog as the sync filter defines it; every later
        // page continues where the previous barcode ended.
        assert.equal(pages[0].filter.barcode, undefined)
        assert.deepEqual(pages.slice(1).map(page => page.filter.barcode), [
            { $gt: '01000' },
            { $gt: '02000' }
        ])
    })

    it('keeps the sync filter on every page', async () => {
        const { pages } = await run()

        const { barcode: _cursor, ...firstFilter } = pages[0].filter
        assert.deepEqual(pages.slice(1).map(page => {
            const { barcode, ...rest } = page.filter
            return rest
        }), [firstFilter, firstFilter])
    })

    it('sweeps inactive rows the same way, in its own pages', async () => {
        const { inactivePages } = await run()

        assert.deepEqual(inactivePages.map(page => page.options), [
            { limit: BATCH, sort: { barcode: 1 } },
            { limit: BATCH, sort: { barcode: 1 } },
            { limit: BATCH, sort: { barcode: 1 } }
        ])
        assert.deepEqual(inactivePages.map(page => page.filter.barcode), [
            { $nin: [null, ''] },
            { $gt: '01000' },
            { $gt: '02000' }
        ])
    })
})
