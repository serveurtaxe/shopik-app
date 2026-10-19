import { balancedRoute } from '#common/functions/routeSort.js'

export default async function route(payload, { DL, _admin, external }) {
    const { shipmentId, origin } = payload
    if (!shipmentId) throw { status: 400, message: 'shipmentId required' }

    const shipment = await DL.Shipment.readById(shipmentId)
    if (!shipment) throw { status: 404, message: 'shipment not found' }
    if (shipment.shipper?.adminId !== _admin.id && !_admin.isSuperAdmin) throw { status: 403, message: 'not your shipment' }

    const orders = await DL.Order.Model.find({ id: { $in: shipment.orderIds } }, { _id: 0, id: 1, address: 1, window: 1 }).lean()

    // geocode missing locations
    for (const o of orders) {
        if (!o.address?.location?.coordinates?.length) {
            try {
                const geocoded = await external?.geocode?.address?.(o.address) || o.address
                if (geocoded?.location?.coordinates?.length) {
                    await DL.Order.Model.updateOne({ id: o.id }, { $set: { 'address.location': geocoded.location } })
                    o.address.location = geocoded.location
                }
            } catch {}
        }
    }

    // Explicit recalc only — the MINE list stays static otherwise (see shipment/start).
    // Origin: store point saved at start; payload origin overrides (e.g. re-optimize from GPS).
    const current = origin || shipment.startLocation?.coordinates || shipment.currentLocation?.coordinates || null
    const seq = balancedRoute(orders, current, Date.now())

    await DL.Shipment.updateOne({ id: shipmentId }, { routeOrder: seq })

    return { routeOrder: seq, orders: orders.map(o => ({ id: o.id, address: o.address, window: o.window })) }
}

route.config = {
    permissions: ['order:ship']
}
