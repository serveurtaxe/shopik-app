import { snapshotSupplierCost } from '#server/utils/data/supplierCost.js'

/**
 * Backfill Comax doc + supplier snapshot for a packed+ order.
 * Fail-open by design: returns updated order; never throws Comax errors as 500
 * unless the order itself is missing. Guards never overwrite existing data.
 */
export default async function comaxRetry(payload, { DL, utils, external }) {
    const { id } = payload
    if (!id) throw { status: 400, message: 'id required' }
    const order = await DL.Order.readById(id)
    if (!order) throw { status: 404, message: 'order not found' }

    const set = {}
    if (order.supplierCapturedAt == null) {
        try {
            const snap = await snapshotSupplierCost({ DL, order })
            set.cart = snap.cart
            set.supplierTotal = snap.supplierTotal
            set.supplierMissingCount = snap.supplierMissingCount
            set.supplierCapturedAt = snap.supplierCapturedAt
        } catch {}
    }
    if (!order.comaxDoc?.docNumber) {
        try {
            const orderForComax = set.cart ? { ...order, cart: set.cart } : order
            const res = await external.comax.writeDeliveryDocument(orderForComax)
            set.comaxDoc = { docNumber: res.docNumber, totalSum: res.totalSum, capturedAt: new Date(), error: null }
            try {
                const cfg = await external.comax.resolveDeliveryConfig(order.storeId).catch(() => null)
                await DL.ComaxDeliveryDoc.create({
                    orderId: order.id,
                    orderNumber: order.number,
                    storeId: order.storeId,
                    docNumber: res.docNumber,
                    customerId: cfg?.customerId || '',
                    reference: String(order.number || ''),
                    status: 'pending',
                    attempts: 0,
                    nextAttemptAt: new Date()
                })
            } catch {}
        } catch (e) {
            set.comaxDoc = { ...(order.comaxDoc || {}), capturedAt: new Date(), error: e?.message || String(e) }
        }
    } else {
        // Doc exists but its per-line prices may never have been fetched
        // (docs created before the delivery-docs flow): ensure a pending row
        // so the deliveryDocsSync cron picks it up.
        try {
            const row = await DL.ComaxDeliveryDoc.readOne({ docNumber: order.comaxDoc.docNumber })
            if (!row) {
                const cfg = await external.comax.resolveDeliveryConfig(order.storeId).catch(() => null)
                await DL.ComaxDeliveryDoc.create({
                    orderId: order.id,
                    orderNumber: order.number,
                    storeId: order.storeId,
                    docNumber: order.comaxDoc.docNumber,
                    customerId: cfg?.customerId || '',
                    reference: String(order.number || ''),
                    status: 'pending',
                    attempts: 0,
                    nextAttemptAt: new Date()
                })
            }
        } catch {}
    }
    if (!Object.keys(set).length) return order
    const updated = await DL.Order.updateOne({ id }, { $set: set })
    try {
        const { record } = utils.data.timeline
        await record({
            DL, order,
            eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_STATUS_UPDATE,
            actor: null,
            changes: { oldData: {}, newData: { comaxDoc: set.comaxDoc, supplierTotal: set.supplierTotal } },
            context: { step: 'comax_retry' },
            metadata: { source: 'order/comax_retry' }
        })
    } catch {}
    return updated
}

comaxRetry.config = {
    permissions: ['order:update']
}
