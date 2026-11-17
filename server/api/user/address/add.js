import { addAddress } from '#server/utils/data/userAddress.js'
import { updateOrderAddress } from '#server/api/order/address/update.js'
import { redisDel } from '#server/utils/redisSafe.js'

export default async function add(payload, { DL, _user, external, utils }) {
    const geocoded = await addAddress({ DL, external, user: _user, address: payload })

    const updatedUser = await DL.User.updateOne(
        { id: _user.id },
        { $push: { addresses: geocoded } },
        { select: DL.User.defaultSelect }
    )
    await redisDel(DL.redis, `user_auth:${_user.id}`)
    if (!geocoded.active) return { user: updatedUser, address: geocoded }

    const order = await utils.data.getUserOrder({ DL, _user })
    const { DELIVERY_METHOD } = DL.Order.constants
    if (order.deliveryMethod === DELIVERY_METHOD.DELIVERY) {
        const updatedOrder = await updateOrderAddress({
            DL,
            utils,
            address: geocoded,
            order,
            actor: utils.data.timeline.userActor(_user)
        })
        return { user: updatedUser, order: updatedOrder, address: geocoded }
    }

    return { user: updatedUser, address: geocoded }
}

add.config = { auth: 'required', required: ['city', 'street', 'building'] }
