import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import adminChoose from '../../server/api/order/window/admin_choose.js'

const FUTURE = new Date(Date.now() + 60 * 60 * 1000)

function makeOrder(overrides = {}) {
    return {
        id: 'o1',
        status: 'paid',
        storeId: 's1',
        deliveryMethod: 'delivery',
        address: { areaId: 'a1' },
        window: { id: 'old-window' },
        payment: {},
        ...overrides
    }
}

function makeWindow(overrides = {}) {
    return {
        id: 'w1',
        storeId: 's1',
        date: '2026-11-23',
        start: 10,
        end: 12,
        leadTimestamp: FUTURE,
        active: true,
        disabled: false,
        totalOrders: 1,
        maxCapacity: 5,
        areaGroups: [],
        ...overrides
    }
}

function makeHarness({ order = makeOrder(), window = makeWindow(), reserve = {}, specials = [] } = {}) {
    const calls = {
        windowUpdate: null,
        orderUpdate: null,
        timeline: null,
        released: []
    }

    const DL = {
        Order: {
            constants: {
                DELIVERY_METHOD: { DELIVERY: 'delivery', PICKUP: 'pickup' },
                ORDER_STATUS: { CART: 'cart' }
            },
            defaultSelect: { select: true },
            readById: async () => order,
            updateOne: async (filter, update, options) => {
                calls.orderUpdate = { filter, update, options }
                return { ...order, ...update.$set }
            },
            Model: {
                find: () => ({ lean: async () => [] })
            }
        },
        OrderWindow: {
            readById: async () => window,
            Model: {
                findOneAndUpdate: (filter, update, options) => {
                    calls.windowUpdate = { filter, update, options }
                    return {
                        lean: async () => {
                            if (reserve.returnNull) return null
                            return {
                                ...window,
                                totalOrders: window.totalOrders + 1
                            }
                        }
                    }
                },
                updateOne: async (filter, update, options) => {
                    calls.released.push({ filter, update, options })
                }
            }
        },
        SpecialDay: {
            read: async () => specials
        },
        Timeline: {
            constants: { EVENT_TYPES: { ORDER_WINDOW: 'order_window' } }
        }
    }

    const utils = {
        data: {
            timeline: {
                record: async entry => { calls.timeline = entry },
                adminActor: admin => ({ adminId: admin.id })
            }
        }
    }

    return { DL, utils, calls }
}

const admin = { id: 'a1', name: { first: 'Admin', last: 'One' } }

describe('order/window/admin_choose', () => {
    it('refuses to change a captured order', async () => {
        const order = makeOrder({ payment: { captureProviderTxnId: 'txn-1' } })
        const { DL, utils } = makeHarness({ order })

        await assert.rejects(
            adminChoose({ orderId: 'o1', windowId: 'w1' }, { DL, _admin: admin, utils }),
            err => err.status === 403
        )
    })

    it('refuses a status the admin may not change', async () => {
        const order = makeOrder({ status: 'done' })
        const { DL, utils } = makeHarness({ order })

        await assert.rejects(
            adminChoose({ orderId: 'o1', windowId: 'w1' }, { DL, _admin: admin, utils }),
            err => err.status === 403
        )
    })

    it('requires allowFull when the capacity guard rejects the window', async () => {
        const window = makeWindow({ totalOrders: 5, maxCapacity: 5 })
        const { DL, utils, calls } = makeHarness({ window, reserve: { returnNull: true } })

        await assert.rejects(
            adminChoose({ orderId: 'o1', windowId: 'w1' }, { DL, _admin: admin, utils }),
            err => err.status === 409 && err.code === 'WINDOW_FULL'
        )
        assert.ok(calls.windowUpdate.filter.$expr, 'uses the capacity guard')
        assert.equal(calls.orderUpdate, null)
    })

    it('allows an explicitly confirmed full window and releases the old reservation', async () => {
        const window = makeWindow({ totalOrders: 5, maxCapacity: 5 })
        const { DL, utils, calls } = makeHarness({ window })

        const updated = await adminChoose(
            { orderId: 'o1', windowId: 'w1', allowFull: true },
            { DL, _admin: admin, utils }
        )

        assert.equal(updated.window.id, 'w1')
        assert.deepEqual(calls.windowUpdate.filter, { id: 'w1' })
        assert.equal(calls.windowUpdate.update.$inc.totalOrders, 1)
        assert.equal(calls.orderUpdate.filter.id, 'o1')
        assert.equal(calls.orderUpdate.update.$set.window.id, 'w1')
        assert.equal(calls.timeline.eventType, 'order_window')
        assert.deepEqual(calls.timeline.actor, { adminId: 'a1' })
        assert.ok(calls.released.some(call => call.filter.id === 'old-window'))
    })

    it('refuses a special-day closure even when the caller confirms a full window', async () => {
        const window = makeWindow({ totalOrders: 5, maxCapacity: 5 })
        const specials = [{ storeIds: ['s1'], start: null, end: null }]
        const { DL, utils, calls } = makeHarness({ window, specials })

        await assert.rejects(
            adminChoose(
                { orderId: 'o1', windowId: 'w1', allowFull: true },
                { DL, _admin: admin, utils }
            ),
            err => err.status === 400
        )
        assert.equal(calls.windowUpdate, null)
    })
})
