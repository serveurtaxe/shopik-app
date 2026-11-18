import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import backfillCatalog, {
    parseCatalogCsv,
    readKnownCodes,
    buildBackfilledRow,
    queueGs1Lookups
} from '../../server/api/comax_product/backfill_catalog.js'

// The buying price arrives through the delivery price list, and the handler
// refuses to run without it (a row with no buying price is archived by the ladder).
process.env.COMAX_DELIVERY_PRICELIST_ID = '255'

const HEADER = 'ברקוד קומקס,ברקוד משני,Column 4,Column 1'

const csv = (...codes) => `${HEADER}\n${codes.map(code => `${code},,,`).join('\n')}`

function item(comaxId, overrides = {}) {
    return {
        comaxId,
        barcode: String(comaxId),
        name: `מוצר ${comaxId}`,
        price: 10,
        buyingPrice: 7,
        departmentCode: '30',
        groupCode: '300',
        superDepartmentCode: '3',
        ...overrides
    }
}

/**
 * In-memory stand-in for the comax_products collection, with the bulkWrite
 * semantics the backfill relies on ($setOnInsert creates, $set refreshes).
 */
function fakeDL({ rows = [], syncStates = [] } = {}) {
    const store = rows.map(row => ({ ...row }))
    const writes = []
    const DL = {
        ComaxProduct: {
            Model: {
                distinct: async field => store.map(row => row[field]).filter(value => value != null)
            },
            read: async (filter = {}) => store.filter(row =>
                Object.entries(filter).every(([key, rule]) => {
                    if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
                        if ('$in' in rule) return rule.$in.includes(row[key])
                    }
                    return row[key] === rule
                })),
            bulkWrite: async ({ docs, getFilter, getUpdate, getUpsert }) => {
                let upsertedCount = 0, matchedCount = 0, modifiedCount = 0
                for (const doc of docs) {
                    const filter = getFilter(doc)
                    const update = getUpdate(doc)
                    const upsert = getUpsert(doc)
                    writes.push({ filter, update, upsert })

                    const existing = store.find(row => row.barcode === filter.barcode)
                    if (existing) {
                        matchedCount++
                        const changes = update.$set
                        if (changes && Object.keys(changes).length) {
                            Object.assign(existing, changes)
                            modifiedCount++
                        }
                    } else if (upsert) {
                        store.push({ barcode: filter.barcode, ...(update.$setOnInsert || {}) })
                        upsertedCount++
                    }
                }
                return { upsertedCount, matchedCount, modifiedCount }
            }
        },
        Gs1SyncState: {
            updateOne: async (filter, update) => syncStates.push({ filter, update })
        }
    }
    return { DL, store, writes, syncStates }
}

function fakeComax(items) {
    const calls = []
    const external = {
        comax: {
            getItemById: async options => {
                calls.push(options)
                const found = items[String(options.itemId)]
                if (typeof found === 'function') return found(options)
                return found ? { ...found } : null
            }
        }
    }
    return { external, calls }
}

const itemIds = calls => calls.map(call => String(call.itemId))
const ran = writes => writes.flatMap(write => Object.keys(write.update.$set || {}))

describe('catalog backfill csv', () => {
    it('reads the Comax item codes from their own column', () => {
        const { codes, invalid, rows } = parseCatalogCsv(`\uFEFF${HEADER}\n1001004,7290001131404,המרה לארוך,\n10068012,,,\n`)
        assert.deepEqual(codes, ['1001004', '10068012'])
        assert.deepEqual(invalid, [])
        assert.equal(rows, 2)
    })

    it('keeps the file order and drops repeats and leading-zero variants', () => {
        const { codes } = parseCatalogCsv(csv('900', '1001004', '900', '01001004', '800'))
        assert.deepEqual(codes, ['900', '1001004', '800'])
    })

    it('accepts every shape a Comax item code has, and only rejects text', () => {
        // Most Comax item codes are the item's EAN-13; some are internal ids,
        // and some are pack codes with a suffix hanging off the EAN. Comax reads
        // all of them by ItemID, so all of them are kept.
        const { codes, invalid } = parseCatalogCsv(`${HEADER}\n,7290001131404,,\n10068012,,,\n7290001131404,,,\n729000013534227,,,\n13168430337876,,,\nabc,,,\n7290010068O12,,,\n`)
        assert.deepEqual(codes, ['10068012', '7290001131404', '729000013534227', '13168430337876'])
        assert.deepEqual(invalid, ['abc', '7290010068O12'])
    })

    it('keeps a code as written, and dedupes it ignoring leading zeros', () => {
        const { codes } = parseCatalogCsv(csv('0729000000017', '729000000017', '900', '900'))
        assert.deepEqual(codes, ['0729000000017', '900'])
    })

    it('falls back to the first column when the header is missing', () => {
        const { codes } = parseCatalogCsv('code,other\n11,\n22,\n')
        assert.deepEqual(codes, ['11', '22'])
    })
})

