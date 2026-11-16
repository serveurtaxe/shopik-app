import {
    releaseWindowReservation,
    expireWindowHold,
    holdDeadline,
    extendWindowHold
} from '#server/utils/data/windowGroups.js'
import { invalidateUserStore } from '#server/utils/data/getUserStore.js'
import { findByLocation } from '#server/external/supplyArea.js'
import { isElevatorRequired } from '#common/functions/address.js'
import { normalizeInvoiceRequest } from '#common/functions/invoice/request.js'
import removeCouponFromCart from '#server/utils/data/removeCouponFromCart.js'

const MAX_PAYMENTS_LIMIT = 36
const DEFAULT_MAX_PAYMENTS = 6

// A cart coupon must still be redeemable at payment time: an admin may have
// canceled/edited it, it may have expired, or a purge write may have failed.
export async function findInvalidCouponCodes({ DL, order, userId }) {
    const codes = [...new Set((order.coupons || []).map(c => c?.code).filter(Boolean))]
    if (!codes.length) return []

    const coupons = await DL.Coupon.read({ code: { $in: codes } }, { _id: 0 }, { limit: 0 })
    const byCode = new Map((coupons || []).map(c => [String(c.code).toLowerCase(), c]))
    const now = new Date()
    const uid = String(userId)

    const invalid = []
    for (const code of codes) {
        const key = String(code).toLowerCase()
        const coupon = byCode.get(key)
        if (!coupon) { invalid.push(code); continue }
        if (coupon.status !== DL.Coupon.constants.STATUS.ACTIVE) { invalid.push(code); continue }
        if (coupon.start && now < new Date(coupon.start)) { invalid.push(code); continue }
        if (coupon.end && now > new Date(coupon.end)) { invalid.push(code); continue }
        if (Array.isArray(coupon.whitelist) && coupon.whitelist.length && !coupon.whitelist.map(String).includes(uid)) {
            invalid.push(code)
            continue
        }
        if (Array.isArray(coupon.blacklist) && coupon.blacklist.map(String).includes(uid)) invalid.push(code)
    }
    return invalid
}

