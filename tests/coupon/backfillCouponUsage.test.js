import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    collectUsage,
    planCouponUpdates,
    cartPurgePlan
} from '../../server/scripts/backfillCouponUsage.js'

describe('backfillCouponUsage / collectUsage', () => {
    it('folds every coupon code into a per-code user set, lowercased', () => {
        const usage = collectUsage({
            userId: 'u1',
            coupons: [{ code: 'SAVE10' }, { code: 'other' }, { code: '' }]
        })

        assert.deepEqual([...usage.get('save10')], ['u1'])
        assert.deepEqual([...usage.get('other')], ['u1'])
        assert.equal(usage.size, 2)
    })

    it('ignores orders without a user or with no coupon codes', () => {
        assert.equal(collectUsage({ coupons: [{ code: 'save10' }] }).size, 0)
        assert.equal(collectUsage({ userId: 'u1', coupons: [] }).size, 0)
        assert.equal(collectUsage({ userId: 'u1', coupons: [{ code: '' }] }).size, 0)
    })
})

describe('backfillCouponUsage / planCouponUpdates', () => {
    const usage = () => new Map([
        ['save10', new Set(['u1', 'u2'])],
        ['personal', new Set(['u3'])]
    ])

    it('adds only users that are not already blacklisted', () => {
        const plans = planCouponUpdates(
            [{ id: 'c1', code: 'save10', blacklist: ['u1'], status: 'active' }],
            usage()
        )

        assert.equal(plans.length, 1)
        assert.deepEqual(plans[0].add, ['u2'])
        assert.equal(plans[0].cancel, false)
    })

    it('cancels a personal coupon that was used', () => {
        const plans = planCouponUpdates(
            [{ id: 'c2', code: 'personal', blacklist: [], status: 'active', personal: true }],
            usage()
        )

        assert.equal(plans.length, 1)
        assert.deepEqual(plans[0].add, ['u3'])
        assert.equal(plans[0].cancel, true)
    })

    it('cancels a legacy multi:false coupon that was used', () => {
        const plans = planCouponUpdates(
            [{ id: 'c3', code: 'save10', blacklist: [], status: 'active', multi: false }],
            usage()
        )

        assert.equal(plans[0].cancel, true)
    })

    it('does not cancel an already canceled personal coupon but still adds users', () => {
        const plans = planCouponUpdates(
            [{ id: 'c4', code: 'personal', blacklist: [], status: 'canceled', personal: true }],
            usage()
        )

        assert.equal(plans.length, 1)
        assert.deepEqual(plans[0].add, ['u3'])
        assert.equal(plans[0].cancel, false)
    })

    it('skips coupons with no recorded usage and unknown codes', () => {
        const plans = planCouponUpdates(
            [{ id: 'c1', code: 'save10', blacklist: [], status: 'active' }],
            new Map([['never-used', new Set(['u1'])]])
        )

        assert.deepEqual(plans, [])
        assert.deepEqual(planCouponUpdates([], usage()), [])
    })

    it('does not emit a no-op when every user is already blacklisted', () => {
        const plans = planCouponUpdates(
            [{ id: 'c1', code: 'save10', blacklist: ['u1', 'u2'], status: 'active' }],
            usage()
        )

        assert.deepEqual(plans, [])
    })
})

describe('backfillCouponUsage / cartPurgePlan', () => {
    const plans = [
        { coupon: { code: 'save10', blacklist: ['u9'] }, add: ['u1'], cancel: false },
        { coupon: { code: 'personal', blacklist: [] }, add: [], cancel: true }
    ]

    it('targets carts of newly blacklisted customers, already blacklisted customers and canceled codes', () => {
        const carts = [
            { id: 'a', userId: 'u1', coupons: [{ code: 'save10' }] },
            { id: 'b', userId: 'u9', coupons: [{ code: 'save10' }] },
            { id: 'c', userId: 'u2', coupons: [{ code: 'save10' }] },
            { id: 'd', userId: 'u2', coupons: [{ code: 'personal' }] },
            { id: 'e', userId: 'u2', coupons: [{ code: 'other' }] }
        ]

        const targets = cartPurgePlan(carts, plans)

        assert.deepEqual(targets.map(t => t.cart.id), ['a', 'b', 'd'])
        assert.deepEqual(targets.map(t => t.code), ['save10', 'save10', 'personal'])
    })

    it('returns nothing when no plan matches the carts', () => {
        assert.deepEqual(cartPurgePlan([{ id: 'a', userId: 'u1', coupons: [{ code: 'other' }] }], plans), [])
        assert.deepEqual(cartPurgePlan([], plans), [])
        assert.deepEqual(cartPurgePlan([{ id: 'a', userId: 'u1', coupons: [] }], plans), [])
    })
})
