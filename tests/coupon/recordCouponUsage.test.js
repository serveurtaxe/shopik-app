import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import recordCouponUsage from '../../server/utils/data/recordCouponUsage.js'

function build({ coupons = {}, carts = [] } = {}) {
    const couponUpdates = []
    const cartUpdates = []
    const findFilters = []
    const timeline = []

    const DL = {
        Coupon: {
            readOne: async ({ code }) => coupons[code] ?? null,
            updateOne: async (filter, update) => {
                couponUpdates.push({ filter, update })
                return { id: filter.id }
            }
        },
        Order: {
            Model: {
                find: filter => {
                    findFilters.push(filter)
                    return { lean: async () => carts }
                }
            },
            updateOne: async (filter, update) => {
                cartUpdates.push({ filter, update })
                return { id: filter.id, ...update.$set }
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

    return { DL, utils, couponUpdates, cartUpdates, findFilters, timeline }
}

const order = {
    id: 'o1',
    userId: 'u1',
    status: 'cart',
    coupons: [{ code: 'save10' }]
}

function cart(overrides = {}) {
    return {
        id: 'o2',
        userId: 'u1',
        coupons: [{ code: 'save10' }],
        sum: 50,
        sumNoCoupon: 50,
        shipping: 0,
        ...overrides
    }
}

describe('recordCouponUsage', () => {
    it('blacklists the paying customer', async () => {
        const { DL, utils, couponUpdates } = build({
            coupons: { save10: { id: 'c1', code: 'save10', personal: false } }
        })

        await recordCouponUsage({ DL, utils, order })

        assert.equal(couponUpdates.length, 1)
        assert.deepEqual(couponUpdates[0].filter, { id: 'c1' })
        assert.deepEqual(couponUpdates[0].update, { $addToSet: { blacklist: 'u1' } })
    })

    it('cancels a personal coupon after the first paid use', async () => {
        const { DL, utils, couponUpdates } = build({
            coupons: { save10: { id: 'c1', code: 'save10', personal: true } }
        })

        await recordCouponUsage({ DL, utils, order })

        assert.deepEqual(couponUpdates[0].update, {
            $addToSet: { blacklist: 'u1' },
            $set: { status: 'canceled' }
        })
    })

    it('cancels a legacy multi:false coupon after the first paid use', async () => {
        const { DL, utils, couponUpdates } = build({
            coupons: { save10: { id: 'c1', code: 'save10', multi: false } }
        })

        await recordCouponUsage({ DL, utils, order })

        assert.deepEqual(couponUpdates[0].update.$set, { status: 'canceled' })
    })

    it('does nothing for an order without coupons', async () => {
        const { DL, utils, couponUpdates, findFilters } = build()

        await recordCouponUsage({ DL, utils, order: { ...order, coupons: [] } })

        assert.equal(couponUpdates.length, 0)
        assert.equal(findFilters.length, 0)
    })

    it('skips a coupon that no longer exists', async () => {
        const { DL, utils, couponUpdates } = build({ coupons: {} })

        await recordCouponUsage({ DL, utils, order })

        assert.equal(couponUpdates.length, 0)
    })

    it('cleans the paying customer\'s other carts for a regular coupon', async () => {
        const { DL, utils, findFilters, cartUpdates } = build({
            coupons: { save10: { id: 'c1', code: 'save10', personal: false } },
            carts: [cart()]
        })

        await recordCouponUsage({ DL, utils, order })

        assert.deepEqual(findFilters[0].userId, { $in: ['u1'] })
        assert.equal(cartUpdates.length, 1)
        assert.deepEqual(cartUpdates[0].update.$set.coupons, [])
    })

    it('cleans every cart for a canceled personal coupon', async () => {
        const { DL, utils, findFilters, cartUpdates } = build({
            coupons: { save10: { id: 'c1', code: 'save10', personal: true } },
            carts: [cart({ id: 'o3', userId: 'u2' })]
        })

        await recordCouponUsage({ DL, utils, order })

        assert.equal(findFilters[0].userId, undefined)
        assert.equal(cartUpdates.length, 1)
        assert.deepEqual(cartUpdates[0].filter, { id: 'o3' })
        assert.deepEqual(cartUpdates[0].update.$set.coupons, [])
    })
})
