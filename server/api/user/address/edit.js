import { editAddress, isSameAddressLocation } from '#server/utils/data/userAddress.js'
import { clearOrderAddress, updateOrderAddress } from '#server/api/order/address/update.js'

export default async function edit(payload, { DL, _user, external, utils }) {
    const { addressId, ...address } = payload
    const { geocoded, existingAddr } = await editAddress({ DL, external, user: _user, addressId, address })

    const sameLocation = isSameAddressLocation(geocoded, existingAddr)

    const user = await DL.User.updateOne(
        { id: _user.id, 'addresses.addressId': addressId },
        { $set: { 'addresses.$': geocoded } },
        { select: DL.User.defaultSelect }
    )

    await DL.redis?.del(`user_auth:${_user.id}`)
    if (sameLocation && geocoded.active === existingAddr.active) return { user }

    const order = await utils.data.getUserOrder({ DL, _user })

    const { DELIVERY_METHOD } = DL.Order.constants
    const orderUpdateRequired = existingAddr.active && order.deliveryMethod === DELIVERY_METHOD.DELIVERY
    if (!orderUpdateRequired) return { user }

    const actor = utils.data.timeline.userActor(_user)
    const updatedOrder = geocoded.active
        ? await updateOrderAddress({ DL, utils, order, address: geocoded, actor })
        : await clearOrderAddress({ DL, utils, order, actor })

    return {
        user,
        order: updatedOrder
    }
}

edit.config = { auth: 'required', required: ['addressId', 'city', 'street', 'building'] }
