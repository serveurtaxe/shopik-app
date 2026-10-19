import { updateOrderAddress } from '#server/api/order/address/update.js'
import { findByLocation } from '#server/external/supplyArea.js'

export default async function active(payload, { DL, _user, utils }) {
    const { addressId } = payload

    const existingAddr = _user.addresses.find(a => a.addressId === addressId)
    if (!existingAddr) throw { status: 404, message: 'address not found' }
    const area = await findByLocation(DL, existingAddr.location)
    if (!area) throw { status: 400, message: 'address has no service' }

    const user = await DL.User.Model.findOneAndUpdate(
        { id: _user.id, 'addresses.addressId': addressId },
        [{
            $set: {
                addresses: {
                    $map: {
                        input: '$addresses',
                        as: 'address',
                        in: {
                            $mergeObjects: [
                                '$$address',
                                {
                                    active: {
                                        $eq: ['$$address.addressId', addressId]
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        }],
        {
            returnDocument: 'after',
            projection: DL.User.defaultSelect,
            updatePipeline: true
        }
    ).lean()
    await DL.redis?.del(`user_auth:${_user.id}`)
    // Direct Model write bypasses DL.updateOne, so invalidate the
    // User version-cache explicitly — otherwise subsequent reads keep
    // serving the pre-update doc from cache.
    try {
        await DL.User.Model.cache?.del(_user.id)
    } catch { }

    const activeAddress = user.addresses.find(a => a.active === true)
    const { DELIVERY_METHOD } = DL.Order.constants
    if (user.deliveryMethod === DELIVERY_METHOD.DELIVERY) {
        const order = await utils.data.getUserOrder({ DL, _user })
        const updatedOrder = await updateOrderAddress({
            DL,
            utils,
            order,
            address: activeAddress,
            actor: utils.data.timeline.userActor(_user)
        })
        return { user, order: updatedOrder }
    }

    return { user }
}

active.config = { auth: 'required', required: ['addressId'] }
