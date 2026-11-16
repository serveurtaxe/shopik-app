import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import syncComax from '../../server/api/comax_product/sync.js'

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden', ARCHIVED: 'archived' }

// Comax's archive marks seasonal stock, so the row must exist even while the
// item is off the site: the doc is created as ARCHIVED so the image worker and
// GS1 enrich have somewhere to put its pictures and kashrut before it returns.
// A row archived only for a missing buying price keeps the old rule (no doc),
// because nothing says it will come back.
describe('comax sync archived rows', () => {
    it('creates a doc for a Comax-archived item, but not for a price-archived one', async () => {
        const rows = [
            { barcode: '1111111111111', comaxId: '1', name: 'עונתי', archived: true, price: 10, buyingPrice: 5, storeIds: [] },
            { barcode: '2222222222222', comaxId: '2', name: 'בלי מחיר קנייה', archived: false, price: 10, buyingPrice: 0, storeIds: ['s1'] }
        ]
        const writes = []

        const DL = {
            ComaxProduct: {
                count: async filter => (filter?.buyingPrice ? 1 : rows.length),
                read: async (filter = {}, select, options) => {
                    if (filter.active === false) return []
                    const after = filter.barcode?.$gt
                    return rows
                        .filter(row => !after || row.barcode > after)
                        .slice(0, options?.limit || rows.length)
                },
                update: async () => ({ modifiedCount: 0 })
            },
            Domain: { readOne: async () => ({ id: 'domain-1' }) },
            Category: { read: async () => [] },
            CategoryMap: { read: async () => [], hasMap: false },
            Product: {
                constants: {
                    STATUS,
                    UNIT: { ITEM: 'item', WEIGHT: 'weight' },
                    BASE_UNIT: { UNIT: 'unit', KG: 'kg' }
                },
                read: async () => [],
                update: async () => ({ modifiedCount: 0 }),
                bulkWrite: async ({ docs, getUpsert, getFilter }) => {
                    writes.push({ docs, getUpsert, getFilter })
                    return { upsertedCount: docs.filter(getUpsert).length, modifiedCount: 0 }
                }
            }
        }

        const result = await syncComax({ skipImageEnqueue: true }, { DL })

        const { docs, getUpsert } = writes[0]
        const seasonal = docs.find(doc => doc.barcode === '1111111111111')
        const priceArchived = docs.find(doc => doc.barcode === '2222222222222')

        assert.equal(seasonal.status, STATUS.ARCHIVED)
        assert.equal(getUpsert(seasonal), true, 'a seasonal row needs a doc for its images/GS1 data')
        assert.equal(priceArchived.status, STATUS.ARCHIVED)
        assert.equal(getUpsert(priceArchived), false, 'a price-archived row stays doc-less')
        assert.equal(result.created, 1)
        assert.equal(result.archivedNoPrice, 1, 'only the price-archived row is counted there')
    })
})
