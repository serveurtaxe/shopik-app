import { editAddress, isSameAddressLocation } from '#server/utils/data/userAddress.js'
import { clearOrderAddress, updateOrderAddress } from '#server/api/order/address/update.js'

export default async function admin_edit(payload, { DL, external, utils, _admin }) {
    const { userId, addressId, ...address } = payload
    const user = await DL.User.readById(userId)
    if (!user) throw { status: 404, message: 'user not found' }

    const { geocoded, existingAddr } = await editAddress({ DL, external, user, addressId, address })
    const sameLocation = isSameAddressLocation(geocoded, existingAddr)

    const updatedUser = await DL.User.updateOne(
        { id: user.id, 'addresses.addressId': addressId },
        { $set: { 'addresses.$': geocoded } },
        { select: DL.User.defaultSelect }
    )
    await DL.redis?.del(`user_auth:${user.id}`)

    if (sameLocation && geocoded.active === existingAddr.active) return { user: updatedUser }

    const { DELIVERY_METHOD } = DL.Order.constants
    const order = await DL.Order.readOne(
        { userId: user.id, status: 'cart', active: true },
        DL.Order.defaultSelect
    )
    const orderUpdateRequired = existingAddr.active && order?.deliveryMethod === DELIVERY_METHOD.DELIVERY
    if (!orderUpdateRequired) return { user: updatedUser }

    const actor = utils.data.timeline.adminActor(_admin)
    const updatedOrder = geocoded.active
        ? await updateOrderAddress({ DL, utils, order, address: geocoded, actor })
        : await clearOrderAddress({ DL, utils, order, actor })

    return { user: updatedUser, order: updatedOrder }
}

admin_edit.config = { required: ['userId', 'addressId', 'city', 'street', 'building'], permissions: 'user:update' }
