import { OPS_SHIPPING_SMS_TEXT } from '#common/constants.js'
import { balancedRoute } from '#common/functions/routeSort.js'

export default async function start(payload, { DL, _admin, external, utils }) {
    const { orderIds, coordinates } = payload
    if (!Array.isArray(orderIds) || !orderIds.length) throw { status: 400, message: 'orderIds required' }

    const admin = await DL.Admin.readById(_admin.id)
    if (admin?.currentStoreId == null) throw { status: 400, message: 'select a store first' }

    const adminName = `${_admin.name?.first ?? ''} ${_admin.name?.last ?? ''}`.trim()
    const failures = []
    const successIds = []

    for (const id of orderIds) {
        const o = await DL.Order.updateOne(
            { id, status: 'packed', storeId: admin.currentStoreId },
            { $set: { status: 'shipped', shipper: { adminId: _admin.id, name: adminName } } }
        )
        if (!o) {
            failures.push(id)
            continue
        }
        successIds.push(id)
    }

    if (!successIds.length) throw { status: 409, message: `none available: ${failures.join(', ')}` }

    const shipment = await DL.Shipment.create({
        storeId: admin.currentStoreId,
        shipper: { adminId: _admin.id, name: adminName },
        orderIds: successIds,
        status: 'active',
        startedAt: new Date(),
        startLocation: coordinates ? { type: 'Point', coordinates } : undefined,
        currentLocation: coordinates ? { type: 'Point', coordinates } : undefined,
        shipmentNumber: Date.now()
    })

    // attach shipmentId to orders
    await DL.Order.Model.updateMany({ id: { $in: successIds } }, { $set: { shipmentId: shipment.id } })

    // static route order at leave-store time: balanced Haversine + window (store origin).
    // Explicit recalc only via shipment/route — list order stays static afterwards.
    let routeOrder = []
    try {
        const store = await DL.Store.readById(admin.currentStoreId)
        const origin = coordinates
            || store?.address?.location?.coordinates
            || null
        const routeOrders = await DL.Order.Model.find(
            { id: { $in: successIds } },
            { _id: 0, id: 1, address: 1, window: 1 }
        ).lean()
        routeOrder = balancedRoute(routeOrders, origin, Date.now())
        if (routeOrder.length)
            await DL.Shipment.updateOne({ id: shipment.id }, { routeOrder })
    } catch { }

    // owners per order (history)
    for (const oid of successIds) {
        try {
            await DL.Owner.create({ orderId: oid, adminId: _admin.id, adminName, start: new Date(), type: 'shipping', status: 'active' })
        } catch {}
    }

    // sms + timeline + ship_history start
    for (const oid of successIds) {
        const o = await DL.Order.readById(oid)
        if (!o) continue
        try {
            await external.sms.send([o.phone], OPS_SHIPPING_SMS_TEXT)
            await DL.Order.Model.updateOne({ id: oid }, { $push: { messages: { phone: o.phone, type: 'sms', message: OPS_SHIPPING_SMS_TEXT, date: new Date(), source: 'shipment:start', adminId: _admin.id } }, $inc: { 'notifications.notifyUserSms': 1 } })
        } catch {}
        try {
            const { record, adminActor } = utils.data.timeline
            await record({ DL, order: o, eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_STATUS_UPDATE, actor: adminActor(_admin), changes: { oldData: { status: 'packed' }, newData: { status: 'shipped', shipmentId: shipment.id } }, context: { step: 'ship_start', shipmentId: shipment.id }, metadata: { source: 'shipment/start' } })
        } catch {}
    }

    try {
        await DL.ShipHistory.create({
            shipmentId: shipment.id,
            storeId: admin.currentStoreId,
            shipperAdminId: _admin.id,
            shipperName: adminName,
            type: 'start',
            location: coordinates ? { type: 'Point', coordinates } : undefined,
            orderIds: successIds
        })
    } catch {}

    try { shipment.routeOrder = routeOrder } catch { }
    return { shipment, successIds, failures, routeOrder }
}

start.config = {
    permissions: ['order:ship'],
    preventMultiple: (body, info) => ':' + (info._admin?.id || '')
}
