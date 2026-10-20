import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    buildSyncFilter,
    hideActiveProduct,
    hideInactiveProducts
} from '../../server/api/comax_product/syncRules.js'

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden' }
const INACTIVE_FILTER = { active: false, barcode: { $nin: [null, ''] } }

describe('comax sync rules', () => {
    it('excludes explicitly inactive comax products', () => {
        assert.deepEqual(buildSyncFilter(), {
            active: { $ne: false },
            superDepartmentCode: { $exists: true, $nin: ['12', null] },
            departmentCode: { $exists: true },
            groupCode: { $exists: true }
        })
    })

    it('hides only an active product for one barcode', async () => {
        const calls = []
        const DL = {
            Product: {
                constants: { STATUS },
                update: async (filter, update) => {
                    calls.push({ filter, update })
                    return { modifiedCount: 1 }
                }
            }
        }

        const hidden = await hideActiveProduct({ DL, barcode: '123' })

        assert.equal(hidden, 1)
        assert.deepEqual(calls, [{
            filter: { barcode: '123', status: 'active' },
            update: { status: 'hidden' }
        }])
    })

    it('does nothing without a barcode', async () => {
        const DL = {
            Product: {
                constants: { STATUS },
                update: async () => { throw new Error('should not update') }
            }
        }

        assert.equal(await hideActiveProduct({ DL }), 0)
    })

    it('hides active products for inactive comax rows in batches', async () => {
        const updates = []
        const DL = {
            ComaxProduct: {
                count: async filter => {
                    assert.deepEqual(filter, INACTIVE_FILTER)
                    return 3
                },
                read: async (filter, select, { skip }) => {
                    assert.deepEqual(filter, INACTIVE_FILTER)
                    assert.deepEqual(select, { _id: 0, barcode: 1 })
                    return skip === 0
                        ? [{ barcode: '1' }, { barcode: '2' }]
                        : [{ barcode: '3' }]
                }
            },
            Product: {
                constants: { STATUS },
                update: async (filter, update) => {
                    updates.push({ filter, update })
                    return { modifiedCount: filter.barcode.$in.length }
                }
            }
        }

        const hidden = await hideInactiveProducts({ DL, batchSize: 2 })

        assert.equal(hidden, 3)
        assert.deepEqual(updates, [
            {
                filter: { barcode: { $in: ['1', '2'] }, status: 'active' },
                update: { status: 'hidden' }
            },
            {
                filter: { barcode: { $in: ['3'] }, status: 'active' },
                update: { status: 'hidden' }
            }
        ])
    })

    it('stops when there are no inactive comax rows', async () => {
        const DL = {
            ComaxProduct: {
                count: async filter => {
                    assert.deepEqual(filter, INACTIVE_FILTER)
                    return 0
                }
            },
            Product: {
                constants: { STATUS },
                update: async () => { throw new Error('should not update') }
            }
        }

        assert.equal(await hideInactiveProducts({ DL }), 0)
    })
})
