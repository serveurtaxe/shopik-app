import filterClientOrder from '#server/utils/data/filterClientOrder.js'
import removeCouponFromCart from '#server/utils/data/removeCouponFromCart.js'

export default async function remove(payload, { DL, _user, utils }) {
    const couponCode = (payload.couponCode || '').trim().toLowerCase()
    if (!couponCode) throw { status: 400, message: 'coupon code is required' }

    const cartOrder = await utils.data.getUserOrder({ DL, _user })
    const updatedOrder = await removeCouponFromCart({
        DL,
        utils,
        order: cartOrder,
        code: couponCode,
        actor: utils.data.timeline.userActor(_user)
    })
    if (!updatedOrder) throw { status: 400, message: 'Coupon not found on this order' }

    return filterClientOrder(updatedOrder)
}

remove.config = {
    auth: 'required',
    required: ['couponCode']
}
