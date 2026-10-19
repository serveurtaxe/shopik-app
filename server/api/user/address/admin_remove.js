import { clearOrderAddress } from '#server/api/order/address/update.js'

export default async function admin_remove(payload, { DL, utils, _admin }) {
    const { userId, addressId } = payload
    const user = await DL.User.readById(userId)
    if (!user) throw { status: 404, message: 'user not found' }
    const removed = (user.addresses || []).find(a => a.addressId === addressId)

    const updatedUser = await DL.User.updateOne(
        { id: user.id },
        { $pull: { addresses: { addressId } } },
        { select: DL.User.defaultSelect }
    )
    await DL.redis?.del(`user_auth:${user.id}`)

    if (!removed?.active) return { user: updatedUser }

    const { DELIVERY_METHOD } = DL.Order.constants
    const order = await DL.Order.readOne(
        { userId: user.id, status: 'cart', active: true },
        DL.Order.defaultSelect
    )
    if (!order || order.deliveryMethod !== DELIVERY_METHOD.DELIVERY) return { user: updatedUser }

    const updatedOrder = await clearOrderAddress({
        DL,
        utils,
        order,
        actor: utils.data.timeline.adminActor(_admin)
    })
    return { user: updatedUser, order: updatedOrder }
}

admin_remove.config = { required: ['userId', 'addressId'], permissions: 'user:update' }
