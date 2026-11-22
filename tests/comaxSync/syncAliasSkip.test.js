import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import syncComax from '../../server/api/comax_product/sync.js'

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden', ARCHIVED: 'archived' }

const codes = barcode => ({ superDepartmentCode: '3', departmentCode: '30', groupCode: '301', subGroupCode: '10110', barcode })

// Comax still sells the item under its old barcode: the row exists, but the
// catalog must not grow a second product for it.
const rows = [
    { ...codes('1111111111111'), comaxId: 'c1', name: 'ראשי', price: 12, buyingPrice: 8, showInWeb: true, storeIds: [], salesLastDays: 519 },
    { ...codes('2222222222222'), comaxId: 'c2', name: 'משני', price: 11, buyingPrice: 7, showInWeb: true, storeIds: ['store-b'], salesLastDays: 207 }
]

const ownerDoc = {
    id: 'p-main',
    barcode: '1111111111111',
    scannableBarcodes: ['2222222222222'],
    images: { product: [{ url: 'https://example.com/a.jpg' }] },
    prices: [{ domainId: 'dom', price: 12 }],
    buyingPrice: 8
}

describe('comax sync alias barcodes', () => {
    it('never creates a product for a barcode that is someone else\'s alias', async () => {
        const writes = []
        const DL = {
            ComaxProduct: {
                count: async filter => (filter?.buyingPrice ? 1 : rows.length),
                read: async (filter = {}, select, options) => {
                    if (filter.active === false) return []
                    const after = filter.barcode?.$gt
                    const found = rows.filter(row => !after || row.barcode > after)
                    return found.slice(0, options?.limit || found.length)
                },
                update: async () => ({ modifiedCount: 0 })
            },
            Domain: { readOne: async () => ({ id: 'dom' }) },
            Category: { read: async () => [] },
            CategoryMap: { read: async () => [] },
            Product: {
                constants: {
                    STATUS,
                    UNIT: { ITEM: 'item', WEIGHT: 'weight' },
                    BASE_UNIT: { UNIT: 'unit', KG: 'kg' }
                },
                Model: {
                    find: () => {
                        const chain = {
                            select: () => chain,
                            sort: () => chain,
                            limit: () => chain,
                            lean: async () => [ownerDoc]
                        }
                        return chain
                    }
                },
                read: async () => [],
                update: async () => ({ modifiedCount: 0 }),
                bulkWrite: async ({ docs, getUpdate }) => {
                    writes.push({ barcodes: docs.map(doc => doc.barcode), sets: docs.map(doc => (getUpdate ? getUpdate(doc) : null)) })
                    return { upsertedCount: 1, modifiedCount: docs.length }
                }
            }
        }

        const result = await syncComax({ skipImageEnqueue: true }, { DL })

        assert.equal(result.aliasesSkipped, 1)
        assert.equal(result.familyOwners, 1)

        // The alias barcode appears nowhere in what the sync wrote.
        for (const write of writes)
            assert.equal(write.barcodes.includes('2222222222222'), false)

        const family = writes.at(-1)
        assert.deepEqual(family.barcodes, ['1111111111111'])
        assert.deepEqual(family.sets[0].$set, {
            status: STATUS.ACTIVE,
            storeIds: ['store-b'],
            totalSalesUnits: 726
        })
    })
})
