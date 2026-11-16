import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import importComaxProducts from '../../server/api/comax_product/import.js'

// The store feed's delivery row is read with this price list, so set it before
// the mapper sees any fixture item.
process.env.COMAX_DELIVERY_PRICELIST_ID = '255'

function reg(storeId, stockStoreId) {
    return { storeId, data: { StockStoreID: stockStoreId } }
}

function makeProduct(i, overrides = {}) {
    return {
        barcode: String(1000 + i),
        price: 10 + i,
        archived: false,
        vat: true,
        superDepartmentCode: '3',
        ...overrides
    }
}

function makeDL({
    registers = [reg('store-a', '84'), reg('store-b', '52')],
    state = null,
    settings = { 'comax.freshDepartments': '13' },
    failBatch = false
} = {}) {
    const writes = []
    const stateUpdates = []
    const pulls = []
    const prunes = []
    const zeroed = []
    const distinctFilters = []
    const modelBulkWrites = []
    let storeBarcodes = {}
    let allBarcodes = []

    const DL = {
        CashRegister: {
            read: async () => registers
        },
        Setting: {
            readOne: async ({ key }) => (key in settings ? { value: settings[key] } : null)
        },
        ComaxProduct: {
            Model: {
                findOne: () => {
                    const chain = { sort: () => chain, lean: async () => null }
                    return chain
                },
                distinct: async (field, filter) => {
                    distinctFilters.push(filter)
                    // No storeIds in the filter means the whole collection: that is
                    // how the import asks "is this sold barcode a row at all".
                    if (filter?.storeIds == null) return allBarcodes
                    return storeBarcodes[filter?.storeIds] || []
                },
                updateMany: async (filter, update) => {
                    // An id-scoped pull removes one barcode from one store; the
                    // store-list prune keeps a filter without a barcode.
                    if (filter?.storeIds?.$exists) {
                        prunes.push({ filter, update })
                        return { modifiedCount: 1 }
                    }
                    // Everything not in the reported set sold nothing.
                    if (filter?.barcode?.$nin) {
                        zeroed.push({ filter, update })
                        return { modifiedCount: 1 }
                    }
                    pulls.push({ filter, update })
                    return { modifiedCount: filter?.barcode?.$in?.length || 0 }
                },
                bulkWrite: async ops => {
                    modelBulkWrites.push(...ops)
                    return {}
                }
            },
            bulkWrite: async ({ docs, getUpsert, getFilter, getUpdate }) => {
                if (failBatch) throw new Error('mongo is down')
                writes.push({
                    docs,
                    upserts: docs.map(getUpsert),
                    filters: docs.map(getFilter),
                    updates: getUpdate ? docs.map(getUpdate) : null
                })
                return { upsertedCount: docs.length, modifiedCount: 0 }
            }
        },
        ComaxSyncState: {
            readOne: async ({ key }) => (state?.key === key ? state : null),
            updateOne: async (filter, update, options) => {
                stateUpdates.push({ filter, update, options })
                return {}
            }
        }
    }
    return {
        DL,
        writes,
        stateUpdates,
        pulls,
        prunes,
        zeroed,
        distinctFilters,
        modelBulkWrites,
        setStoreBarcodes: map => { storeBarcodes = map },
        setAllBarcodes: list => { allBarcodes = list }
    }
}

function feedSpec(value) {
    if (Array.isArray(value)) return { items: value }
    return value || { items: [] }
}

function makeExternal({ stores = {}, departments = {}, products = [], salesWindows = {}, trailingItems = {} } = {}) {
    const calls = { stores: [], departments: [], salesWindow: [], products: 0, trailingItems: [] }

    const feed = spec => async function* (options) {
        const { items, blocks, unparsed = 0, throwAfter = null } = feedSpec(spec)
        let i = 0
        for (const product of items) {
            if (throwAfter != null && i === throwAfter) throw new Error('the stream died')
            yield product
            i++
        }
        if (options.stats) {
            options.stats.blocks = blocks ?? items.length
            options.stats.kept = items.length
            options.stats.unparsed = unparsed
        }
    }

    const external = {
        comax: {
            streamProducts: options => {
                calls.products++
                return feed(products)(options)
            },
            getItemById: async ({ itemId }) => {
                calls.trailingItems.push(itemId)
                return trailingItems[itemId] || null
            },
            streamStoreProducts: options => {
                calls.stores.push(options)
                return feed(stores[options.storeId])(options)
            },
            streamDepartmentProducts: options => {
                calls.departments.push(options)
                return feed(departments[options.departmentId])(options)
            },
            streamSalesWindow: options => {
                calls.salesWindow.push(options)
                return feed(salesWindows[options.storeId])(options)
            }
        }
    }
    return { external, calls }
}

