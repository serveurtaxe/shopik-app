import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import orderSchema from '../../server/dl/schemas/order.js'
import {
    mergeGroupCounts,
    releaseWindowReservation,
    holdDeadline,
    selectionHoldDeadline,
    expireWindowHold,
    extendWindowHold,
    HOLD_MINUTES,
    PAYMENT_GRACE_MINUTES
} from '../../server/utils/data/windowGroups.js'

const MINUTE = 60 * 1000
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)

describe('order window schema', () => {
    it('keeps reservedGroupId so releases can decrement the group counter', () => {
        assert.equal(orderSchema.window.reservedGroupId, String)
    })

    it('stores the hold deadline and the one-off checkout extension', () => {
        assert.equal(orderSchema.window.holdUntil, Date)
        assert.equal(orderSchema.window.holdExtendedAt, Date)
    })
})

describe('window hold deadline', () => {
    it('uses holdUntil when present', () => {
        const holdUntil = new Date(NOW + 7 * MINUTE)
        assert.equal(holdDeadline({ id: 'w1', holdUntil }), holdUntil.getTime())
    })

    it('falls back to reservedAt + hold minutes for older carts', () => {
        assert.equal(
            holdDeadline({ id: 'w1', reservedAt: new Date(NOW) }),
            NOW + HOLD_MINUTES * MINUTE
        )
    })

    it('caps the reservedAt fallback by the lead time', () => {
        assert.equal(
            holdDeadline({
                id: 'w1',
                reservedAt: new Date(NOW),
                leadTimestamp: new Date(NOW + 5 * MINUTE)
            }),
            NOW + 5 * MINUTE
        )
    })

    it('reports no deadline when the cart has no hold information', () => {
        assert.equal(holdDeadline({ id: 'w1' }), null)
        assert.equal(holdDeadline(null), null)
    })

    it('never sets a selection hold past the window lead time', () => {
        assert.equal(
            selectionHoldDeadline({ now: NOW, leadTimestamp: NOW + 60 * MINUTE }),
            NOW + HOLD_MINUTES * MINUTE
        )
        assert.equal(
            selectionHoldDeadline({ now: NOW, leadTimestamp: NOW + 5 * MINUTE }),
            NOW + 5 * MINUTE
        )
        assert.equal(
            selectionHoldDeadline({ now: NOW, leadTimestamp: null }),
            NOW + HOLD_MINUTES * MINUTE
        )
    })
})

function makeExpiryDL({ matched = true } = {}) {
    const orderWrites = []
    const windowWrites = []
    return {
        orderWrites,
        windowWrites,
        Order: {
            constants: { ORDER_STATUS: { CART: 'cart' } },
            Model: {
                findOneAndUpdate: async (filter, update) => {
                    orderWrites.push({ filter, update })
                    return matched ? { id: 'o1' } : null
                }
            }
        },
        OrderWindow: {
            Model: {
                updateOne: async (filter, update, options) => {
                    windowWrites.push({ filter, update, options })
                }
            }
        }
    }
}

describe('expireWindowHold', () => {
    it('unsets the window and decrements both counters once', async () => {
        const DL = makeExpiryDL()
        const order = {
            id: 'o1',
            window: { id: 'w1', reservedGroupId: 'g1', holdUntil: new Date(NOW - 1000) }
        }

        assert.equal(await expireWindowHold(DL, order, { now: NOW }), true)
        assert.equal(order.window, undefined)
        assert.deepEqual(DL.orderWrites[0].update, { $unset: { window: 1 } })
        assert.equal(DL.orderWrites[0].filter['window.id'], 'w1')
        assert.equal(DL.windowWrites.length, 2)
        assert.deepEqual(DL.windowWrites[0].update, { $inc: { totalOrders: -1 } })
    })

    it('leaves a live hold alone', async () => {
        const DL = makeExpiryDL()
        const order = { id: 'o1', window: { id: 'w1', holdUntil: new Date(NOW + MINUTE) } }

        assert.equal(await expireWindowHold(DL, order, { now: NOW }), false)
        assert.equal(DL.orderWrites.length, 0)
        assert.equal(DL.windowWrites.length, 0)
        assert.ok(order.window)
    })

    it('does not decrement when the order no longer holds that window', async () => {
        const DL = makeExpiryDL({ matched: false })
        const order = { id: 'o1', window: { id: 'w1', holdUntil: new Date(NOW - MINUTE) } }

        assert.equal(await expireWindowHold(DL, order, { now: NOW }), false)
        assert.equal(DL.orderWrites.length, 1)
        assert.equal(DL.windowWrites.length, 0)
        assert.ok(order.window)
    })

    it('treats legacy carts without hold data as expired', async () => {
        const DL = makeExpiryDL()
        const order = { id: 'o1', window: { id: 'w1' } }

        assert.equal(await expireWindowHold(DL, order, { now: NOW }), true)
        assert.equal(order.window, undefined)
    })
})

describe('extendWindowHold', () => {
    function makeDL() {
        const calls = []
        return {
            calls,
            Order: {
                constants: { ORDER_STATUS: { CART: 'cart' } },
                Model: {
                    findOneAndUpdate: async (filter, update) => {
                        calls.push({ filter, update })
                        return { id: 'o1' }
                    }
                }
            }
        }
    }

    it('adds the checkout grace once to the remaining hold', async () => {
        const DL = makeDL()
        const holdUntil = NOW + 5 * MINUTE
        const order = { id: 'o1', window: { id: 'w1', holdUntil: new Date(holdUntil) } }

        const next = await extendWindowHold(DL, order, { now: NOW })

        assert.equal(next, holdUntil + PAYMENT_GRACE_MINUTES * MINUTE)
        assert.equal(DL.calls.length, 1)
        assert.deepEqual(DL.calls[0].filter, {
            id: 'o1',
            status: 'cart',
            'window.id': 'w1',
            'window.holdExtendedAt': null
        })
        assert.equal(order.window.holdUntil.getTime(), next)
    })

    it('never extends a reservation twice', async () => {
        const DL = makeDL()
        const order = {
            id: 'o1',
            window: {
                id: 'w1',
                holdUntil: new Date(NOW + MINUTE),
                holdExtendedAt: new Date(NOW - MINUTE)
            }
        }

        const next = await extendWindowHold(DL, order, { now: NOW })

        assert.equal(next, NOW + MINUTE)
        assert.equal(DL.calls.length, 0)
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
