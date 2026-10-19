import { findByLocation } from '#server/external/supplyArea.js'

export default async function admin_active(payload, { DL }) {
    const { userId, addressId } = payload
    const user = await DL.User.readById(userId)
    if (!user) throw { status: 404, message: 'user not found' }
    const targetAddr = (user.addresses || []).find(a => a.addressId === addressId)
    if (!targetAddr) throw { status: 404, message: 'address not found' }
    const area = await findByLocation(DL, targetAddr.location)
    if (!area) throw { status: 400, message: 'address has no service' }

    const updatedUser = await DL.User.Model.findOneAndUpdate(
        { id: user.id, 'addresses.addressId': addressId },
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
    await DL.redis?.del(`user_auth:${user.id}`)
    // Direct Model write bypasses DL.updateOne, so invalidate the
    // User version-cache explicitly — otherwise user/details keeps
    // serving the pre-update doc from cache.
    try {
        await DL.User.Model.cache?.del(user.id)
    } catch { }
    return { user: updatedUser }
}

admin_active.config = { required: ['userId', 'addressId'], permissions: 'user:update' }