describe('catalog backfill plan', () => {
    it('counts a code as known when it is stored as a barcode or as a comaxId', async () => {
        const { DL } = fakeDL({ rows: [{ barcode: '1001004' }, { barcode: '7290001131404', comaxId: '1131404' }] })
        const known = await readKnownCodes(DL)
        assert.deepEqual([...known].sort(), ['1001004', '1131404', '7290001131404'])
    })

    it('dry-run plans without asking Comax anything', async () => {
        const { DL } = fakeDL({ rows: [{ barcode: '1001004', comaxId: '1001004' }] })
        const { external, calls } = fakeComax({ 10068012: item('10068012') })

        const report = await backfillCatalog({ csv: csv('1001004', '10068012') }, { DL, external })

        assert.deepEqual(calls, [])
        assert.equal(report.dryRun, true)
        assert.equal(report.codes, 2)
        assert.equal(report.known, 1)
        assert.equal(report.targets, 1)
        assert.equal(report.remaining, 0)
    })

    it('refuses an empty csv and a missing Comax client', async () => {
        const { DL } = fakeDL()
        const { external } = fakeComax({})
        await assert.rejects(() => backfillCatalog({ csv: '   ' }, { DL, external }), e => e.status === 400)
        await assert.rejects(() => backfillCatalog({ csv: csv('1') }, { DL, external: {} }), e => e.status === 500)
    })

    it('stops with a clear message when Comax cannot be reached', async () => {
        const { DL, writes } = fakeDL()
        const external = {
            comax: { getItemById: async () => { throw new Error('socket hang up') } }
        }
        await assert.rejects(
            () => backfillCatalog({ csv: csv('1001', '1002'), dryRun: false }, { DL, external }),
            e => e.status === 502 && /^Comax unreachable: socket hang up/.test(e.message)
        )
        assert.deepEqual(writes, [])
    })
})

