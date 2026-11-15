import removeCouponFromCart from './removeCouponFromCart.js'

/**
 * Remove a coupon from open cart orders.
 *
 * `userIds` narrows the purge to specific customers; without it every cart that
 * holds the code loses it (used when a personal coupon is canceled).
 *
 * `coupons.code` is not an exposed DL filter field, so this queries the model
 * directly. Each removal goes through the shared helper so totals and the
 * timeline stay consistent with the customer-facing remove endpoint.
 *
 * @returns the number of carts that were cleaned.
 */
export default async function purgeCouponFromCarts({ DL, utils, code, userIds = null, actor = null }) {
    const couponCode = (code || '').trim().toLowerCase()
    if (!couponCode || !DL?.Order?.Model) return 0

    const filter = { status: 'cart', active: true, 'coupons.code': couponCode }
    if (Array.isArray(userIds)) {
        const ids = userIds.map(String)
        if (!ids.length) return 0
        filter.userId = { $in: ids }
    }

    const carts = await DL.Order.Model.find(
        filter,
        {
            _id: 0,
            id: 1,
            userId: 1,
            coupons: 1,
            sum: 1,
            sumNoCoupon: 1,
            shipping: 1
        }
    ).lean()

    let purged = 0
    for (const cart of carts || []) {
        const updated = await removeCouponFromCart({ DL, utils, order: cart, code: couponCode, actor })
        if (updated) purged++
    }
    return purged
}
