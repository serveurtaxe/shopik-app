import captureOrder from '#server/utils/data/captureOrder.js'
import { snapshotSupplierCost } from '#server/utils/data/supplierCost.js'

export default async function pack(payload, { DL, _admin, utils, external }) {
    const { id, bags, boxes } = payload
    if (!id) throw { status: 400, message: 'id required' }

    const order = await DL.Order.readById(id)
    if (!order) throw { status: 404, message: 'order not found' }
    if (order.status !== 'picked') throw { status: 400, message: 'order not in picked' }
    // order:pick implies pack — allow owner or anyone with pick if unowned picked queue
    const isOwner = order.picker?.adminId === _admin.id
    const isUnowned = !order.picker?.adminId
    if (!isOwner && !isUnowned) throw { status: 403, message: 'not your order' }

    const adminName = `${_admin.name?.first ?? ''} ${_admin.name?.last ?? ''}`.trim()

    // Sole capture path — fail-closed: throws on any payment failure,
    // order stays in 'picked'. Only advances to 'packed' on success.
    const { captureAmount, totals, captureProviderTxnId, capturedAt } = await captureOrder({
        DL, _admin, utils, external, order
    })

    const set = {
        status: 'packed',
        picker: null,
        ...totals,
        paid: true,
        paidAt: capturedAt,
        'payment.capturedAt': capturedAt,
        'payment.captureProviderTxnId': captureProviderTxnId,
        paymentError: null
    }
    // Supplier-cost snapshot (fail-open): never blocks pack.
    try {
        const snap = await snapshotSupplierCost({ DL, order })
        set.cart = snap.cart
        set.supplierTotal = snap.supplierTotal
        set.supplierMissingCount = snap.supplierMissingCount
        set.supplierCapturedAt = snap.supplierCapturedAt
    } catch {}
    // Comax delivery document, prices from price list (fail-open): pack proceeds regardless.
    // DocNumber is kept for client cancellation; retry fills it if missing.
    // Per-line prices are backfilled into comax_delivery_docs (inline attempt + cron).
    if (!order.comaxDoc?.docNumber) {
        try {
            const orderForComax = set.cart ? { ...order, cart: set.cart } : order
            const res = await external.comax.writeDeliveryDocument(orderForComax)
            set.comaxDoc = { docNumber: res.docNumber, totalSum: res.totalSum, capturedAt: new Date(), error: null }
            try {
                const cfg = await external.comax.resolveDeliveryConfig(order.storeId).catch(() => null)
                const delayMs = Number(process.env.COMAX_DELIVERY_FETCH_DELAY_MS || 30000)
                await DL.ComaxDeliveryDoc.create({
                    orderId: order.id,
                    orderNumber: order.number,
                    storeId: order.storeId,
                    docNumber: res.docNumber,
                    customerId: cfg?.customerId || '',
                    reference: String(order.number || ''),
                    status: 'pending',
                    attempts: 0,
                    nextAttemptAt: new Date(Date.now() + delayMs)
                })
                // Non-blocking inline attempt once Comax has indexed the doc;
                // the deliveryDocsSync cron backstops on restart/failure.
                setTimeout(() => {
                    external.comax.syncDeliveryDoc(res.docNumber).catch(() => {})
                }, delayMs).unref?.()
            } catch {}
        } catch (e) {
            set.comaxDoc = { capturedAt: new Date(), error: e?.message || String(e) }
        }
    }
    if (bags) set.bags = bags
    if (boxes) set.boxes = boxes

    const updated = await DL.Order.updateOne(
        { id, status: 'picked' },
        { $set: set }
    )

    if (!updated) throw { status: 409, message: 'status changed' }

    try {
        await DL.Owner.updateOne({ orderId: id, type: 'picking', status: 'active' }, { status: 'done', end: new Date() })
    } catch {}
    try {
        await DL.PickHistory.create({
            orderId: id, storeId: order.storeId, adminId: _admin.id, adminName, action: 'pack', barcode: 'ORDER',
            pickedAt: new Date(), windowDate: order.window?.date
        })
    } catch {}

    try {
        const { record, adminActor } = utils.data.timeline
        await record({
            DL, order,
            eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_STATUS_UPDATE,
            actor: adminActor(_admin),
            changes: { oldData: { status: 'picked' }, newData: { status: 'packed', bags, boxes } },
            context: { step: 'pack', capturedAmount: captureAmount },
            metadata: { source: 'order/ops/pack' }
        })
    } catch {}

    return updated
}

pack.config = {
    permissions: ['order:pick'],
    preventMultiple: (body) => ':' + body.id
}
