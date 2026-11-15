import diff from '#common/functions/diff.js'
import { round2 } from '#common/functions/calcOrder/utils.js'

/**
 * Remove an applied coupon from a cart order and reset its totals to the
 * pre-coupon values.
 *
 * Shared by the customer-facing remove endpoint and the background flows that
 * purge a coupon once it is canceled, expired, or blacklisted for the customer.
 *
 * @returns the updated order, or `null` when the code is not on the order.
 */
export default async function removeCouponFromCart({ DL, utils, order, code, actor = null }) {
    if (!order?.id) return null

    const couponCode = (code || '').trim().toLowerCase()
    if (!couponCode) return null
    if (!order.coupons?.some(c => String(c?.code || '').toLowerCase() === couponCode)) return null

    const orderSum = order.sum || 0
    const sumNoCoupon = order.sumNoCoupon ?? orderSum
    const shipping = order.shipping ?? 0
    const sumWithShipping = round2(orderSum + shipping)

    const updatedOrder = {
        ...order,
        coupons: [],
        sum: orderSum,
        sumNoCoupon,
        finalSum: orderSum,
        finalSumNoCoupon: sumNoCoupon,
        shipping,
        finalShipping: shipping,
        sumWithShipping,
        finalSumWithShipping: sumWithShipping,
        customerUpdatedAt: new Date()
    }

    const updateData = diff(order, updatedOrder)
    let finalOrder = order

    if (Object.keys(updateData).length > 0) {
        const savedOrder = await DL.Order.updateOne(
            { id: order.id },
            { $set: updateData }
        )
        if (savedOrder) finalOrder = savedOrder

        const oldData = {}
        for (const key of Object.keys(updateData)) oldData[key] = order[key]

        const { record } = utils.data.timeline
        await record({
            DL,
            order,
            eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_COUPON,
            actor,
            changes: { oldData, newData: updateData }
        })
    }

    return finalOrder
}
