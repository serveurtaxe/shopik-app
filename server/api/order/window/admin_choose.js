import { overlapsWindow } from '#common/functions/specialDay.js'
import { canChangeOrderWindow } from '#common/functions/orderWindow.js'
import {
    findUserGroupIds,
    reserveGuard,
    releaseWindowReservation,
    purgeExpiredHolds,
    selectionHoldDeadline
} from '#server/utils/data/windowGroups.js'

export default async function admin_choose(payload, { DL, _admin, utils }) {
    const { DELIVERY_METHOD } = DL.Order.constants
    const { orderId, windowId, allowFull } = payload

    const order = await DL.Order.readById(orderId)
    if (!order) throw { status: 404, message: 'order not found' }
    if (!canChangeOrderWindow(order))
        throw { status: 403, message: 'order window cannot be changed' }

    const windowDoc = await DL.OrderWindow.readById(windowId)
    if (!windowDoc) throw { status: 400, message: 'window not found' }
    if (!order.storeId || windowDoc.storeId !== order.storeId)
        throw { status: 400, message: 'window does not belong to order store' }

    const previousWindowId = order.window?.id || null
    if (previousWindowId === windowId) return order

    if (windowDoc.leadTimestamp < Date.now())
        throw { status: 400, message: 'window has passed' }

    // Server-side guard for disabled windows / special-day closures
    if (windowDoc.active === false || windowDoc.disabled === true)
        throw { status: 400, message: 'window is unavailable' }

    const activeSpecials = await DL.SpecialDay.read(
        {
            active: true,
            date: windowDoc.date
        },
        { _id: 0, storeIds: 1, start: 1, end: 1 },
        { limit: 0 }
    )
    const applicable = activeSpecials.filter(sd => !sd.storeIds?.length || sd.storeIds.includes(windowDoc.storeId))
    if (applicable.some(sd => overlapsWindow(sd, windowDoc)))
        throw { status: 400, message: 'window is unavailable' }

    // Group-restricted windows are bookable by members of those groups only
    // (delivery orders; the address area decides membership).
    let reservedGroupId = null
    let groupEntry = null
    if ((windowDoc.areaGroups || []).length && order.deliveryMethod === DELIVERY_METHOD.DELIVERY) {
        const userGroupIds = await findUserGroupIds(DL, windowDoc.storeId, order.address?.areaId)
        groupEntry = windowDoc.areaGroups.find(g => userGroupIds.includes(g.groupId)) || null
        reservedGroupId = groupEntry?.groupId || null
        if (!reservedGroupId)
            throw { status: 400, message: 'window is unavailable' }
        // A zeroed bucket means the window is closed for this group
        if (groupEntry.capacity === 0)
            throw { status: 400, message: 'window is unavailable' }
    }

    // Counters can be stale while nobody browsed this store (holds expire
    // lazily); release what has actually expired before deciding it is full.
    await purgeExpiredHolds(DL, [windowId])

    // allowFull skips the capacity guard: an explicit admin confirmation is
    // the only way to put an order into a window whose global or group
    // counter is already at capacity.
    const updatedWindow = await DL.OrderWindow.Model.findOneAndUpdate(
        allowFull === true ? { id: windowId } : reserveGuard(windowId, reservedGroupId),
        {
            $inc: {
                totalOrders: 1,
                ...(reservedGroupId ? { 'areaGroups.$[g].count': 1 } : {})
            }
        },
        {
            returnDocument: 'after',
            ...(reservedGroupId ? { arrayFilters: [{ 'g.groupId': reservedGroupId }] } : {})
        }
    ).lean()

    if (!updatedWindow)
        throw { status: 409, code: 'WINDOW_FULL', message: 'window is at capacity' }

    const reservedAt = new Date()
    const orderUpdate = {
        window: {
            ...windowDoc,
            reservedGroupId,
            reservedAt,
            // The hold never outlives the window's lead time: choosing five
            // minutes before the cutoff leaves five minutes to complete.
            holdUntil: new Date(selectionHoldDeadline({
                now: reservedAt.getTime(),
                leadTimestamp: windowDoc.leadTimestamp
            }))
        }
    }

    try {
        const updatedOrder = await DL.Order.updateOne(
            { id: order.id },
            { $set: orderUpdate },
            { select: DL.Order.defaultSelect }
        )

        const { record, adminActor } = utils.data.timeline
        await record({
            DL,
            order,
            eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_WINDOW,
            actor: adminActor(_admin),
            changes: {
                oldData: { window: order.window },
                newData: { window: orderUpdate.window }
            },
            metadata: { source: 'order/window/admin_choose' }
        })

        return updatedOrder
    } finally {
        if (previousWindowId) {
            await releaseWindowReservation(DL, previousWindowId, order.window?.reservedGroupId)
        }
    }
}

admin_choose.config = {
    required: ['orderId', 'windowId'],
    permissions: ['order:update'],
    preventMultiple: ({ orderId }) => `:${orderId}`
}
