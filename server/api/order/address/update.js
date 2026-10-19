import { releaseWindowReservation } from '#server/utils/data/windowGroups.js'

const MAX_DIST_FROM_STORE_KM = 10

export async function findClosestStore(address, DL) {
    const store = await DL.Store.Model.findOne({
        'address.location': {
            $nearSphere: {
                $geometry: address.location,
                $maxDistance: MAX_DIST_FROM_STORE_KM * 1000
            }
        }
    }, { _id: 0, id: 1 }).lean()

    return store?.id ?? null
}

export async function updateOrderAddress({ DL, utils, address, order, select = DL.Order.defaultSelect, actor }) {
    const update = { address }
    const { DELIVERY_METHOD } = DL.Order.constants
    if (order.deliveryMethod === DELIVERY_METHOD.DELIVERY) {
        const storeId = await findClosestStore(address, DL)
        if (storeId)
            update.storeId = storeId
    }

    const updatedOrder = await DL.Order.updateOne({ id: order.id }, update, { select })

    if (order.userId) {
        await DL.redis?.del(`user_store:${order.userId}`).catch(() => {})
    }

    const storeChanged = update.storeId && update.storeId !== order.storeId
    const oldData = { address: order.address }
    const newData = { address: update.address }
    if (storeChanged) {
        oldData.storeId = order.storeId
        newData.storeId = update.storeId
        oldData.storeName = order.storeName || null
        if (!oldData.storeName && order.storeId) {
            const oldStore = await DL.Store.readById(order.storeId, { _id: 0, name: 1 })
            oldData.storeName = oldStore?.name || null
        }
        const newStore = await DL.Store.readById(update.storeId, { _id: 0, name: 1 })
        newData.storeName = newStore?.name || null
    }

    utils.data.timeline.record({
        DL,
        order,
        eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_ADDRESS,
        actor,
        changes: { oldData, newData }
    })

    return updatedOrder
}

export async function clearOrderAddress({ DL, utils, order, select = DL.Order.defaultSelect, actor }) {
    const update = { $set: { address: null, storeId: null } }
    if (order.window?.id) {
        update.$unset = { window: 1 }
        try {
            await releaseWindowReservation(DL, order.window.id, order.window.reservedGroupId)
        } catch { }
    }

    const updatedOrder = await DL.Order.updateOne({ id: order.id }, update, { select })

    if (order.userId) {
        await DL.redis?.del(`user_store:${order.userId}`).catch(() => {})
    }

    utils.data.timeline.record({
        DL,
        order,
        eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_ADDRESS,
        actor,
        changes: {
            oldData: { address: order.address, storeId: order.storeId, window: order.window },
            newData: { address: null, storeId: null, window: null }
        }
    })

    return updatedOrder
}

export default async function update(payload, { DL, _admin, utils }) {
    const { address, id } = payload
    const order = await DL.Order.readById(id)
    return updateOrderAddress({
        DL,
        utils,
        address,
        order,
        actor: utils.data.timeline.adminActor(_admin),
        select: { _id: 0 }
    })
}

update.config = {
    permissions: ['order:update']
}
