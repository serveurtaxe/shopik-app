import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import orderSchema from '../../server/dl/schemas/order.js'
import { mergeGroupCounts, releaseWindowReservation } from '../../server/utils/data/windowGroups.js'

describe('order window schema', () => {
    it('keeps reservedGroupId so releases can decrement the group counter', () => {
        assert.equal(orderSchema.window.reservedGroupId, String)
    })
})

describe('mergeGroupCounts', () => {
    it('preserves live counters by groupId and drops removed groups', () => {
        const merged = mergeGroupCounts(
            [{ groupId: 'a', capacity: 3, count: 2 }, { groupId: 'b', capacity: 1, count: 1 }],
            [{ groupId: 'a', capacity: 5 }]
        )
        assert.deepEqual(merged, [{ groupId: 'a', capacity: 5, count: 2 }])
    })
})

describe('releaseWindowReservation', () => {
    function makeDL() {
        const calls = []
        return {
            calls,
            OrderWindow: {
                Model: {
                    updateOne: async (filter, update, options) => {
                        calls.push({ filter, update, options })
                    }
                }
            }
        }
    }

    it('decrements the group counter when a group was reserved', async () => {
        const DL = makeDL()
        await releaseWindowReservation(DL, 'w1', 'g1')

        assert.equal(DL.calls.length, 2)
        assert.deepEqual(DL.calls[0].update, { $inc: { totalOrders: -1 } })
        assert.deepEqual(DL.calls[1].update, { $inc: { 'areaGroups.$[g].count': -1 } })
        assert.equal(DL.calls[1].options.arrayFilters[0]['g.groupId'], 'g1')
    })

    it('only decrements totalOrders when no group was reserved', async () => {
        const DL = makeDL()
        await releaseWindowReservation(DL, 'w1', null)

        assert.equal(DL.calls.length, 1)
        assert.deepEqual(DL.calls[0].update, { $inc: { totalOrders: -1 } })
    })
})
