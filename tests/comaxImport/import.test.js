import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import importComaxProducts from '../../server/api/comax_product/import.js'
import importComaxBuyingPrices from '../../server/api/comax_product/import_buying_price.js'

const WATERMARK = new Date('2026-10-20T00:00:00.000Z')

// The buying-price import refuses to run without a delivery price list.
process.env.COMAX_DELIVERY_PRICELIST_ID = '255'

function makeProduct(i, overrides = {}) {
    return {
        barcode: String(1000 + i),
        price: 10 + i,
        archived: false,
        superDepartmentCode: '3',
        ...overrides
    }
}

function makeDL({ state = null, legacy = null, failBatch = false } = {}) {
    const writes = []
    const stateUpdates = []

    const DL = {
        ComaxProduct: {
            Model: {
                findOne: () => {
                    const chain = {
                        sort: () => chain,
                        lean: async () => legacy
                    }
                    return chain
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
    return { DL, writes, stateUpdates }
}

function makeExternal(products, { onStream, throwAfter = null, blocks = null } = {}) {
    return {
        comax: {
            streamProducts: async function* (options) {
                if (onStream) onStream(options)
                let i = 0
                for (const product of products) {
                    if (throwAfter != null && i === throwAfter) throw new Error('the stream died')
                    yield product
                    i++
                }
                if (options.stats) {
                    options.stats.blocks = blocks ?? products.length
                    options.stats.kept = products.length
                    options.stats.unparsed = 0
                }
            }
        }
    }
}

function lastStateUpdate(stateUpdates, key) {
    return stateUpdates.filter(u => u.filter.key === key).pop()
}

describe('comax product import', () => {
    it('writes the streamed catalog in batches', async () => {
        const products = Array.from({ length: 2500 }, (_, i) => makeProduct(i))
        const { DL, writes } = makeDL()
        const external = makeExternal(products)

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(result.count, 2500)
        assert.equal(writes.length, 3)
        assert.deepEqual(writes.map(w => w.docs.length), [1000, 1000, 500])
    })

    it('stamps lastImportedAt on every imported product', async () => {
        const products = Array.from({ length: 3 }, (_, i) => makeProduct(i))
        const { DL, writes } = makeDL()
        const external = makeExternal(products)

        await importComaxProducts({}, { DL, external })

        const stamped = writes[0].docs.every(d => d.lastImportedAt instanceof Date)
        assert.ok(stamped)
        assert.equal(writes[0].docs.length, 3)
    })

    it('upserts only products with a price that are not archived', async () => {
        const products = [
            makeProduct(0),
            makeProduct(1, { price: 0 }),
            makeProduct(2, { archived: true })
        ]
        const { DL, writes } = makeDL()
        const external = makeExternal(products)

        await importComaxProducts({}, { DL, external })

        assert.deepEqual(writes[0].upserts, [true, false, false])
    })

    it('starts from the stored watermark', async () => {
        const { DL } = makeDL({ state: { key: 'products', lastSyncAt: WATERMARK } })
        let seen = null
        const external = makeExternal([makeProduct(0)], { onStream: o => { seen = o } })

        await importComaxProducts({}, { DL, external })

        assert.equal(seen.lastUpdatedFromDate.toISOString(), WATERMARK.toISOString())
    })

    it('falls back to the legacy per-doc watermark when there is no state yet', async () => {
        const legacy = new Date('2026-10-19T00:00:00.000Z')
        const { DL } = makeDL({ legacy: { lastImportedAt: legacy } })
        let seen = null
        const external = makeExternal([makeProduct(0)], { onStream: o => { seen = o } })

        await importComaxProducts({}, { DL, external })

        assert.equal(seen.lastUpdatedFromDate.toISOString(), legacy.toISOString())
    })

    it('asks for the whole catalog when there is no watermark at all', async () => {
        const { DL } = makeDL()
        let seen = null
        const external = makeExternal([makeProduct(0)], { onStream: o => { seen = o } })

        await importComaxProducts({}, { DL, external })

        assert.equal(seen.lastUpdatedFromDate, '')
    })

    it('advances the watermark after a successful run', async () => {
        const { DL, stateUpdates } = makeDL()
        const external = makeExternal([makeProduct(0), makeProduct(1)])

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(result.message, 'Import complete')
        const update = lastStateUpdate(stateUpdates, 'products')
        assert.equal(update.update.$set.status, 'success')
        assert.ok(update.update.$set.lastSyncAt instanceof Date)
        assert.equal(update.update.$set.processed, 2)
        assert.equal(update.update.$set.failed, 0)
    })

    it('does not advance the watermark when a batch fails', async () => {
        const { DL, stateUpdates } = makeDL({ failBatch: true })
        const external = makeExternal([makeProduct(0), makeProduct(1)])

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(result.message, 'Import partially failed')
        const update = lastStateUpdate(stateUpdates, 'products')
        assert.equal(update.update.$set.status, 'partial')
        assert.equal(update.update.$set.lastSyncAt, undefined)
        assert.equal(update.update.$set.failed, 2)
    })

    it('does not advance the watermark when the stream dies', async () => {
        const { DL, stateUpdates } = makeDL()
        const external = makeExternal([makeProduct(0), makeProduct(1)], { throwAfter: 1 })

        await assert.rejects(() => importComaxProducts({}, { DL, external }), /the stream died/)

        const update = lastStateUpdate(stateUpdates, 'products')
        assert.equal(update.update.$set.status, 'error')
        assert.equal(update.update.$set.lastSyncAt, undefined)
        assert.ok(update.update.$set.error)
    })

    it('does not advance the watermark when the response holds no item blocks', async () => {
        const { DL, stateUpdates } = makeDL()
        const external = makeExternal([], { blocks: 0 })

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(result.message, 'No products to import')
        const update = lastStateUpdate(stateUpdates, 'products')
        assert.equal(update.update.$set.status, 'skipped')
        assert.equal(update.update.$set.lastSyncAt, undefined)
    })

    it('does not advance the watermark when an item could not be parsed', async () => {
        const { DL, stateUpdates } = makeDL()
        const external = makeExternal([makeProduct(0)])
        external.comax.streamProducts = async function* (options) {
            yield makeProduct(0)
            options.stats.blocks = 1
            options.stats.kept = 1
            options.stats.unparsed = 1
        }

        const result = await importComaxProducts({}, { DL, external })

        assert.equal(result.message, 'Import partially failed')
        const update = lastStateUpdate(stateUpdates, 'products')
        assert.equal(update.update.$set.status, 'partial')
        assert.equal(update.update.$set.lastSyncAt, undefined)
        assert.equal(update.update.$set.failed, 1)
    })
})

describe('comax buying price import', () => {
    it('writes buying prices in batches and clears zero prices', async () => {
        const products = [makeProduct(0), makeProduct(1, { price: 0 })]
        const { DL, writes } = makeDL()
        const external = makeExternal(products)

        const result = await importComaxBuyingPrices({}, { DL, external })

        assert.equal(result.count, 2)
        assert.equal(writes.length, 1)
        assert.deepEqual(writes[0].docs[0], {
            barcode: '1000',
            buyingPrice: 10,
            buyingPriceImportedAt: writes[0].docs[0].buyingPriceImportedAt
        })
        assert.equal(writes[0].docs[1].buyingPrice, null)
        assert.ok(writes[0].docs[1].buyingPriceImportedAt instanceof Date)
    })

    it('never creates documents — the product import owns creation', async () => {
        const { DL, writes } = makeDL()
        const external = makeExternal([makeProduct(0)])

        await importComaxBuyingPrices({}, { DL, external })

        assert.equal(writes[0].upserts[0], false)
    })

    it('advances the buying price watermark after a successful run', async () => {
        const { DL, stateUpdates } = makeDL()
        const external = makeExternal([makeProduct(0)])

        await importComaxBuyingPrices({}, { DL, external })

        const update = lastStateUpdate(stateUpdates, 'buyingPrices')
        assert.equal(update.update.$set.status, 'success')
        assert.ok(update.update.$set.lastSyncAt instanceof Date)
    })

    it('does not advance the buying price watermark when a batch fails', async () => {
        const { DL, stateUpdates } = makeDL({ failBatch: true })
        const external = makeExternal([makeProduct(0)])

        await importComaxBuyingPrices({}, { DL, external })

        const update = lastStateUpdate(stateUpdates, 'buyingPrices')
        assert.equal(update.update.$set.status, 'partial')
        assert.equal(update.update.$set.lastSyncAt, undefined)
    })

    it('does not advance the buying price watermark when the stream dies', async () => {
        const { DL, stateUpdates } = makeDL()
        const external = makeExternal([makeProduct(0)], { throwAfter: 0 })

        await assert.rejects(() => importComaxBuyingPrices({}, { DL, external }), /the stream died/)

        const update = lastStateUpdate(stateUpdates, 'buyingPrices')
        assert.equal(update.update.$set.status, 'error')
        assert.equal(update.update.$set.lastSyncAt, undefined)
    })
})
