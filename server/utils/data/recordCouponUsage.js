import purgeCouponFromCarts from './purgeCouponFromCarts.js'

/**
 * Record that an order was paid with one or more coupons.
 *
 * Every paid use blacklists the paying customer, which makes the coupon
 * single-use per customer (isCouponEligible rejects blacklisted users).
 * A `personal` coupon is additionally canceled so no other customer can use it.
 *
 * Any open cart still holding the now-unusable coupon is cleaned up: the paying
 * customer's carts for every coupon, and every cart for a canceled personal
 * coupon. Best-effort — the payment itself already succeeded.
 */
export default async function recordCouponUsage({ DL, utils, order, actor = null } = {}) {
    const userId = order?.userId
    const codes = [...new Set(
        (order?.coupons || [])
            .map(c => String(c?.code || '').trim().toLowerCase())
            .filter(Boolean)
    )]
    if (!userId || !codes.length || !DL?.Coupon) return

    for (const code of codes) {
        let coupon
        try {
            coupon = await DL.Coupon.readOne({ code })
        } catch {
            continue
        }
        if (!coupon?.id) continue

        // Legacy docs predate the personal flag and carry `multi` instead.
        const personal = coupon.personal === true || coupon.multi === false
        const update = { $addToSet: { blacklist: String(userId) } }
        if (personal) update.$set = { status: 'canceled' }

        try {
            await DL.Coupon.updateOne({ id: coupon.id }, update)
        } catch {
            continue
        }

        try {
            await purgeCouponFromCarts({
                DL,
                utils,
                code,
                // A canceled personal coupon must disappear everywhere; a
                // regular one only from the paying customer's other carts.
                userIds: personal ? null : [userId],
                actor
            })
        } catch { }
    }
}