describe('catalog backfill writes', () => {
    it('creates rows that no store feed stocks, stamped as backfilled', async () => {
        const { DL, store, writes } = fakeDL()
        const { external } = fakeComax({ 10068012: item('10068012', { barcode: '7290010068012', storeIds: ['store-a'] }) })

        const report = await backfillCatalog({ csv: csv('10068012'), dryRun: false }, { DL, external })

        assert.equal(report.inserted, 1)
        assert.equal(report.withBuyingPrice, 1)
        const created = store.find(row => row.barcode === '7290010068012')
        assert.deepEqual(created.storeIds, [], 'a backfilled row must not claim a store')
        assert.ok(created.backfilledAt instanceof Date)
        assert.equal(created.comaxId, '10068012')
        assert.deepEqual(writes[0].update.$setOnInsert.barcode, '7290010068012')
        assert.equal(writes[0].upsert, true)
    })

    it('inserts a zero-priced item and counts it separately', async () => {
        const { DL, store } = fakeDL()
        const { external } = fakeComax({ 7: item('7', { price: 0, buyingPrice: 0 }) })

        const report = await backfillCatalog({ csv: csv('7'), dryRun: false }, { DL, external })

        assert.equal(report.inserted, 1)
        assert.equal(report.zeroPrice, 1)
        assert.equal(store.length, 1)
    })

    it('stores an archived (seasonal) item, flagged and stocked nowhere', async () => {
        const { DL, store } = fakeDL()
        const { external, calls } = fakeComax({ 1: item('1', { archived: true }) })

        const report = await backfillCatalog({ csv: csv('1'), dryRun: false }, { DL, external })

        assert.equal(report.inserted, 1)
        assert.equal(report.archived, 1)
        const row = store.find(doc => doc.barcode === '1')
        assert.equal(row.archived, true)
        assert.deepEqual(row.storeIds, [], 'an archived row must never claim a store')
        // Archived items are only returned when the lookup asks for them.
        assert.equal(calls[0].withOutArchive, false)
    })

    it('writes an item Comax carries without a price-list entry', async () => {
        // SelByPriceList is what brings the buying price, and Comax answers an
        // empty body for an item with no entry in 1069/255. The butcher scale
        // codes are this case: the item exists, it simply has no price yet.
        const { DL, store } = fakeDL()
        const { external, calls } = fakeComax({
            43001: options => options.selByPriceList
                ? null
                : item('43001', { barcode: '43001', name: 'בקר טחון מחפוד', price: 0, buyingPrice: 0 })
        })

        const report = await backfillCatalog({ csv: csv('43001'), dryRun: false }, { DL, external })

        assert.equal(report.inserted, 1, 'the item is real and belongs in the catalog')
        assert.equal(report.noPriceList, 1)
        assert.equal(report.zeroPrice, 1)
        assert.equal(report.skipped.notFound, 0, 'an empty price-list answer is not "not found"')

        const priced = calls.filter(call => call.selByPriceList)
        // The run opens with one preflight lookup and retries the item three
        // times, all of them price-list queries; the unfiltered look is the last.
        assert.equal(priced.length, 4, 'preflight plus the retries all ask the price lists')
        assert.equal(calls.length, priced.length + 1, 'and exactly one lookup goes around them')
        assert.equal(calls[calls.length - 1].salesPriceArray, undefined)

        const row = store.find(doc => doc.barcode === '43001')
        assert.equal(row.buyingPrice, 0)
        assert.ok(!row.archived, 'no price is not the same as archived in Comax')
    })

    it('never writes an unknown, mismatched or barcode-less item', async () => {
        const { DL, store, writes } = fakeDL()
        const { external } = fakeComax({
            3: item('999', { comaxId: '999', barcode: '7290000000015' }),
            4: item('4', { barcode: '   ' })
            // 2 has no fixture: Comax answered with nothing (gone or unknown).
        })

        const report = await backfillCatalog({ csv: csv('2', '3', '4'), dryRun: false }, { DL, external })

        assert.deepEqual(store, [])
        assert.deepEqual(writes, [])
        assert.equal(report.inserted, 0)
        assert.equal(report.archived, 0)
        assert.deepEqual(report.skipped, {
            notFound: 1, noBarcode: 1, idMismatch: 1, duplicateBarcode: 0
        })
    })

    it('leaves a row the nightly import owns exactly as it is', async () => {
        // The item's barcode is already a row the import created (no
        // backfilledAt), so its price, its stores and an admin's edit survive.
        const owned = {
            barcode: '7290000000015', comaxId: '777', name: 'שם שמעוצב', price: 42,
            buyingPrice: 30, storeIds: ['store-a'], lastImportedAt: new Date('2026-11-01')
        }
        const { DL, store, writes } = fakeDL({ rows: [owned] })
        const { external } = fakeComax({ 555: item('555', { barcode: '7290000000015', price: 9 }) })

        const report = await backfillCatalog({ csv: csv('555'), dryRun: false }, { DL, external })

        const row = store.find(doc => doc.barcode === '7290000000015')
        assert.equal(row.price, 42)
        assert.deepEqual(row.storeIds, ['store-a'])
        assert.equal(row.name, 'שם שמעוצב')
        assert.equal(report.existing, 1)
        assert.equal(report.refreshed, 0)
        assert.equal(ran(writes).length, 0, 'an import-owned row must not be modified')
        assert.ok(writes[0].update.$setOnInsert)
    })

    it('refreshes a row an earlier backfill created, without touching its stores', async () => {
        const stale = {
            barcode: '7290000000015', comaxId: '555', name: 'שם ישן', price: 5,
            buyingPrice: 4, storeIds: ['store-a'], backfilledAt: new Date('2026-01-01')
        }
        const { DL, store, writes } = fakeDL({ rows: [stale] })
        const { external } = fakeComax({ 556: item('556', { barcode: '7290000000015', price: 12, buyingPrice: 8 }) })

        const report = await backfillCatalog({ csv: csv('556'), dryRun: false }, { DL, external })

        const row = store.find(doc => doc.barcode === '7290000000015')
        assert.equal(row.price, 12)
        assert.equal(row.buyingPrice, 8)
        assert.deepEqual(row.storeIds, ['store-a'], 'stock stays owned by the import')
        assert.equal(String(row.backfilledAt.toISOString()).slice(0, 10), '2026-01-01', 'the creation stamp stays')
        assert.equal(report.refreshed, 1)
        assert.equal(ran(writes).length > 0, true)
        assert.equal(writes[0].update.$set.storeIds, undefined)
        assert.equal(writes[0].update.$set.backfilledAt, undefined)
    })

    it('keeps one row when two Comax items share a barcode', async () => {
        const { DL, store } = fakeDL()
        const { external } = fakeComax({
            10: item('10', { barcode: '7290000000015', name: 'ראשון' }),
            11: item('11', { barcode: '7290000000015', name: 'שני' })
        })

        const report = await backfillCatalog({ csv: csv('10', '11'), dryRun: false }, { DL, external })

        assert.equal(store.length, 1)
        assert.equal(store[0].name, 'ראשון', 'the first row in the file wins')
        assert.equal(report.skipped.duplicateBarcode, 1)
    })

    it('bounds the work per request and reports what is left', async () => {
        const items = Object.fromEntries([1, 2, 3, 4].map(id => [id, item(String(id))]))
        const { DL, store } = fakeDL()
        const { external } = fakeComax(items)

        const first = await backfillCatalog({ csv: csv('1', '2', '3', '4'), dryRun: false, limit: 2 }, { DL, external })
        assert.equal(first.processed, 2)
        assert.equal(first.remaining, 2)
        assert.equal(store.length, 2)

        const second = await backfillCatalog({ csv: csv('1', '2', '3', '4'), dryRun: false, limit: 2 }, { DL, external })
        assert.equal(second.targets, 2, 'the first run made its codes known')
        assert.equal(second.remaining, 0)
        assert.equal(store.length, 4)
    })

    it('resolves a trailing item once and adds the deposit to the price', async () => {
        const items = {
            20: item('20', { trailingItemId: '900', trailingItemQuantity: 2, price: 10 }),
            21: item('21', { barcode: '111', trailingItemId: '900', trailingItemQuantity: 1, price: 6 }),
            900: item('900', { barcode: '900', price: 0.3 })
        }
        const { DL, store } = fakeDL()
        const { external, calls } = fakeComax(items)

        const report = await backfillCatalog({ csv: csv('20', '21'), dryRun: false }, { DL, external })

        assert.equal(report.inserted, 2)
        assert.equal(report.skipped.notFound, 0, 'a deposit item must not be looked up as a catalog row')
        assert.equal(itemIds(calls).filter(id => id === '900').length, 1, 'the deposit is looked up once per run')

        const withDeposit = store.find(row => row.barcode === '20')
        assert.equal(withDeposit.trailingItemPrice, 0.3)
        assert.equal(withDeposit.trailingPrice, 0.6)
        assert.equal(withDeposit.priceWithTrailing, 10.6)
        assert.equal(store.find(row => row.barcode === '111').priceWithTrailing, 6.3)
    })

    it('leaves an item at its own price when its deposit cannot be read', async () => {
        const items = { 22: item('22', { trailingItemId: '901', price: 10 }) }
        const { DL, store } = fakeDL()
        const { external } = fakeComax({ ...items, 901: () => { throw new Error('Comax timeout') } })

        const report = await backfillCatalog({ csv: csv('22'), dryRun: false }, { DL, external })

        assert.equal(report.inserted, 1)
        const row = store.find(doc => doc.barcode === '22')
        assert.equal(row.trailingItemPrice, undefined)
        assert.equal(row.priceWithTrailing, undefined)
        assert.equal(row.price, 10)
    })
})

