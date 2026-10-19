import { releaseWindowReservation } from '#server/utils/data/windowGroups.js'
import getShippingConfig from '#server/utils/data/getShippingConfig.js'
import { calcShipping } from '#common/functions/shipping.js'
import { round2 } from '#common/functions/calcOrder/utils.js'

async function storeNameById(DL, storeId) {
    if (!storeId) return null
    const store = await DL.Store.readById(storeId, { _id: 0, name: 1 })
    return store?.name || null
}

export default async function deliveryMethod(payload, { DL, utils, _user }) {
    const { DELIVERY_METHOD } = DL.Order.constants
    const { pickupStoreId } = payload
    let pickupStore = null

    const deliveryMethod = pickupStoreId ? DELIVERY_METHOD.PICKUP : DELIVERY_METHOD.DELIVERY
    if (deliveryMethod === DELIVERY_METHOD.PICKUP) {
        pickupStore = await DL.Store.readOne({
            id: pickupStoreId,
            active: true,
            deliveryMethods: DELIVERY_METHOD.PICKUP
        })
        if (!pickupStore) throw { status: 400, message: 'invalid pickup store id' }
    }

    const order = await utils.data.getUserOrder({ DL, _user })
    const methodChanged = order.deliveryMethod !== deliveryMethod
    const pickupStoreChanged = deliveryMethod === DELIVERY_METHOD.PICKUP && order.storeId !== pickupStoreId
    if (!methodChanged && !pickupStoreChanged) return {}

    const orderChanges = {}
    const userUpdate = {}
    if (deliveryMethod === DELIVERY_METHOD.PICKUP) {
        orderChanges.address = pickupStore.address
        orderChanges.storeId = pickupStoreId
        userUpdate.pickupStoreId = pickupStoreId
    }
    if (methodChanged) {
        orderChanges.deliveryMethod = deliveryMethod
        userUpdate.deliveryMethod = deliveryMethod
        if (deliveryMethod === DELIVERY_METHOD.DELIVERY) {
            const activeAddress = _user.addresses.find(a => a.active)
            if (activeAddress) {
                orderChanges.address = activeAddress
                orderChanges.storeId = await utils.data.getStoreForAddress({ DL, address: activeAddress })
            } else {
                orderChanges.address = null
                orderChanges.storeId = null
            }
        }
    }

    // Recompute shipping for new deliveryMethod (based on sum pre-coupon)
    try {
        const shippingConfig = await getShippingConfig(DL, order.domainId)
        const sum = order.sum ?? 0
        const shipping = calcShipping({ sum, deliveryMethod, shippingConfig })
        const finalSum = order.finalSum ?? sum
        orderChanges.shipping = shipping
        orderChanges.finalShipping = shipping
        orderChanges.sumWithShipping = round2(sum + shipping)
        orderChanges.finalSumWithShipping = round2(finalSum + shipping)
        if (order.sumNoCoupon != null) {
            orderChanges.sumNoCouponWithShipping = round2(order.sumNoCoupon + shipping)
            orderChanges.finalSumNoCouponWithShipping = round2((order.finalSumNoCoupon ?? order.sumNoCoupon) + shipping)
        }
    } catch {}

    const orderUpdate = { $set: orderChanges }
    if (order.storeId != orderChanges.storeId) {
        if (order.window?.id) {
            orderUpdate.$unset = { window: 1 }
            await releaseWindowReservation(DL, order.window.id, order.window.reservedGroupId)
        }
    }

    const user = await DL.User.updateOne(
        { id: _user.id },
        {
            $set: {
                deliveryMethod,
                pickupStoreId: deliveryMethod === DELIVERY_METHOD.PICKUP ? pickupStoreId : null
            }
        },
        { select: DL.User.defaultSelect }
    )

    const updatedOrder = await DL.Order.updateOne(
        { id: order.id },
        orderUpdate,
        { select: DL.Order.defaultSelect }
    )

    const oldData = {}
    const newData = {}
    if (methodChanged) {
        oldData.deliveryMethod = order.deliveryMethod
        newData.deliveryMethod = deliveryMethod
    }
    if (orderChanges.address !== undefined) {
        oldData.address = order.address
        newData.address = orderChanges.address
    }
    if (orderChanges.storeId !== undefined) {
        oldData.storeId = order.storeId
        newData.storeId = orderChanges.storeId
        oldData.storeName = order.storeName || await storeNameById(DL, order.storeId)
        newData.storeName = orderChanges.storeId ? await storeNameById(DL, orderChanges.storeId) : null
    }
    if (orderUpdate.$unset?.window) {
        oldData.window = order.window
        newData.window = null
    }

    const { record, userActor } = utils.data.timeline
    await record({
        DL,
        order,
        eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_DELIVERY,
        actor: userActor(_user),
        changes: { oldData, newData }
    })

    await DL.redis?.del(`user_auth:${_user.id}`)
    await DL.redis?.del(`user_store:${_user.id}`).catch(() => {})

    return { user, order: updatedOrder }
}

deliveryMethod.config = { auth: 'required' }