function lastStateUpdate(stateUpdates, key) {
    return stateUpdates.filter(u => u.filter.key === key).pop()
}

function updateFor(writes, barcode) {
    for (const write of writes) {
        const index = write.docs.findIndex(d => d.barcode === barcode)
        if (index >= 0) return write.updates[index]
    }
    throw new Error(`${barcode} was not written`)
}

describe('comax store feed import', () => {
    it('runs one store feed per active register and one call per fresh department', async () => {
        const { DL } = makeDL()
        const { external, calls } = makeExternal({
            stores: { 84: [makeProduct(0)], 52: [makeProduct(1)] },
            departments: { 13: [makeProduct(2)] }
        })

        const result = await importComaxProducts({}, { DL, external })

        assert.deepEqual(calls.stores.map(c => c.storeId), ['84', '52'])
        assert.deepEqual(calls.departments.map(c => c.departmentId), ['13'])
        assert.equal(result.count, 3)
        assert.equal(result.status, 'success')
    })

    it('adds the shopik store id to storeIds instead of replacing the array', async () => {
        const { DL, writes } = makeDL({ registers: [reg('store-a', '84')] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [makeProduct(1)] }
        })

        await importComaxProducts({}, { DL, external })

        const storeUpdate = updateFor(writes, '1000')
        assert.deepEqual(storeUpdate.$addToSet, { storeIds: 'store-a' })
        assert.equal(storeUpdate.$set.storeIds, undefined)
        assert.ok(storeUpdate.$set.lastImportedAt instanceof Date)

        const freshUpdate = updateFor(writes, '1001')
        assert.deepEqual(freshUpdate.$addToSet, { storeIds: 'store-a' })
    })

    it('marks fresh departments in stock in every active store', async () => {
        const { DL, writes } = makeDL()
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)], 52: [makeProduct(1)] },
            departments: { 13: [makeProduct(2)] }
        })

        await importComaxProducts({}, { DL, external })

        assert.deepEqual(updateFor(writes, '1002').$addToSet, {
            storeIds: { $each: ['store-a', 'store-b'] }
        })
    })

    it('creates a row for an item the store carries without a price, and skips archived ones', async () => {
        const { DL, writes } = makeDL()
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0), makeProduct(1, { price: 0 }), makeProduct(2, { archived: true })] },
            departments: { 13: [makeProduct(3)] }
        })

        const result = await importComaxProducts({}, { DL, external })

        // An unpriced item the feed carried is a Comax item with no entry in
        // either price list: it belongs in the catalog so the report can show it.
        // Archived items stay the backfill's rows, which are written flagged.
        assert.deepEqual(writes[0].upserts, [true, true, false])
        assert.equal(result.noPrice, 1)
    })

    it('clears the selling price for an item Comax carries without one', async () => {
        const { DL, writes } = makeDL()
        const { external } = makeExternal({
            // No selling price and no delivery row. Left alone, the stored price
            // from the last time it had one would survive the write.
            stores: { 84: [makeProduct(0, { price: undefined, buyingPrice: undefined })] },
            departments: { 13: [makeProduct(1)] }
        })

        const result = await importComaxProducts({}, { DL, external })

        const update = updateFor(writes, '1000')
        assert.equal(update.$set.price, 0)
        assert.equal(update.$set.buyingPrice, undefined, 'no 255 row is not a verdict on the buying price')
        assert.equal(result.noPrice, 1)
    })

    it('keeps the buying price of an item that has one and no selling price', async () => {
        // 139232 מסטר נתחים צלעות בקר טרי חלק: Comax answers 42 in the 255 list and
        // nothing in 1069. The report has to show both halves of that.
        const { DL, writes } = makeDL()
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0, { price: 0, buyingPrice: 42 })] },
            departments: { 13: [makeProduct(1)] }
        })

        const result = await importComaxProducts({}, { DL, external })

        const update = updateFor(writes, '1000')
        assert.equal(update.$set.price, 0)
        assert.equal(update.$set.buyingPrice, 42)
        assert.equal(result.noPrice, 1)
    })

    it('preserves the stored buying price when the feed has no delivery row', async () => {
        const { DL, writes } = makeDL()
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0, { buyingPrice: undefined })] },
            departments: { 13: [makeProduct(1)] }
        })

        await importComaxProducts({}, { DL, external })

        const update = updateFor(writes, '1000')
        assert.equal(update.$set.buyingPrice, undefined)
    })

    it('writes the delivery price when the feed carries one', async () => {
        const { DL, writes } = makeDL()
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0, { buyingPrice: 7.5 })] },
            departments: { 13: [makeProduct(1)] }
        })

        await importComaxProducts({}, { DL, external })

        assert.equal(updateFor(writes, '1000').$set.buyingPrice, 7.5)
    })

    it('resolves a trailing item and writes the deposit as its own product', async () => {
        const { DL, writes } = makeDL({ registers: [reg('store-a', '84')] })
        const { external, calls } = makeExternal({
            stores: {
                84: [makeProduct(0, {
                    price: 6.6,
                    trailingItemId: '555501',
                    trailingItemQuantity: 1,
                    trailingPrice: 0,
                    priceWithTrailing: 6.6
                })]
            },
            departments: { 13: [] },
            trailingItems: {
                555501: {
                    comaxId: '555501',
                    barcode: '555501',
                    name: 'פקדון בקבוק 0.30 שח',
                    price: 0.3,
                    superDepartmentCode: '12',
                    archived: false
                }
            }
        })

        await importComaxProducts({}, { DL, external })

        assert.deepEqual(calls.trailingItems, ['555501'])

        const parent = updateFor(writes, '1000').$set
        assert.equal(parent.trailingItemPrice, 0.3)
        assert.equal(parent.trailingPrice, 0.3)
        assert.equal(parent.priceWithTrailing, 6.9)

        const depositWrite = writes.find(w => w.docs.some(d => d.barcode === '555501'))
        assert.ok(depositWrite, 'the deposit product is written')
        assert.equal(depositWrite.docs[0].isTrailingItem, true)
        assert.equal(depositWrite.upserts[0], true)
    })

    it('multiplies PikadonCmt into the deposit price', async () => {
        const { DL, writes } = makeDL({ registers: [reg('store-a', '84')] })
        const { external } = makeExternal({
            stores: {
                84: [makeProduct(0, {
                    price: 10,
                    trailingItemId: '555505',
                    trailingItemQuantity: 6,
                    priceWithTrailing: 10
                })]
            },
            departments: { 13: [] },
            trailingItems: { 555505: { barcode: '555505', price: 0.3 } }
        })

        await importComaxProducts({}, { DL, external })

        const parent = updateFor(writes, '1000').$set
        assert.equal(parent.trailingItemPrice, 0.3)
        assert.equal(parent.trailingPrice, 1.8)
        assert.equal(parent.priceWithTrailing, 11.8)
    })

    it('keeps the reference but clears calculated prices when the trailing item cannot be read', async () => {
        const { DL, writes } = makeDL({ registers: [reg('store-a', '84')] })
        const { external } = makeExternal({
            stores: {
                84: [makeProduct(0, {
                    price: 6.6,
                    trailingItemId: '999999',
                    trailingItemQuantity: 1,
                    priceWithTrailing: 6.6
                })]
            },
            departments: { 13: [] }
        })

        await importComaxProducts({}, { DL, external })

        const update = updateFor(writes, '1000')
        assert.equal(update.$set.trailingItemId, '999999')
        assert.equal(update.$set.trailingItemQuantity, 1)
        assert.equal(update.$set.trailingPrice, undefined)
        assert.equal(update.$set.priceWithTrailing, undefined)
        assert.deepEqual(update.$unset, {
            trailingItemPrice: '',
            trailingPrice: '',
            priceWithTrailing: ''
        })
    })

    it('does not store trailing fields on a product without a deposit', async () => {
        const { DL, writes } = makeDL({ registers: [reg('store-a', '84')] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [] }
        })

        await importComaxProducts({}, { DL, external })

        const update = updateFor(writes, '1000')
        for (const key of ['trailingItemId', 'trailingItemQuantity', 'trailingItemPrice', 'trailingPrice', 'priceWithTrailing']) {
            assert.equal(update.$set[key], undefined, `${key} must not be written`)
            assert.equal(update.$unset[key], '', `${key} must be cleared`)
        }
    })

    it('removes the store id from items that are no longer in stock', async () => {
        const { DL, distinctFilters, pulls, setStoreBarcodes } = makeDL({ registers: [reg('store-a', '84')] })
        setStoreBarcodes({ 'store-a': ['1000', '9999'] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [makeProduct(1)] }
        })

        const result = await importComaxProducts({}, { DL, external })

        // The import also reads the whole barcode set (that is how a price-less
        // item is recognised as an existing row), so only the stock-scoped reads
        // are what this step may issue.
        assert.deepEqual(distinctFilters.filter(f => f?.storeIds), [{ storeIds: 'store-a' }])
        assert.equal(pulls.length, 1)
        assert.deepEqual(pulls[0].filter, { barcode: { $in: ['9999'] }, storeIds: 'store-a' })
        assert.deepEqual(pulls[0].update, { $pull: { storeIds: 'store-a' } })
        assert.equal(result.removed, 1)
    })

    it('keeps fresh items in stock in every store', async () => {
        const { DL, pulls, setStoreBarcodes } = makeDL({ registers: [reg('store-a', '84')] })
        setStoreBarcodes({ 'store-a': ['1001'] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [makeProduct(1)] }
        })

        await importComaxProducts({}, { DL, external })

        assert.equal(pulls.length, 0)
    })

    it('prunes the store ids of registers that no longer exist', async () => {
        const { DL, prunes } = makeDL()
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)], 52: [makeProduct(1)] },
            departments: { 13: [makeProduct(2)] }
        })

        const result = await importComaxProducts({}, { DL, external })

        assert.deepEqual(prunes, [{
            filter: { storeIds: { $exists: true } },
            update: { $pull: { storeIds: { $nin: ['store-a', 'store-b'] } } }
        }])
        assert.equal(result.prunedStoreIds, 1)
    })

    it('prunes stale store ids even when a feed is incomplete', async () => {
        const { DL, prunes } = makeDL()
        const { external } = makeExternal({
            stores: { 84: { items: [makeProduct(0)], throwAfter: 0 }, 52: [makeProduct(1)] },
            departments: { 13: [makeProduct(2)] }
        })

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(prunes.length, 1)
        assert.equal(result.status, 'partial')
    })

    it('never removes store ids when a feed is empty', async () => {
        const { DL, pulls, setStoreBarcodes } = makeDL({ registers: [reg('store-a', '84')] })
        setStoreBarcodes({ 'store-a': ['1000', '9999'] })
        const { external } = makeExternal({
            stores: { 84: { items: [makeProduct(0)], blocks: 0 } },
            departments: { 13: [makeProduct(1)] }
        })

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(pulls.length, 0)
        assert.equal(result.status, 'partial')
    })

    it('never removes store ids when a feed hits the 17,000 item cap', async () => {
        const { DL, pulls, setStoreBarcodes } = makeDL({ registers: [reg('store-a', '84')] })
        setStoreBarcodes({ 'store-a': ['1000', '9999'] })
        const { external } = makeExternal({
            stores: { 84: { items: [makeProduct(0)], blocks: 17000 } },
            departments: { 13: [makeProduct(1)] }
        })

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(pulls.length, 0)
        assert.equal(result.status, 'partial')
    })

    it('never removes store ids when a feed collapses against the previous run', async () => {
        const { DL, pulls, setStoreBarcodes } = makeDL({
            registers: [reg('store-a', '84')],
            state: { key: 'products', feeds: { 'store:store-a': 5000 } }
        })
        setStoreBarcodes({ 'store-a': ['1000', '9999'] })
        const { external } = makeExternal({
            stores: { 84: { items: [makeProduct(0)], blocks: 10 } },
            departments: { 13: [makeProduct(1)] }
        })

        await importComaxProducts({}, { DL, external })

        assert.equal(pulls.length, 0)
    })

    it('never removes store ids when an item could not be parsed', async () => {
        const { DL, pulls, setStoreBarcodes } = makeDL({ registers: [reg('store-a', '84')] })
        setStoreBarcodes({ 'store-a': ['9999'] })
        const { external } = makeExternal({
            stores: { 84: { items: [makeProduct(0)], unparsed: 1 } },
            departments: { 13: [makeProduct(1)] }
        })

        await importComaxProducts({}, { DL, external })

        assert.equal(pulls.length, 0)
    })

    it('still writes the feeds when one stream dies, and skips removals', async () => {
        const { DL, pulls, stateUpdates } = makeDL()
        const { external } = makeExternal({
            stores: {
                84: { items: [makeProduct(0)], throwAfter: 0 },
                52: [makeProduct(1)]
            },
            departments: { 13: [makeProduct(2)] }
        })

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(result.status, 'partial')
        assert.equal(result.count, 2)
        assert.equal(pulls.length, 0)
        const update = lastStateUpdate(stateUpdates, 'products')
        assert.equal(update.update.$set.lastSyncAt, undefined)
    })

    it('records run status and feed sizes without advancing a watermark', async () => {
        const { DL, stateUpdates } = makeDL()
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)], 52: [makeProduct(1)] },
            departments: { 13: [makeProduct(2)] }
        })

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(result.message, 'Import complete')
        const update = lastStateUpdate(stateUpdates, 'products')
        assert.equal(update.update.$set.status, 'success')
        assert.equal(update.update.$set.lastSyncAt, undefined)
        assert.equal(update.update.$set.processed, 3)
        assert.equal(update.update.$set.failed, 0)
        assert.deepEqual(update.update.$set.feeds, {
            'store:store-a': 1,
            'store:store-b': 1,
            'department:13': 1
        })
    })

    it('reports a partial run when a batch fails and still skips removals', async () => {
        const { DL, pulls, stateUpdates } = makeDL({ failBatch: true })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)], 52: [makeProduct(1)] },
            departments: { 13: [makeProduct(2)] }
        })

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(result.message, 'Import partially failed')
        assert.equal(result.status, 'partial')
        assert.equal(pulls.length, 0)
        const update = lastStateUpdate(stateUpdates, 'products')
        assert.equal(update.update.$set.failed, 3)
        assert.equal(update.update.$set.lastSyncAt, undefined)
    })

    it('skips the run entirely when there is no active cash register', async () => {
        const { DL, stateUpdates, prunes } = makeDL({ registers: [] })
        const { external, calls } = makeExternal()

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(result.message, 'No active cash registers')
        assert.equal(calls.stores.length, 0)
        assert.equal(prunes.length, 0)
        const update = lastStateUpdate(stateUpdates, 'products')
        assert.equal(update.update.$set.status, 'skipped')
    })

    it('records a register without StockStoreID and keeps going', async () => {
        const { DL, stateUpdates } = makeDL({
            registers: [reg('store-a', ''), reg('store-b', '52')]
        })
        const { external, calls } = makeExternal({
            stores: { 52: [makeProduct(0)] },
            departments: { 13: [makeProduct(1)] }
        })

        const result = await importComaxProducts({}, { DL, external })

        assert.deepEqual(calls.stores.map(c => c.storeId), ['52'])
        assert.equal(result.status, 'partial')
        assert.equal(lastStateUpdate(stateUpdates, 'products').update.$set.failed, 0)
    })

    it('asks for the whole in-stock snapshot, not a delta', async () => {
        const { DL } = makeDL()
        const { external, calls } = makeExternal({
            stores: { 84: [makeProduct(0)], 52: [makeProduct(1)] },
            departments: { 13: [makeProduct(2)] }
        })

        await importComaxProducts({}, { DL, external })

        for (const call of [...calls.stores, ...calls.departments]) {
            assert.equal(call.lastUpdatedFromDate, undefined)
            assert.equal(call.timeoutMs > 0, true)
        }
    })
})

