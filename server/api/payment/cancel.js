import { round2 } from '#common/functions/calcOrder/utils.js'
import { remainderRefundItems } from '#common/functions/refundCalc.js'
import { planRefundLegs, executeRefundPlan } from '#server/utils/data/refundCaptures.js'
import { recordCancel, recordRefund } from '#server/utils/data/userStats.js'
import { releaseWindowReservation } from '#server/utils/data/windowGroups.js'

export default async function cancel(payload, info) {
    const { DL, external, utils, _admin } = info
    const { orderId, reason } = payload

    const order = await DL.Order.readById(orderId)
    if (!order) throw { status: 404, message: 'Order not found' }
    if (order.status === DL.Order.constants.ORDER_STATUS.CANCELED) throw { status: 400, message: 'Order already canceled' }

    const { record, adminActor } = utils.data.timeline
    const hasCapture = Boolean(order.paid && order.payment?.captureProviderTxnId)
    const hasAuth = Boolean(order.payment?.providerTxnId)

    // Every other status transition records ORDER_STATUS_UPDATE (stepper history
    // + timeline status pill depend on it) — cancel must do the same.
    async function recordStatusCanceled() {
        await record({
            DL, order,
            eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_STATUS_UPDATE,
            actor: adminActor(_admin),
            context: { step: 'order_canceled', reason },
            changes: { oldData: { status: order.status }, newData: { status: 'canceled' } },
            outcome: { success: true },
            metadata: { source: 'payment/cancel' }
        })
    }

    const slotReleasedOnCancel = order.status === DL.Order.constants.ORDER_STATUS.PAID
    async function releaseWindowSlot() {
        if (!slotReleasedOnCancel || !order.window?.id) return
        try {
            await releaseWindowReservation(DL, order.window.id, order.window.reservedGroupId)
        } catch { }
    }

    if (!hasAuth && !hasCapture) throw { status: 400, message: 'No payment to cancel' }

    // Case 1: only J5 hold, no capture
    if (!hasCapture && hasAuth) {
        const targetId = String(order.payment.providerTxnId)
        let res
        try {
            res = await external.hyp.cancel({ providerTxnId: targetId })
        } catch (e) {
            throw { status: e.status || 502, message: e.message || 'Cancel failed' }
        }
        const okCodes = [0]
        const isOk = okCodes.includes(Number(res.CCode)) || Number(res.ReversalStatus) === 777
        if (!isOk && Number(res.CCode) !== 0) {
            const msg = external.hyp.ccodeMessage(res.CCode)
            await DL.PaymentTransaction.create({
                domainId: order.domainId, storeId: order.storeId,
                orderId: order.id, orderNumber: order.number, userId: order.userId,
                provider: 'hyp', kind: DL.PaymentTransaction.constants.TRANSACTION_KIND.CANCEL,
                status: DL.PaymentTransaction.constants.TRANSACTION_STATUS.FAILED,
                amount: order.payment.authorizedAmount, providerTxnId: targetId, providerCode: res.CCode, providerData: res, error: msg
            }).catch(() => { })
            await record({
                DL, order, eventType: DL.Timeline.constants.EVENT_TYPES.PAYMENT,
                actor: adminActor(_admin),
                context: { step: 'payment_canceled_hold_released', provider: 'hyp', providerTxnId: targetId },
                outcome: { success: false, errorMessage: msg },
                metadata: { source: 'payment/cancel' }
            })
            throw { status: 502, message: msg }
        }
        await DL.PaymentTransaction.create({
            domainId: order.domainId, storeId: order.storeId,
            orderId: order.id, orderNumber: order.number, userId: order.userId,
            provider: 'hyp', kind: DL.PaymentTransaction.constants.TRANSACTION_KIND.CANCEL,
            status: DL.PaymentTransaction.constants.TRANSACTION_STATUS.SUCCESS,
            amount: order.payment.authorizedAmount, providerTxnId: targetId, providerCode: 0, providerData: res
        }).catch(() => { })
        await DL.Order.updateOne({ id: order.id }, { status: DL.Order.constants.ORDER_STATUS.CANCELED, cancelDate: new Date(), paymentError: null, ...(reason ? { cancelReason: String(reason) } : {}) })
        try {
            await recordCancel(DL, order, order.payment?.authorizedAmount)
        } catch { }
        await record({
            DL, order,
            eventType: DL.Timeline.constants.EVENT_TYPES.PAYMENT,
            actor: adminActor(_admin),
            context: { step: 'payment_canceled_hold_released', provider: 'hyp', providerTxnId: targetId, amount: order.payment.authorizedAmount, reason },
            changes: { oldData: { status: order.status }, newData: { status: 'canceled' } },
            outcome: { success: true },
            metadata: { source: 'payment/cancel' }
        })
        await recordStatusCanceled()
        await releaseWindowSlot()
        return { canceled: true, mode: 'hold_released' }
    }

    // Case 2 & 3: has capture — try CancelTrans first, fall back to full refund
    const captureId = String(order.payment.captureProviderTxnId)
    let cancelRes
    try {
        cancelRes = await external.hyp.cancel({ providerTxnId: captureId })
    } catch (e) {
        cancelRes = { CCode: 920, error: e.message }
    }

    const cancelOk = Number(cancelRes.CCode) === 0 || Number(cancelRes.ReversalStatus) === 777
    if (cancelOk) {
        await DL.PaymentTransaction.create({
            domainId: order.domainId, storeId: order.storeId,
            orderId: order.id, orderNumber: order.number, userId: order.userId,
            provider: 'hyp', kind: DL.PaymentTransaction.constants.TRANSACTION_KIND.CANCEL,
            status: DL.PaymentTransaction.constants.TRANSACTION_STATUS.SUCCESS,
            amount: order.finalSumWithShipping ?? order.finalSum,
            providerTxnId: captureId, providerCode: 0, providerData: cancelRes
        }).catch(() => { })
        await DL.Order.updateOne({ id: order.id }, { status: DL.Order.constants.ORDER_STATUS.CANCELED, cancelDate: new Date(), paymentError: null, ...(reason ? { cancelReason: String(reason) } : {}) })
        try {
            await recordCancel(DL, order, order.finalSumWithShipping ?? order.finalSum)
        } catch { }
        await record({
            DL, order,
            eventType: DL.Timeline.constants.EVENT_TYPES.PAYMENT,
            actor: adminActor(_admin),
            context: { step: 'payment_canceled', provider: 'hyp', providerTxnId: captureId, reason },
            changes: { oldData: { status: order.status }, newData: { status: 'canceled' } },
            outcome: { success: true },
            metadata: { source: 'payment/cancel' }
        })
        await recordStatusCanceled()
        await releaseWindowSlot()
        return { canceled: true, mode: 'cancel_trans' }
    }

    // Case 2 & 3: has capture — CancelTrans only voids pre-transmission deals
    // (same business day, roughly until 22:00 IL). Any other outcome
    // (920 already-transmitted, 4 not-approved on old deals, ...) means the
    // deal is out of the void window, so fall back to a full zikoy refund.
    const cancelCode = Number(cancelRes.CCode)

    if (!cancelOk) {
        // fallback: refund entire remaining amount, distributed across the
        // capture legs (needsSplit orders were captured in 2+ legs — a single
        // zikoy of the full amount fails with "Refund exceeds original amount")
        const remaining = Number((order.finalSumWithShipping ?? order.finalSum ?? 0) - (order.refundedTotal || 0))
        if (remaining <= 0.001) {
            await DL.Order.updateOne({ id: order.id }, { status: DL.Order.constants.ORDER_STATUS.CANCELED, cancelDate: new Date(), ...(reason ? { cancelReason: String(reason) } : {}) })
            try {
                await recordCancel(DL, order, 0)
            } catch { }
            await recordStatusCanceled()
            await releaseWindowSlot()
            return { canceled: true, mode: 'already_refunded' }
        }
        const fallbackReason = reason || 'cancel_fallback_refund'
        const { plan, legsTotal } = await planRefundLegs(DL, order, remaining)
        let completed = []
        let failed = null
        let noPlanMsg = null
        if (!plan || plan.length === 0) {
            noPlanMsg = `Remaining ${remaining} cannot be covered by captured legs (${legsTotal}) — a credit may have been issued manually via Hyp Console`
        } else {
            ;({ completed, failed } = await executeRefundPlan({
                DL, external, order, plan, reason: fallbackReason, items: remainderRefundItems(order), source: 'payment/cancel:refund_fallback'
            }))
        }
        const coveredTotal = round2(completed.reduce((acc, c) => acc + Number(c.amount || 0), 0))
        const multi = (plan || []).length > 1
        if (failed || noPlanMsg) {
            // Cancel through: the provider declined the zikoy (e.g. Shva code 4
            // on an unsettled deal). The customer sees a regular cancellation;
            // the unrefunded remainder is flagged for manual refund by finance.
            const failMsg = noPlanMsg || failed.message
            const pendingAmount = round2(remaining - coveredTotal)
            const prevRefunded = Number(order.refundedTotal || 0)
            if (coveredTotal > 0) {
                await DL.Order.Model.updateOne({ id: order.id }, { $inc: { refundedTotal: coveredTotal } }).catch(() => { })
                await DL.Order.Model.updateOne({ id: order.id }, { finalSumAfterRefunds: round2(Number(order.finalSumWithShipping ?? 0) - (prevRefunded + coveredTotal)) }).catch(() => { })
                try {
                    await recordRefund(DL, order, coveredTotal)
                    await recordCancel(DL, order, 0)
                } catch { }
            }
            await DL.Order.updateOne({ id: order.id }, {
                status: DL.Order.constants.ORDER_STATUS.CANCELED, cancelDate: new Date(),
                refundPending: pendingAmount,
                ...(reason ? { cancelReason: String(reason) } : {})
            })
            await record({
                DL, order, eventType: DL.Timeline.constants.EVENT_TYPES.REFUND,
                actor: adminActor(_admin),
                context: {
                    step: 'refund_failed', provider: 'hyp', amount: remaining, coveredTotal, pendingRefund: pendingAmount, cancelCode,
                    refunds: completed, ...(failed ? { failedLeg: { providerTxnId: failed.providerTxnId, amount: failed.amount, providerData: failed.hypRes } } : { legsTotal })
                },
                outcome: { success: false, errorMessage: failMsg },
                metadata: { source: 'payment/cancel:refund_fallback' }
            })
            await record({
                DL, order, eventType: DL.Timeline.constants.EVENT_TYPES.PAYMENT,
                actor: adminActor(_admin),
                context: { step: 'payment_canceled', provider: 'hyp', pendingRefund: pendingAmount },
                changes: { oldData: { status: order.status }, newData: { status: 'canceled' } },
                outcome: { success: true },
                metadata: { source: 'payment/cancel' }
            })
            await recordStatusCanceled()
            await releaseWindowSlot()
            return {
                canceled: true, mode: 'refund_pending', refunded: coveredTotal, pendingRefund: pendingAmount,
                ...(completed[0] ? { providerTxnId: completed[0].providerTxnId } : {}),
                ...(multi ? { refunds: completed } : {})
            }
        }
        const newId = completed[0]?.providerTxnId
        const prevRefunded = Number(order.refundedTotal || 0)
        await DL.Order.Model.updateOne({ id: order.id }, { $inc: { refundedTotal: remaining } }).catch(() => { })
        await DL.Order.Model.updateOne({ id: order.id }, { finalSumAfterRefunds: round2(Number(order.finalSumWithShipping ?? 0) - (prevRefunded + remaining)) }).catch(() => { })
        try {
            await recordRefund(DL, order, remaining)
            await recordCancel(DL, order, 0)
        } catch { }
        await DL.Order.updateOne({ id: order.id }, { status: DL.Order.constants.ORDER_STATUS.CANCELED, cancelDate: new Date(), ...(reason ? { cancelReason: String(reason) } : {}) })
        await record({
            DL, order, eventType: DL.Timeline.constants.EVENT_TYPES.REFUND,
            actor: adminActor(_admin),
            context: { step: 'refund', provider: 'hyp', providerTxnId: newId, parentProviderTxnId: completed[0]?.parentProviderTxnId, amount: remaining, cancelCode, reason: fallbackReason, items: remainderRefundItems(order), ...(multi ? { refunds: completed } : {}) },
            changes: { oldData: { refundedTotal: prevRefunded }, newData: { refundedTotal: prevRefunded + remaining } },
            outcome: { success: true },
            metadata: { source: 'payment/cancel:refund_fallback' }
        })
        await record({
            DL, order, eventType: DL.Timeline.constants.EVENT_TYPES.PAYMENT,
            actor: adminActor(_admin),
            context: { step: 'payment_canceled', provider: 'hyp', providerTxnId: newId },
            changes: { oldData: { status: order.status }, newData: { status: 'canceled' } },
            outcome: { success: true },
            metadata: { source: 'payment/cancel' }
        })
        await recordStatusCanceled()
        await releaseWindowSlot()
        return { canceled: true, mode: 'refund_fallback', refunded: remaining, providerTxnId: newId, ...(multi ? { refunds: completed } : {}) }
    }
}

cancel.config = {
    required: ['orderId'],
    permissions: ['order:payment'],
    preventMultiple: (body) => ':' + body.orderId
}