describe('catalog backfill GS1 queue', () => {
    it('asks GS1 only about plausible GTINs', async () => {
        const { DL, syncStates } = fakeDL()
        const jobs = []
        const enqueue = async list => { jobs.push(...list); return { enqueued: list.length } }

        const result = await queueGs1Lookups({
            DL,
            barcodes: new Set(['7290010068012', '10068012', '7290000000015']),
            startedAt: new Date('2026-11-12T00:00:00Z'),
            enqueue
        })

        assert.deepEqual(jobs.map(job => job.productCode), ['7290010068012', '7290000000015'])
        assert.equal(result.enqueued, 2)
        assert.equal(result.notGtin, 1)
        // The run record is the same shape gs1/sync writes, so its drain is
        // watched with gs1/status {runId}.
        assert.match(result.runId, /^run:backfill-\d+$/)
        assert.equal(syncStates[0].filter.key, result.runId)
        assert.deepEqual(
            { status: 'running', total: 2, processed: 0, failed: 0 },
            {
                status: syncStates[0].update.$set.status,
                total: syncStates[0].update.$set.total,
                processed: syncStates[0].update.$set.processed,
                failed: syncStates[0].update.$set.failed
            }
        )
        assert.ok(syncStates[0].update.$set.startedAt instanceof Date)
        assert.ok(jobs.every(job => job.runId === result.runId))
    })

    it('builds a backfilled row without overwriting the store list of its source', () => {
        const startedAt = new Date('2026-11-12T00:00:00Z')
        const row = buildBackfilledRow(item('1', { storeIds: ['store-a'] }), { startedAt })
        assert.deepEqual(row.storeIds, [])
        assert.equal(row.backfilledAt, startedAt)
        assert.equal(row.barcode, '1')
    })
})
