import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import removeCouponFromCart from '../../server/utils/data/removeCouponFromCart.js'

function build({ order, saved }) {
    const updates = []
    const timeline = []
    const DL = {
        Order: {
            updateOne: async (filter, update) => {
                updates.push({ filter, update })
                return saved ?? { ...order, ...update.$set }
            }
        },
        Timeline: {
            constants: { EVENT_TYPES: { ORDER_COUPON: 'order_coupon' } }
        }
    }
    const utils = {
        data: {
            timeline: {
                record: async event => {
                    timeline.push(event)
                    return event
                }
            }
        }
    }
    return { DL, utils, updates, timeline }
}

function cart(overrides = {}) {
    return {
        id: 'o1',
        userId: 'u1',
        status: 'cart',
        sum: 100,
        sumNoCoupon: 100,
        shipping: 15,
        finalSum: 80,
        finalSumWithShipping: 95,
        coupons: [{ code: 'save20' }],
        ...overrides
    }
}

describe('removeCouponFromCart', () => {
    it('returns null when the coupon is not on the order', async () => {
        const order = cart({ coupons: [{ code: 'other' }] })
        const { DL, utils, updates, timeline } = build({ order })

        const res = await removeCouponFromCart({ DL, utils, order, code: 'save20' })

        assert.equal(res, null)
        assert.equal(updates.length, 0)
        assert.equal(timeline.length, 0)
    })

    it('returns null for an empty order or code', async () => {
        const { DL, utils, updates } = build({ order: cart() })

        assert.equal(await removeCouponFromCart({ DL, utils, order: null, code: 'save20' }), null)
        assert.equal(await removeCouponFromCart({ DL, utils, order: cart(), code: '' }), null)
        assert.equal(updates.length, 0)
    })

    it('clears the coupon, restores pre-coupon totals and records a timeline entry', async () => {
        const order = cart()
        const actor = { role: 'user', id: 'u1' }
        const { DL, utils, updates, timeline } = build({ order })

        const res = await removeCouponFromCart({ DL, utils, order, code: 'SAVE20', actor })

        assert.equal(updates.length, 1)
        assert.deepEqual(updates[0].filter, { id: 'o1' })
        const set = updates[0].update.$set
        assert.deepEqual(set.coupons, [])
        assert.equal(set.finalSum, 100)
        assert.equal(set.finalSumWithShipping, 115)
        assert.equal(set.sumWithShipping, 115)
        assert.equal(set.finalSumNoCoupon, 100)
        assert.ok(set.customerUpdatedAt instanceof Date)

        assert.equal(res.finalSum, 100)
        assert.equal(timeline.length, 1)
        assert.equal(timeline[0].eventType, 'order_coupon')
        assert.deepEqual(timeline[0].actor, actor)
        assert.deepEqual(timeline[0].changes.oldData.coupons, [{ code: 'save20' }])
        assert.deepEqual(timeline[0].changes.newData.coupons, [])
    })

    it('falls back to the pre-removal order when the write returns nothing', async () => {
        const order = cart()
        const { DL, utils } = build({ order, saved: null })
        DL.Order.updateOne = async () => null

        const res = await removeCouponFromCart({ DL, utils, order, code: 'save20' })

        assert.equal(res, order)
    })
})
