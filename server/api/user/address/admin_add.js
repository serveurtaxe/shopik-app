import { addAddress } from '#server/utils/data/userAddress.js'
import { updateOrderAddress } from '#server/api/order/address/update.js'

export default async function admin_add(payload, { DL, external, utils, _admin }) {
    const { userId, ...address } = payload
    const user = await DL.User.readById(userId)
    if (!user) throw { status: 404, message: 'user not found' }

    const geocoded = await addAddress({ DL, external, user, address, allowNoElevator: true })

    const updatedUser = await DL.User.updateOne(
        { id: user.id },
        { $push: { addresses: geocoded } },
        { select: DL.User.defaultSelect }
    )
    await DL.redis?.del(`user_auth:${user.id}`)

    if (!geocoded.active) return { user: updatedUser }

    const { DELIVERY_METHOD } = DL.Order.constants
    const order = await DL.Order.readOne(
        { userId: user.id, status: 'cart', active: true },
        DL.Order.defaultSelect
    )
    if (!order || order.deliveryMethod !== DELIVERY_METHOD.DELIVERY) return { user: updatedUser }

    const updatedOrder = await updateOrderAddress({
        DL,
        utils,
        order,
        address: geocoded,
        actor: utils.data.timeline.adminActor(_admin)
    })
    return { user: updatedUser, order: updatedOrder }
}

admin_add.config = { required: ['userId', 'city', 'street', 'building'], permissions: 'user:update' }
