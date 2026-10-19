import { clearOrderAddress } from '#server/api/order/address/update.js'

export default async function remove(payload, { DL, _user, utils }) {
    const removed = (_user.addresses || []).find(a => a.addressId === payload.addressId)

    const updatedUser = await DL.User.updateOne(
        { id: _user.id },
        { $pull: { addresses: { addressId: payload.addressId } } },
        { select: DL.User.defaultSelect }
    )
    await DL.redis?.del(`user_auth:${_user.id}`)

    if (!removed?.active) return { user: updatedUser }

    const { DELIVERY_METHOD } = DL.Order.constants
    const order = await DL.Order.readOne(
        { userId: _user.id, status: 'cart', active: true },
        DL.Order.defaultSelect
    )
    if (!order || order.deliveryMethod !== DELIVERY_METHOD.DELIVERY) return { user: updatedUser }

    const updatedOrder = await clearOrderAddress({
        DL,
        utils,
        order,
        actor: utils.data.timeline.userActor(_user)
    })
    return { user: updatedUser, order: updatedOrder }
}

remove.config = { auth: 'required', required: ['addressId'] }
