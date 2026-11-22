import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import restoreDeletedProducts from '../../server/scripts/restoreDeletedProducts.js'

const snapshot = (barcode, over = {}) => ({
    id: `d-${barcode}`,
    barcode,
    mainBarcode: '1111111111111',
    product: { barcode, name: 'כפול', images: { product: [{ url: 'https://example.com/x.jpg' }] }, ...over },
    reason: 'barcode-alias-import'
})

function makeDL({ snapshots = [], products = [] } = {}) {
    const calls = { inserted: [], ownerUpdates: [], marked: [] }
    const DL = {
        DeletedProduct: {
            Model: {},
            read: async () => snapshots,
            updateOne: async (filter, update) => {
                calls.marked.push({ filter, update })
                return { modifiedCount: 1 }
            }
        },
        Product: {
            readOne: async filter =>
                products.find(product =>
                    (filter.barcode && product.barcode === filter.barcode)
                    || (filter.id && product.id === filter.id)) || null,
            updateOne: async (filter, update) => {
                calls.ownerUpdates.push({ filter, update })
                return { modifiedCount: 1 }
            },
            Model: {
                collection: {
                    insertOne: async doc => {
                        calls.inserted.push(doc)
                        return { acknowledged: true }
                    }
                }
            }
        }
    }
    return { DL, calls }
}

const OWNER = { id: 'p-owner', barcode: '1111111111111', scannableBarcodes: ['2222222222222', '3333333333333'] }

describe('restore deleted products', () => {
    it('puts the exact doc back and drops only its alias from the owner', async () => {
        const { DL, calls } = makeDL({
            snapshots: [snapshot('2222222222222')],
            products: [OWNER]
        })

        const stats = await restoreDeletedProducts({ DL }, { barcode: '2222222222222' })

        assert.equal(stats.restored, 1)
        assert.deepEqual(calls.inserted[0].images.product[0].url, 'https://example.com/x.jpg')
        assert.deepEqual(calls.ownerUpdates[0].filter, { id: 'p-owner' })
        assert.deepEqual(calls.ownerUpdates[0].update.scannableBarcodes, ['3333333333333'])
        assert.ok(calls.marked[0].update.restoredAt instanceof Date)
    })

    it('writes nothing on a dry run', async () => {
        const { DL, calls } = makeDL({ snapshots: [snapshot('2222222222222')], products: [OWNER] })

        const stats = await restoreDeletedProducts({ DL }, { mainBarcode: '1111111111111', dryRun: true })

        assert.equal(stats.snapshots, 1)
        assert.deepEqual(calls.inserted, [])
        assert.deepEqual(calls.ownerUpdates, [])
        assert.deepEqual(calls.marked, [])
    })

    it('leaves a restored snapshot and a barcode that is back in the catalog alone', async () => {
        const { DL, calls } = makeDL({
            snapshots: [
                { ...snapshot('2222222222222'), restoredAt: new Date() },
                snapshot('3333333333333')
            ],
            // 3333333333333 was recreated by an admin: the snapshot must not
            // overwrite it.
            products: [{ id: 'p-new', barcode: '3333333333333' }, OWNER]
        })

        const stats = await restoreDeletedProducts({ DL }, { all: true })

        assert.deepEqual(stats, { snapshots: 1, restored: 0, skipped: 1, errors: 0 })
        assert.deepEqual(calls.inserted, [])
    })

    it('requires something to restore', async () => {
        const { DL } = makeDL({})
        await assert.rejects(() => restoreDeletedProducts({ DL }, {}), /choose what to restore/)
    })
})
