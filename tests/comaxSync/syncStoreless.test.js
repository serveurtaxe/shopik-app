import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import syncComax from '../../server/api/comax_product/sync.js'

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden', ARCHIVED: 'archived' }

// The sweep must not depend on having anything to sync: a product whose Comax
// row is gone is only ever reached by this pass.
describe('comax sync storeless sweep', () => {
    it('runs even when there is no Comax row to sync', async () => {
        const updates = []
        const DL = {
            ComaxProduct: { count: async () => 0, read: async () => [] },
            CategoryMap: { read: async () => [] },
            Product: {
                constants: { STATUS },
                update: async (filter, update) => {
                    updates.push({ filter, update })
                    return { modifiedCount: 0 }
                }
            }
        }

        const result = await syncComax({}, { DL })

        assert.equal(result.synced, 0)
        assert.deepEqual(updates, [{
            filter: { status: 'active', 'storeIds.0': { $exists: false } },
            update: { status: 'hidden' }
        }])
    })
})
