import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { findInvalidCouponCodes } from '../../server/api/payment/create.js'

function fakeDL(coupons = []) {
    const filters = []
    return {
        filters,
        DL: {
            Coupon: {
                constants: { STATUS: { ACTIVE: 'active' } },
                read: async filter => {
                    filters.push(filter)
                    const wanted = filter.code?.$in || []
                    return coupons.filter(c => wanted.includes(c.code))
                }
            }
        }
    }
}

const DAY = 24 * 60 * 60 * 1000
const order = { coupons: [{ code: 'save10' }] }
const activeCoupon = (overrides = {}) => ({
    code: 'save10',
    status: 'active',
    start: new Date(Date.now() - DAY),
    end: new Date(Date.now() + DAY),
    whitelist: [],
    blacklist: [],
    ...overrides
})

describe('payment/create coupon re-check', () => {
    it('accepts an active, in-window coupon for the customer', async () => {
        const { DL } = fakeDL([activeCoupon()])

        assert.deepEqual(await findInvalidCouponCodes({ DL, order, userId: 'u1' }), [])
    })

    it('does not query when the cart has no coupons', async () => {
        const { DL, filters } = fakeDL()

        assert.deepEqual(await findInvalidCouponCodes({ DL, order: { coupons: [] }, userId: 'u1' }), [])
        assert.equal(filters.length, 0)
    })

    it('flags a coupon that no longer exists', async () => {
        const { DL } = fakeDL([])

        assert.deepEqual(await findInvalidCouponCodes({ DL, order, userId: 'u1' }), ['save10'])
    })

    it('flags a canceled, expired or not-yet-valid coupon', async () => {
        const canceled = fakeDL([activeCoupon({ status: 'canceled' })])
        assert.deepEqual(await findInvalidCouponCodes({ DL: canceled.DL, order, userId: 'u1' }), ['save10'])

        const expired = fakeDL([activeCoupon({ end: new Date(Date.now() - DAY) })])
        assert.deepEqual(await findInvalidCouponCodes({ DL: expired.DL, order, userId: 'u1' }), ['save10'])

        const future = fakeDL([activeCoupon({ start: new Date(Date.now() + DAY) })])
        assert.deepEqual(await findInvalidCouponCodes({ DL: future.DL, order, userId: 'u1' }), ['save10'])
    })

    it('flags a coupon the customer is blacklisted from and honors the whitelist', async () => {
        const blacklisted = fakeDL([activeCoupon({ blacklist: ['u1'] })])
        assert.deepEqual(await findInvalidCouponCodes({ DL: blacklisted.DL, order, userId: 'u1' }), ['save10'])

        const notWhitelisted = fakeDL([activeCoupon({ whitelist: ['u2'] })])
        assert.deepEqual(await findInvalidCouponCodes({ DL: notWhitelisted.DL, order, userId: 'u1' }), ['save10'])

        const whitelisted = fakeDL([activeCoupon({ whitelist: ['u1'] })])
        assert.deepEqual(await findInvalidCouponCodes({ DL: whitelisted.DL, order, userId: 'u1' }), [])
    })
})
