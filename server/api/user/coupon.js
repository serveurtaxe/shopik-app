import { isCouponEligible } from '#common/functions/coupon.js'

const toClientCoupon = coupon => ({
    code: coupon.code,
    name: coupon.name,
    description: coupon.description,
    discount: coupon.discount,
    benefit: coupon.benefit,
    minSum: coupon.minSum,
    maxSum: coupon.maxSum,
    start: coupon.start,
    end: coupon.end,
})

export default async function coupon(payload, { DL, _user, utils }) {
    const order = await utils.data.getUserOrder({ DL, _user })
    const orderSum = order.sumNoCoupon || order.sum || 0

    // A coupon that is already attached to the cart is always listed, even if
    // it is non-public or no longer passes eligibility. The customer needs to
    // see (and be able to remove) whatever is being applied to the order.
    const appliedCodes = [...new Set(
        (order.coupons || [])
            .map(c => String(c?.code || '').trim().toLowerCase())
            .filter(Boolean)
    )]

    const now = new Date()
    const publicCoupons = await DL.Coupon.read({
        status: DL.Coupon.constants.STATUS.ACTIVE,
        public: true,
        start: { $lte: now },
        end: { $gte: now },
    })

    // Applied coupons may be private or have left the public window; read them
    // without any status/date/public filter so they still reach the storefront.
    const missingCodes = appliedCodes.filter(code => !publicCoupons.some(c => c.code === code))
    const appliedCoupons = missingCodes.length
        ? await DL.Coupon.read({ code: { $in: missingCodes } }, { _id: 0 }, { limit: 0 })
        : []

    const byCode = new Map()

    for (const c of publicCoupons) {
        // An applied coupon is trusted as-is: skip eligibility so a changed
        // dynamic condition cannot hide a discount that is already attached.
        if (!appliedCodes.includes(c.code)) {
            const result = isCouponEligible(c, _user, orderSum)
            if (!result.eligible && !result.isMinSumBlock) continue
        }
        byCode.set(c.code, toClientCoupon(c))
    }

    for (const c of appliedCoupons) {
        byCode.set(c.code, toClientCoupon(c))
    }

    // Applied first so the active coupon leads the grid.
    const eligibleCoupons = [
        ...appliedCodes.map(code => byCode.get(code)).filter(Boolean),
        ...[...byCode.values()].filter(c => !appliedCodes.includes(c.code))
    ]

    return { coupons: eligibleCoupons }
}

coupon.config = {
    auth: 'required'
}
