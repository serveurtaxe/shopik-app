import { releaseWindowReservation } from '#server/utils/data/windowGroups.js'
import { findByLocation } from '#server/external/supplyArea.js'

export default async function create(payload, info) {
    const { DL, external, utils, _user } = info
    const { orderId } = payload

    if (!_user) throw { status: 401, message: 'Unauthorized' }

    const order = await DL.Order.readOne({ id: orderId })
    if (!order) throw { status: 404, message: 'Order not found' }
    if (String(order.userId) !== String(_user.id)) throw { status: 403, message: 'Not your order' }
    if (order.status !== DL.Order.constants.ORDER_STATUS.CART) throw { status: 400, message: 'Order not in cart status' }

    const amount = order.finalSumWithShipping ?? order.finalSum ?? order.sum
    if (!amount || Number(amount) <= 0) throw { status: 400, message: 'Order amount must be > 0' }

    // Enforce minSum / minSumPickup based on post-sale pre-coupon total (sumBeforeCoupon == order.sum)
    try {
        const limitsSetting = await DL.Setting.readOne({ key: 'limits' })
        const raw = limitsSetting?.value
        if (raw && typeof raw === 'object') {
            const threshold = order.deliveryMethod === DL.Order.constants.DELIVERY_METHOD.PICKUP
                ? Number(raw.minSumPickup ?? 0) || 0
                : Number(raw.minSum ?? 0) || 0
            if (threshold > 0) {
                const sumForCheck = Number(order.sum ?? 0) || 0
                if (sumForCheck < threshold) {
                    throw { status: 400, message: `Minimum order sum not reached (min ${threshold})`, code: 'MIN_SUM_NOT_REACHED', threshold, sum: sumForCheck, minSum: threshold }
                }
            }
        }
    } catch (e) {
        if (e?.code === 'MIN_SUM_NOT_REACHED') throw e
    }

    // ---- Validate required order fields & auto-fill from _user ----
    const isNonEmpty = (v) => typeof v === 'string' && v.trim().length > 0
    const hasOrderName = order.name && isNonEmpty(order.name.first) && isNonEmpty(order.name.last)
    const updates = {}
    const missingFields = []

    if (!hasOrderName) {
        const hasUserName = _user.name && isNonEmpty(_user.name.first) && isNonEmpty(_user.name.last)
        if (hasUserName) {
            updates.name = { first: _user.name.first.trim(), last: _user.name.last.trim() }
        } else {
            missingFields.push('name')
        }
    }
    if (!isNonEmpty(order.email)) {
        if (isNonEmpty(_user.email)) updates.email = _user.email.trim()
        else missingFields.push('email')
    }
    if (!isNonEmpty(order.phone)) {
        if (isNonEmpty(_user.phone)) updates.phone = _user.phone.trim()
        else missingFields.push('phone')
    }

    const deliveryMethod = order.deliveryMethod || DL.Order.constants.DELIVERY_METHOD.DELIVERY
    const isPickup = deliveryMethod === DL.Order.constants.DELIVERY_METHOD.PICKUP
    if (isPickup) {
        const hasPickupAddress = order.storeId || (order.address && isNonEmpty(order.address.city))
        if (!hasPickupAddress) {
            if (_user.pickupStoreId) {
                try {
                    const store = await DL.Store.readById(_user.pickupStoreId)
                    if (store?.id) {
                        updates.storeId = store.id
                        if (store.address) updates.address = store.address
                    } else {
                        missingFields.push('address')
                    }
                } catch {
                    missingFields.push('address')
                }
            } else {
                missingFields.push('address')
            }
        }
    } else {
        const addr = order.address
        const hasDeliveryAddress = addr && isNonEmpty(addr.city) && isNonEmpty(addr.street) && addr.building != null && String(addr.building).trim() !== ''
        if (!hasDeliveryAddress) {
            const activeAddr = _user.addresses?.find((a) => a.active) || _user.addresses?.[0]
            const hasCandidate = activeAddr && isNonEmpty(activeAddr.city) && isNonEmpty(activeAddr.street) && activeAddr.building != null && String(activeAddr.building).trim() !== ''
            if (hasCandidate) {
                updates.address = activeAddr
                if (!order.storeId && activeAddr.location?.coordinates?.length) {
                    try {
                        const store = await DL.Store.Model.findOne({
                            'address.location': {
                                $nearSphere: {
                                    $geometry: activeAddr.location,
                                    $maxDistance: 10 * 1000
                                }
                            }
                        }, { _id: 0, id: 1 }).lean()
                        if (store?.id) updates.storeId = store.id
                    } catch { }
                }
            } else {
                missingFields.push('address')
            }
        }
    }

    // If the chosen window's lead time has passed, remove it and treat as missing
    if (order.window?.leadTimestamp) {
        const lead = new Date(order.window.leadTimestamp).getTime()
        if (!Number.isNaN(lead) && lead < Date.now()) {
            const expiredWindowId = order.window.id
            const expiredGroupId = order.window.reservedGroupId
            try { await releaseWindowReservation(DL, expiredWindowId, expiredGroupId) } catch {}
            try { await DL.Order.updateOne({ id: order.id }, { $unset: { window: 1 } }) } catch {}
            order.window = undefined
        }
    }

    if (!isPickup) {
        const deliveryAddr = updates.address || order.address
        if (deliveryAddr) {
            const area = await findByLocation(DL, deliveryAddr.location)
            if (!area) throw {
                status: 400,
                message: 'Address has no service',
                code: 'NO_SERVICE',
                missingFields: ['address']
            }
        }
    }

    if (!order.window || !order.window.id || !order.window.date) {
        missingFields.push('window')
    }

    if (missingFields.length) {
        if (Object.keys(updates).length) {
            try {
                await DL.Order.updateOne({ id: order.id }, updates)
                Object.assign(order, updates)
            } catch { }
        }
        throw { status: 400, message: `Missing required fields: ${missingFields.join(', ')}`, missingFields, code: 'MISSING_FIELDS' }
    }

    if (Object.keys(updates).length) {
        try {
            const updated = await DL.Order.updateOne({ id: order.id }, updates)
            if (updated?.id) Object.assign(order, updated)
            else Object.assign(order, updates)
        } catch { }
    }

    const hyp = external.hyp

    let paymentUrl
    try {
        paymentUrl = await hyp.createPaymentUrl({
            order,
            amount: Number(amount),
            customer: {
                name: _user.name,
                phone: _user.phone,
                email: _user.email
            }
        })
    } catch (e) {
        throw { status: e.status || 502, message: e.message || 'Failed to create payment url' }
    }

    const terminalId = process.env.HYP_MASOF || undefined

    const txn = await DL.PaymentTransaction.create({
        domainId: order.domainId,
        storeId: order.storeId,
        orderId: order.id,
        orderNumber: order.number,
        userId: order.userId,
        provider: 'hyp',
        kind: DL.PaymentTransaction.constants.TRANSACTION_KIND.AUTH,
        status: DL.PaymentTransaction.constants.TRANSACTION_STATUS.PENDING,
        amount: Number(amount),
        terminalId,
        providerData: { createdAt: new Date().toISOString(), orderNumber: order.number }
    })

    try {
        await DL.Order.updateOne({ id: order.id }, { $inc: { paymentAttempts: 1 } })
    } catch { }

    try {
        const { record, userActor } = utils.data.timeline
        await record({
            DL,
            order,
            eventType: DL.Timeline.constants.EVENT_TYPES.PAYMENT,
            actor: userActor(_user),
            context: { step: 'payment_initiated', provider: 'hyp', amount: Number(amount), orderNumber: order.number, terminalId, providerTxnId: txn.providerTxnId || txn.id },
            outcome: { success: true },
            metadata: { source: 'payment/create', referenceOrderNumber: order.number }
        })
    } catch { }

    return { paymentUrl, transactionId: txn.id }
}

create.config = {
    required: ['orderId'],
    preventMultiple: (body) => ':' + body.orderId
}