function normalizeMaxPayments(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_MAX_PAYMENTS
    const n = Number(value)
    if (!Number.isFinite(n)) return DEFAULT_MAX_PAYMENTS
    return Math.min(MAX_PAYMENTS_LIMIT, Math.max(1, Math.trunc(n)))
}

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

    // Never charge more than the total the storefront displayed. The client
    // sends what it showed; if the server cart is higher (a cart edit the
    // client missed, another tab/device, or an unsynced optimistic update) we
    // ask the customer to review the new total instead of charging it.
    const expectedAmount = Number(payload.expectedAmount)
    if (Number.isFinite(expectedAmount) && Number(amount) > expectedAmount + 0.01) {
        throw {
            status: 409,
            code: 'CART_CHANGED',
            message: 'Order total changed since it was displayed',
            amount: Number(amount),
            expectedAmount
        }
    }

    // Never charge a total that still relies on a coupon the customer can no
    // longer redeem. Remove it and ask the storefront to refresh the total.
    try {
        const invalidCouponCodes = await findInvalidCouponCodes({ DL, order, userId: _user.id })
        if (invalidCouponCodes.length) {
            for (const code of invalidCouponCodes) {
                await removeCouponFromCart({
                    DL,
                    utils,
                    order,
                    code,
                    actor: utils.data.timeline.userActor(_user)
                })
            }
            const fresh = await DL.Order.readOne({ id: order.id }).catch(() => null)
            const current = fresh || order
            const currentAmount = current.finalSumWithShipping ?? current.finalSum ?? current.sum
            throw {
                status: 409,
                code: 'CART_CHANGED',
                message: 'Coupon is no longer valid for this order',
                amount: Number(currentAmount),
                expectedAmount: Number.isFinite(expectedAmount) ? expectedAmount : undefined
            }
        }
    } catch (e) {
        if (e?.code === 'CART_CHANGED') throw e
        // Best-effort: a transient coupon-read error must not block a payment
        // that otherwise passed validation.
    }

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
        let deliveryAddr = hasDeliveryAddress ? addr : null
        if (!hasDeliveryAddress) {
            const activeAddr = _user.addresses?.find((a) => a.active) || _user.addresses?.[0]
            const hasCandidate = activeAddr && isNonEmpty(activeAddr.city) && isNonEmpty(activeAddr.street) && activeAddr.building != null && String(activeAddr.building).trim() !== ''
            if (hasCandidate) {
                updates.address = activeAddr
                deliveryAddr = activeAddr
            } else {
                missingFields.push('address')
            }
        }
        // Area-assigned store is authoritative; recompute every time so a
        // stale/wrong storeId is corrected before payment.
        if (deliveryAddr) {
            const storeId = await utils.data.getStoreForAddress({ DL, address: deliveryAddr })
            if (storeId !== (order.storeId ?? null)) updates.storeId = storeId
        }
    }

    // Billing details captured at checkout. They belong to this order (the
    // invoice snapshot), never to the payment request: no card data is sent
    // to EZcount at capture time. `undefined` means "no billing input" and
    // keeps whatever is stored; an empty object clears it.
    const invoice = normalizeInvoiceRequest(payload.invoiceRequest)
    if (invoice.errors.length) throw {
        status: 400,
        message: invoice.errors[0],
        code: 'INVOICE_INVALID',
        errors: invoice.errors,
        missingFields: ['invoice']
    }
    if (invoice.value !== undefined) updates.invoiceRequest = invoice.value

    // A window hold runs for HOLD_MINUTES from selection, capped by the
    // window's lead time, plus one checkout grace. Once it is spent the
    // reservation is released and the customer must pick a new window.
    if (order.window?.id) {
        const lead = order.window.leadTimestamp ? new Date(order.window.leadTimestamp).getTime() : null
        if (holdDeadline(order.window) == null && lead != null && lead < Date.now()) {
            // Legacy cart with no hold fields: keep the old lead-time rule.
            const expiredWindowId = order.window.id
            const expiredGroupId = order.window.reservedGroupId
            try { await releaseWindowReservation(DL, expiredWindowId, expiredGroupId) } catch { }
            try { await DL.Order.updateOne({ id: order.id }, { $unset: { window: 1 } }) } catch { }
            order.window = undefined
        } else {
            await expireWindowHold(DL, order)
        }
    }

    if (!isPickup) {
        const deliveryAddr = updates.address || order.address
        if (deliveryAddr) {
            if (isElevatorRequired(deliveryAddr)) throw {
                status: 400,
                message: 'address_elevator_required',
                code: 'ELEVATOR_REQUIRED',
                missingFields: ['address']
            }
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
            // Capture can move the order to another store; the storefront's stock
            // context is cached, so the corrected store must invalidate it.
            if (updates.storeId) await invalidateUserStore(DL, _user.id)
        }
        throw { status: 400, message: `Missing required fields: ${missingFields.join(', ')}`, missingFields, code: 'MISSING_FIELDS' }
    }

    if (Object.keys(updates).length) {
        try {
            const updated = await DL.Order.updateOne({ id: order.id }, updates)
            if (updated?.id) Object.assign(order, updated)
            else Object.assign(order, updates)
        } catch { }
        if (updates.storeId) await invalidateUserStore(DL, _user.id)
    }

    // One-off checkout grace: a customer who started paying gets the extra
    // minutes to finish. Applied at most once per reservation and never
    // shortens the hold.
    let holdUntil = null
    if (order.window?.id) {
        try {
            const next = await extendWindowHold(DL, order)
            if (next != null) holdUntil = new Date(next)
        } catch { }
    }

    const hyp = external.hyp

    // How many payments the customer may pick on Hyp's payment page. Stored
    // per domain in Admin → Settings; missing/invalid falls back to 6.
    let maxPayments = DEFAULT_MAX_PAYMENTS
    try {
        const setting = await DL.Setting.readOne({ key: 'payment', domainId: order.domainId })
        maxPayments = normalizeMaxPayments(setting?.value?.maxPayments)
    } catch { }

    let paymentUrl
    try {
        paymentUrl = await hyp.createPaymentUrl({
            order,
            amount: Number(amount),
            maxPayments,
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

    return { paymentUrl, transactionId: txn.id, ...(holdUntil ? { holdUntil } : {}) }
}

create.config = {
    required: ['orderId'],
    preventMultiple: (body) => ':' + body.orderId
}
