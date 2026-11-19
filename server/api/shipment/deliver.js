import { opsProximityRadiusM } from '#common/functions/opsConfig.js'
import distanceMeters from '#common/functions/distance.js'
import sharp from 'sharp'

// A delivery proof photo is mandatory for a regular shipper. Only a manager may close
// an order without one, and a super admin keeps the skip as an audit escape.
export function maySkipPhoto(admin) {
    return admin?.isSuperAdmin === true || admin?.hasPermission?.('order:ship:manage') === true
}

// Delivery must happen near the customer address. A caller who is farther away
// (or whose GPS is unavailable) may only continue through an explicit override,
// which is gated on order:ship:manage and recorded on the order timeline and in
// ship_history. There is no anonymous `force` bypass.
export function evaluateProximity({ order, coordinates, override = false, canOverride = false }) {
    if (!coordinates || !order?.address?.location?.coordinates?.length) return null
    const distanceM = distanceMeters(coordinates, order.address.location.coordinates)
    const radiusM = opsProximityRadiusM()
    if (distanceM <= radiusM) return { distanceM, radiusM, overridden: false }
    if (!override) throw { status: 400, message: `too far: ${Math.round(distanceM)}m > ${radiusM}m (manager override required)` }
    if (!canOverride) throw { status: 403, message: 'proximity override not allowed' }
    return { distanceM, radiusM, overridden: true }
}

export default async function deliver(payload, { DL, _admin, external, utils }) {
    const { orderId, imageBase64, coordinates, override, force, overrideReason } = payload
    if (!orderId) throw { status: 400, message: 'orderId required' }
    // Delivery proof is mandatory for a regular shipper; skipping it is a manager call.
    const skipPhoto = !imageBase64 && maySkipPhoto(_admin)
    if (!imageBase64 && !skipPhoto) throw { status: 400, message: 'orderId and imageBase64 required' }
    if (imageBase64 && Buffer.byteLength(imageBase64, 'utf8') > 8 * 1024 * 1024) throw { status: 400, message: 'image too large' }

    const order = await DL.Order.readById(orderId)
    if (!order) throw { status: 404, message: 'order not found' }
    if (order.status !== 'shipped') throw { status: 400, message: 'order not in shipped' }

    const shipment = order.shipmentId ? await DL.Shipment.readById(order.shipmentId) : null
    // The shipment's own shipper closes it. A manager (order:ship:manage) may close it
    // for him — the permission that already lets him cancel that shipment — and the
    // close is recorded against the shipper he acted for.
    const canManageShip = _admin.hasPermission('order:ship:manage')
    const closedForOtherShipper = !!shipment && shipment.shipper?.adminId !== _admin.id
    if (closedForOtherShipper && !_admin.isSuperAdmin && !canManageShip) throw { status: 403, message: 'not your shipment' }

    // `force` is the legacy name for the same override; both still require the
    // manage permission, so old clients cannot bypass the check anonymously.
    const requestedOverride = override === true || force === true
    const canOverride = canManageShip
    if (requestedOverride && !canOverride) throw { status: 403, message: 'proximity override not allowed' }

    const proximity = evaluateProximity({ order, coordinates, override: requestedOverride, canOverride })
    // Record every explicit override, including GPS-unavailable deliveries where
    // there was no distance to compare.
    const overridden = requestedOverride && (proximity ? proximity.overridden : true)
    const overrideMeta = overridden ? {
        override: true,
        reason: typeof overrideReason === 'string' && overrideReason.trim() ? overrideReason.trim().slice(0, 500) : undefined,
        distanceM: proximity ? Math.round(proximity.distanceM) : undefined,
        radiusM: proximity?.radiusM
    } : undefined

    let url = null
    if (!skipPhoto) {
        const buffer = Buffer.from(imageBase64, 'base64')
        const processed = await sharp(buffer).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
        const path = `images/shipments/${orderId}.webp`

        url = path
        try {
            await external.storage.uploadFile({ path, data: processed, contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' })
            url = path
        } catch (e) {
            // if storage not configured, keep local path
        }
    }

    const at = new Date()
    // Who closed the order (handed it over) — the order keeps the deliverer
    // even when a manager closes it on behalf of the shipment's shipper.
    const adminName = `${_admin.name?.first ?? ''} ${_admin.name?.last ?? ''}`.trim()
    await DL.Order.Model.updateOne({ id: orderId }, {
        $set: {
            status: 'done',
            deliveryProof: { url, at },
            orderFinalizer: { adminId: _admin.id, name: adminName }
        }
    })

    try { await DL.Owner.updateOne({ orderId, type: 'shipping', status: 'active' }, { status: 'done', end: at }) } catch {}

    await utils.data.orderSms.sendOrderStageSms({
        DL,
        external,
        order,
        stage: 'done',
        adminId: _admin.id
    })

    if (shipment) {
        await DL.Shipment.Model.updateOne({ id: shipment.id }, { $push: { proof: { orderId, url, at } } })
        // ship_history deliver
        try {
            await DL.ShipHistory.create({
                shipmentId: shipment.id, orderId, storeId: shipment.storeId, shipperAdminId: _admin.id,
                type: overridden ? 'force' : 'deliver',
                location: coordinates ? { type: 'Point', coordinates } : undefined,
                at, proofUrl: url, metadata: overrideMeta
            })
        } catch {}

        const remaining = await DL.Order.Model.countDocuments({ id: { $in: shipment.orderIds }, status: { $ne: 'done' } })
        if (remaining === 0) {
            await DL.Shipment.updateOne({ id: shipment.id }, { status: 'done', completedAt: at })
            try { await DL.ShipHistory.create({ shipmentId: shipment.id, storeId: shipment.storeId, shipperAdminId: _admin.id, type: 'done', at, orderIds: shipment.orderIds }) } catch {}
        }
    }

    try {
        const { record, adminActor } = utils.data.timeline
        await record({
            DL, order, eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_STATUS_UPDATE, actor: adminActor(_admin),
            changes: { oldData: { status: 'shipped' }, newData: { status: 'done', deliveryProof: { url } } },
            context: { step: 'deliver', override: overridden, overrideReason: overrideMeta?.reason, distanceM: overrideMeta?.distanceM, radiusM: overrideMeta?.radiusM, proofUrl: url, forShipperAdminId: closedForOtherShipper ? shipment.shipper?.adminId : undefined },
            metadata: { source: 'shipment/deliver' }
        })
    } catch {}

    return { orderId, url }
}

deliver.config = {
    permissions: ['order:ship'],
    preventMultiple: p => ':' + (p.orderId || '')
}