describe('comax sales window', () => {
    const SETTINGS = {
        'comax.freshDepartments': '13',
        'comax.salesWindow': { defaultDays: 30, rules: [] }
    }

    const daysAgo = days => new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    function row(barcode, departmentCode, lastSaleDate, salesLastDays = 0) {
        return { barcode, departmentCode, lastSaleDate, salesLastDays }
    }

    it('asks every store for the widest configured window', async () => {
        const { DL } = makeDL({
            settings: {
                ...SETTINGS,
                'comax.salesWindow': { defaultDays: 30, rules: [{ days: 90, departments: ['54'] }] }
            }
        })
        const { external, calls } = makeExternal({
            stores: { 84: [makeProduct(0)], 52: [makeProduct(1)] },
            departments: { 13: [makeProduct(2)] },
            salesWindows: { 84: [], 52: [] }
        })

        await importComaxProducts({}, { DL, external })

        assert.deepEqual(calls.salesWindow.map(c => c.storeId), ['84', '52'])
        for (const call of calls.salesWindow) assert.equal(call.days, 90)
    })

    it('keeps the store id when the item sold inside its window', async () => {
        const { DL, pulls, modelBulkWrites, setStoreBarcodes } = makeDL({
            registers: [reg('store-a', '84')],
            settings: SETTINGS
        })
        setStoreBarcodes({ 'store-a': ['1000'] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [makeProduct(1)] },
            salesWindows: { 84: [row('1000', '13', daysAgo(10))] }
        })

        await importComaxProducts({}, { DL, external })

        assert.equal(pulls.length, 0)
        assert.deepEqual(modelBulkWrites[0].updateOne.filter, { barcode: '1000' })
        assert.ok(modelBulkWrites[0].updateOne.update.$max.lastSaleDate instanceof Date)
    })

    it('names a sold item that has no catalog row', async () => {
        const { DL, setAllBarcodes } = makeDL({ registers: [reg('store-a', '84')], settings: SETTINGS })
        setAllBarcodes(['1000'])
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [makeProduct(1)] },
            salesWindows: { 84: [row('1000', '13', daysAgo(10)), row('7290000000999', '13', daysAgo(4))] }
        })

        const result = await importComaxProducts({}, { DL, external })

        // A barcode that sold and never became a row is invisible to the catalog
        // report, and no feed is allowed to invent it: the import says so instead,
        // because the catalog backfill is what can bring that item in.
        assert.equal(result.soldWithoutRow, 1)
    })

    it('creates a row for a price-less department item that sold, not for one that did not', async () => {
        const { DL, writes } = makeDL({ registers: [reg('store-a', '84')], settings: SETTINGS })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [makeProduct(1, { price: 0 }), makeProduct(2, { price: 0 })] },
            salesWindows: { 84: [row('1001', '13', daysAgo(4))] }
        })

        const result = await importComaxProducts({}, { DL, external })

        // 1001 sold, so it earns a row even though Comax has no price for it.
        // 1002 came from a department feed, which asserts nothing about stock: Comax
        // lists every item in the department, stocked or not, so one with no price in
        // either list that sells nothing is noise and stays out of the catalog.
        updateFor(writes, '1001')
        assert.throws(() => updateFor(writes, '1002'), /was not written/)
        assert.equal(result.noPrice, 1)
        assert.equal(result.noPriceSkipped, 1)
    })

    it('creates a row for an item Comax prices for buying but has no selling price for', async () => {
        const { DL, writes } = makeDL({ registers: [reg('store-a', '84')], settings: SETTINGS })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [makeProduct(1, { price: 0, buyingPrice: 42 })] },
            salesWindows: { 84: [row('1000', '13', daysAgo(4))] }
        })

        const result = await importComaxProducts({}, { DL, external })

        // 139232 מסטר נתחים צלעות בקר טרי חלק: the chain buys it at 42 and Comax has
        // nothing to sell it for. That is a price-list gap worth a row even in a
        // month it sells nothing.
        assert.equal(updateFor(writes, '1001').$set.buyingPrice, 42)
        assert.equal(result.noPrice, 1)
        assert.equal(result.noPriceSkipped, 0)
    })

    it('keeps writing a price-less row that already exists even when nothing sells it', async () => {
        const { DL, writes, setAllBarcodes } = makeDL({ registers: [reg('store-a', '84')], settings: SETTINGS })
        setAllBarcodes(['1002'])
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [makeProduct(1), makeProduct(2, { price: 0 })] },
            salesWindows: { 84: [row('1001', '13', daysAgo(4))] }
        })

        const result = await importComaxProducts({}, { DL, external })

        // Rows the catalog backfill or the buying price CSV created are the import's
        // to keep refreshing: the gate must not let a quiet month drop them, because
        // the whole point of them is that the report can name the missing price.
        const update = updateFor(writes, '1002')
        assert.equal(update.$set.price, 0)
        assert.equal(result.noPrice, 1)
        assert.equal(result.noPriceSkipped, 0)
    })

    it('removes the store id when the item did not sell inside its window', async () => {
        const { DL, pulls, setStoreBarcodes } = makeDL({
            registers: [reg('store-a', '84')],
            settings: SETTINGS
        })
        setStoreBarcodes({ 'store-a': ['1000'] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [makeProduct(1)] },
            salesWindows: { 84: [row('1000', '13', daysAgo(60))] }
        })

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(pulls.length, 1)
        assert.deepEqual(pulls[0].filter, { barcode: { $in: ['1000'] }, storeIds: 'store-a' })
        assert.deepEqual(pulls[0].update, { $pull: { storeIds: 'store-a' } })
        assert.equal(result.removed, 1)
    })

    it('judges each department by its own window', async () => {
        const { DL, pulls, setStoreBarcodes } = makeDL({
            registers: [reg('store-a', '84')],
            settings: {
                ...SETTINGS,
                'comax.salesWindow': { defaultDays: 30, rules: [{ days: 90, departments: ['54'] }] }
            }
        })
        setStoreBarcodes({ 'store-a': ['1000', '1001'] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0), makeProduct(1)] },
            departments: { 13: [] },
            salesWindows: {
                84: [row('1000', '13', daysAgo(60)), row('1001', '54', daysAgo(60))]
            }
        })

        await importComaxProducts({}, { DL, external })

        assert.equal(pulls.length, 1)
        assert.deepEqual(pulls[0].filter.barcode.$in, ['1000'])
    })

    it('treats 0 days as "never filter this department"', async () => {
        const { DL, pulls, setStoreBarcodes } = makeDL({
            registers: [reg('store-a', '84')],
            settings: {
                ...SETTINGS,
                'comax.salesWindow': { defaultDays: 30, rules: [{ days: 0, departments: ['13'] }] }
            }
        })
        setStoreBarcodes({ 'store-a': ['1000'] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [] },
            salesWindows: { 84: [row('1000', '13', daysAgo(400))] }
        })

        await importComaxProducts({}, { DL, external })

        assert.equal(pulls.length, 0)
    })

    it('keeps an item whose last sale date cannot be read', async () => {
        const { DL, pulls, setStoreBarcodes } = makeDL({
            registers: [reg('store-a', '84')],
            settings: SETTINGS
        })
        setStoreBarcodes({ 'store-a': ['1000'] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [] },
            salesWindows: { 84: [row('1000', '13', null)] }
        })

        await importComaxProducts({}, { DL, external })

        assert.equal(pulls.length, 0)
    })

    it('never removes store ids when the sales feed is empty', async () => {
        const { DL, pulls, stateUpdates, setStoreBarcodes } = makeDL({
            registers: [reg('store-a', '84')],
            settings: SETTINGS,
            state: { key: 'products', feeds: { 'salesWindow:store-a': 5000 } }
        })
        setStoreBarcodes({ 'store-a': ['1000'] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [makeProduct(1)] },
            salesWindows: { 84: [] }
        })

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(pulls.length, 0)
        assert.equal(result.status, 'success')
        const feeds = lastStateUpdate(stateUpdates, 'products').update.$set.feeds
        assert.equal(feeds['salesWindow:store-a'], 5000)
    })

    it('never removes store ids when the sales feed collapses', async () => {
        const { DL, pulls, setStoreBarcodes } = makeDL({
            registers: [reg('store-a', '84')],
            settings: SETTINGS,
            state: { key: 'products', feeds: { 'salesWindow:store-a': 5000 } }
        })
        setStoreBarcodes({ 'store-a': ['1000'] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [] },
            salesWindows: { 84: { items: [row('1000', '13', daysAgo(60))], blocks: 10 } }
        })

        await importComaxProducts({}, { DL, external })

        assert.equal(pulls.length, 0)
    })

    it('never removes store ids when the sales stream dies', async () => {
        const { DL, pulls, setStoreBarcodes } = makeDL({
            registers: [reg('store-a', '84')],
            settings: SETTINGS
        })
        setStoreBarcodes({ 'store-a': ['1000'] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [] },
            salesWindows: { 84: { items: [row('1000', '13', daysAgo(60))], throwAfter: 0 } }
        })

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(pulls.length, 0)
        assert.equal(result.status, 'partial')
    })

    it('skips the whole step when every window is 0', async () => {
        const { DL, pulls, setStoreBarcodes } = makeDL({
            registers: [reg('store-a', '84')],
            settings: { ...SETTINGS, 'comax.salesWindow': { defaultDays: 0, rules: [] } }
        })
        setStoreBarcodes({ 'store-a': ['1000'] })
        const { external, calls } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [] }
        })

        await importComaxProducts({}, { DL, external })

        assert.equal(calls.salesWindow.length, 0)
        assert.equal(pulls.length, 0)
    })

    it('sums SalesLastDays over the stores into the catalog', async () => {
        const { DL, modelBulkWrites, setStoreBarcodes } = makeDL({
            registers: [reg('store-a', '84'), reg('store-b', '52')],
            settings: SETTINGS
        })
        setStoreBarcodes({ 'store-a': [], 'store-b': [] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)], 52: [makeProduct(1)] },
            departments: { 13: [] },
            salesWindows: {
                84: [row('1000', '13', daysAgo(1), 10.5), row('1001', '13', daysAgo(2), 2)],
                52: [row('1000', '13', daysAgo(3), 4.25)]
            }
        })

        await importComaxProducts({}, { DL, external })

        const units = modelBulkWrites
            .filter(w => w.updateOne?.update?.$set?.salesLastDays != null)
            .map(w => [w.updateOne.filter.barcode, w.updateOne.update.$set.salesLastDays])
            .sort()
        assert.deepEqual(units, [['1000', 14.75], ['1001', 2]])
    })

    it('resets an item that sold nothing in the window to 0 units', async () => {
        const { DL, zeroed, setStoreBarcodes } = makeDL({
            registers: [reg('store-a', '84')],
            settings: SETTINGS
        })
        setStoreBarcodes({ 'store-a': [] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)] },
            departments: { 13: [] },
            salesWindows: { 84: [row('1000', '13', daysAgo(1), 7)] }
        })

        await importComaxProducts({}, { DL, external })

        assert.equal(zeroed.length, 1)
        assert.deepEqual(zeroed[0].filter, { barcode: { $nin: ['1000'] } })
        assert.deepEqual(zeroed[0].update, { $set: { salesLastDays: 0 } })
    })

    it('stores no units when a store feed was skipped', async () => {
        const { DL, zeroed, modelBulkWrites, setStoreBarcodes } = makeDL({
            registers: [reg('store-a', '84'), reg('store-b', '52')],
            settings: SETTINGS,
            state: { key: 'products', feeds: { 'salesWindow:store-b': 5000 } }
        })
        setStoreBarcodes({ 'store-a': [], 'store-b': [] })
        const { external } = makeExternal({
            stores: { 84: [makeProduct(0)], 52: [makeProduct(1)] },
            departments: { 13: [] },
            salesWindows: {
                84: [row('1000', '13', daysAgo(1), 9)],
                // Collapsed against the stored baseline, so the store is skipped.
                52: { items: [row('1000', '13', daysAgo(1), 9)], blocks: 10 }
            }
        })

        await importComaxProducts({}, { DL, external })

        assert.equal(zeroed.length, 0)
        assert.equal(
            modelBulkWrites.filter(w => w.updateOne?.update?.$set?.salesLastDays != null).length,
            0
        )
    })
})
