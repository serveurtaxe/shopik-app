import getShippingConfig from './getShippingConfig.js'
import { adjustPaidTotal } from './userStats.js'
import { issueInvoice } from './invoice.js'
import { calcShipping } from '#common/functions/shipping.js'
import { round2 } from '#common/functions/calcOrder/utils.js'

const EPS = 0.005

// Hyp getToken returns Tokef in YYMM format (e.g. '2912' = Dec 2029).
// Shva rejects anything else with CCode 416.
function isTokefValid(tokef) {
    return /^\d{2}(0[1-9]|1[0-2])$/.test(String(tokef ?? ''))
}

async function recordCapture({ DL, utils, actor, order, ok, step, providerTxnId, amount, authorizedAmount, capturedTotal, errorMessage, providerCode, source }) {
    try {
        const { record } = utils.data.timeline
        await record({
            DL, order,
            eventType: DL.Timeline.constants.EVENT_TYPES.PAYMENT,
            actor,
            context: {
                step, provider: 'hyp',
                providerTxnId, parentProviderTxnId: order.payment?.providerTxnId,
                amount, authorizedAmount, capturedTotal,
                providerCode,
                payments: order.payment?.payments,
                hasJ5Refs: Boolean(order.payment?.authCode && order.payment?.providerUid),
                tokefValid: isTokefValid(order.payment?.cardExpiry)
            },
            outcome: ok ? { success: true } : { success: false, errorMessage },
            metadata: { source }
        })
    } catch {}
}

async function persistCaptureTxn({ DL, order, status, amount, providerTxnId, providerCode, providerData, error }) {
    try {
        await DL.PaymentTransaction.create({
            domainId: order.domainId, storeId: order.storeId,
            orderId: order.id, orderNumber: order.number, userId: order.userId,
            provider: 'hyp', kind: DL.PaymentTransaction.constants.TRANSACTION_KIND.CAPTURE,
            status,
            amount, terminalId: process.env.HYP_MASOF || undefined,
            payments: order.payment?.payments,
            providerTxnId, parentProviderTxnId: order.payment?.providerTxnId,
            providerCode, providerData, error
        })
    } catch {}
}

// Fail-closed: any capture failure persists paymentError + FAILED txn + timeline, then throws.
// The order stays un-captured so the caller must not advance its status.
async function failClosed({ DL, utils, actor, external, order, totals, amount, authorizedAmount, capturedTotal, providerCode, providerData, providerTxnId, step, source }) {
    let providerMsg
    try {
        providerMsg = providerCode !== undefined
            ? external.hyp.ccodeMessage(providerCode)
            : (providerData?.message || 'Capture failed')
    } catch {
        providerMsg = providerCode !== undefined ? `Hyp error ${providerCode}` : (providerData?.message || 'Capture failed')
    }
    await DL.Order.updateOne({ id: order.id }, { ...totals, paymentError: providerMsg }).catch(() => {})
    await persistCaptureTxn({
        DL, order,
        status: DL.PaymentTransaction.constants.TRANSACTION_STATUS.FAILED,
        amount, providerTxnId, providerCode, providerData, error: providerMsg
    })
    await recordCapture({
        DL, utils, actor, order, ok: false, step,
        providerTxnId, amount, authorizedAmount, capturedTotal,
        errorMessage: providerMsg, providerCode, source
    })
    throw {
        status: 502, code: 'PAYMENT_CAPTURE_FAILED',
        message: `החיוב בסך ₪${amount} נכשל (${providerCode !== undefined ? `קוד ${providerCode}: ${providerMsg}` : providerMsg})`,
        providerCode, amount, authorizedAmount, capturedTotal
    }
}

async function okCapture({ DL, utils, actor, external, order, amount, providerTxnId, providerData, step, capturedTotal, authorizedAmount, source }) {
    await persistCaptureTxn({
        DL, order,
        status: DL.PaymentTransaction.constants.TRANSACTION_STATUS.SUCCESS,
        amount, providerTxnId, providerCode: 0, providerData
    })
    await recordCapture({
        DL, utils, actor, order, ok: true, step,
        providerTxnId, amount, authorizedAmount, capturedTotal,
        source
    })
}

async function authMissing({ DL, utils, actor, order, totals, message, amount, authorizedAmount, capturedTotal, delta, source }) {
    await DL.Order.updateOne({ id: order.id }, { ...totals, paymentError: message }).catch(() => {})
    await recordCapture({
        DL, utils, actor, order, ok: false, step: 'payment_capture_failed',
        amount: delta ?? amount, authorizedAmount, capturedTotal,
        errorMessage: message, source
    })
    throw {
        status: 402, code: 'PAYMENT_AUTH_MISSING', message,
        amount, authorizedAmount, capturedTotal, delta
    }
}

// Sole place where an order gets charged (Hyp J4 / token charge).
// Recomputes final totals incl. shipping, captures the full amount on first call
// or auto-charges only the delta on retry. Fail-closed: throws on any failure
// without advancing the order, so callers must only change status on success.
export default async function captureOrder({ DL, _admin, _user, utils, external, order, source = 'order/ops/pack' }) {
    const actor = _admin
        ? utils.data.timeline.adminActor(_admin)
        : (_user ? utils.data.timeline.userActor(_user) : null)

    // ---- Recompute final totals incl. shipping (pick_complete doesn't refresh them) ----
    // Shipping is based on pre-coupon sum per spec.
    const sumBase = Number(order.sum ?? order.finalSum ?? 0)
    const finalBase = Number(order.finalSum ?? sumBase)
    let shipping = Number(order.finalShipping ?? order.shipping ?? 0)
    try {
        const shippingConfig = await getShippingConfig(DL, order.domainId)
        shipping = calcShipping({ sum: sumBase, deliveryMethod: order.deliveryMethod, shippingConfig })
    } catch {}
    const captureAmount = round2(finalBase + shipping)
    const totals = {
        shipping,
        finalShipping: shipping,
        sumWithShipping: round2(sumBase + shipping),
        finalSumWithShipping: captureAmount
    }
    if (!captureAmount || captureAmount <= 0) throw { status: 400, message: 'invalid charge amount' }

    const hyp = external.hyp
    // Installment count chosen on Hyp's payment page (undefined/1 = one charge).
    const payments = order.payment?.payments
    const authorizedAmount = Number(order.payment?.authorizedAmount ?? captureAmount)
    const alreadyPaid = Boolean(order.paid && order.payment?.captureProviderTxnId)
    let captureProviderTxnId = order.payment?.captureProviderTxnId
    const capturedAt = new Date()
    const ctx = { DL, utils, actor, external, order, totals, authorizedAmount, source }

    let statsDelta = 0
    if (!alreadyPaid) {
        // ---- Full J4 path: require J5 hold ----
        const p = order.payment || {}
        if (!p.cardToken || !p.cardExpiry || !p.authCode || !p.providerTxnId || !Number.isFinite(authorizedAmount)) {
            await authMissing({
                ...ctx,
                message: 'לא נמצאו פרטי תשלום לחיוב',
                amount: captureAmount
            })
        }
        if (!isTokefValid(p.cardExpiry)) {
            await authMissing({
                ...ctx,
                message: 'תוקף הכרטיס השמור אינו תקין — לא ניתן לחייב (קוד 416)',
                amount: captureAmount
            })
        }
        const overCaptureAllowed = String(process.env.HYP_OVER_CAPTURE || 'false').toLowerCase() === 'true'
        const needsSplit = captureAmount > authorizedAmount + EPS && !overCaptureAllowed

        if (needsSplit) {
            const split = await hyp.captureOverCaptureSplit({ order, captureAmount, payments }).catch((e) => ({ error: e }))
            if (split?.error) {
                await failClosed({
                    ...ctx, amount: captureAmount,
                    providerData: { message: split.error?.message }, step: 'payment_capture_failed'
                })
            }
            const primary = split.primary
            if (!primary || Number(primary.CCode) !== 0) {
                await failClosed({
                    ...ctx, amount: captureAmount,
                    providerCode: primary?.CCode, providerData: primary,
                    providerTxnId: primary?.Id ? String(primary.Id) : undefined,
                    step: 'payment_capture_failed'
                })
            }
            const primaryId = primary.Id ? String(primary.Id) : undefined
            await okCapture({
                ...ctx, amount: authorizedAmount,
                providerTxnId: primaryId, providerData: primary,
                step: 'payment_captured'
            })
            captureProviderTxnId = primaryId
            const secondary = split.secondary
            if (!secondary || Number(secondary.CCode) !== 0) {
                // Primary leg already captured; retry continues via delta path.
                await failClosed({
                    ...ctx, amount: split.overflow,
                    capturedTotal: authorizedAmount,
                    providerCode: secondary?.CCode, providerData: secondary,
                    providerTxnId: secondary?.Id ? String(secondary.Id) : undefined,
                    step: 'payment_capture_failed'
                })
            }
            const secondId = secondary.Id ? String(secondary.Id) : undefined
            await okCapture({
                ...ctx, amount: split.overflow,
                providerTxnId: secondId, providerData: secondary,
                step: 'payment_captured_overflow', capturedTotal: authorizedAmount
            })
            captureProviderTxnId = secondId || primaryId
        } else {
            const result = await hyp.capture({ order, amount: captureAmount, payments }).catch((e) => ({ error: e }))
            if (result?.error || Number(result?.CCode) !== 0) {
                await failClosed({
                    ...ctx, amount: captureAmount,
                    providerCode: result?.CCode, providerData: result?.error ? { message: result.error?.message } : result,
                    providerTxnId: result?.Id ? String(result.Id) : undefined,
                    step: 'payment_capture_failed'
                })
            }
            captureProviderTxnId = result.Id ? String(result.Id) : undefined
            await okCapture({
                ...ctx, amount: captureAmount,
                providerTxnId: captureProviderTxnId, providerData: result,
                step: 'payment_captured'
            })
        }
        // Stats counted authorizedAmount at checkout — adjust to captured total.
        statsDelta = round2(captureAmount - authorizedAmount)
    } else {
        // ---- Delta path: already captured, charge only the remainder ----
        let capturedTotal = 0
        try {
            const txns = await DL.PaymentTransaction.read({
                orderId: order.id, kind: DL.PaymentTransaction.constants.TRANSACTION_KIND.CAPTURE,
                status: DL.PaymentTransaction.constants.TRANSACTION_STATUS.SUCCESS
            })
            capturedTotal = round2((txns || []).reduce((acc, t) => acc + (Number(t.amount) || 0), 0))
        } catch {}
        const delta = round2(captureAmount - capturedTotal)
        if (delta > EPS) {
            const p = order.payment || {}
            if (!p.cardToken || !p.cardExpiry) {
                await authMissing({
                    ...ctx,
                    message: 'לא נמצאו פרטי תשלום לחיוב ההפרש',
                    amount: captureAmount, capturedTotal, delta
                })
            }
            if (!isTokefValid(p.cardExpiry)) {
                await authMissing({
                    ...ctx,
                    message: 'תוקף הכרטיס השמור אינו תקין — לא ניתן לחייב את ההפרש (קוד 416)',
                    amount: captureAmount, capturedTotal, delta
                })
            }
            const charged = await hyp.chargeToken({ order, amount: delta, payments }).catch((e) => ({ error: e }))
            if (charged?.error || Number(charged?.CCode) !== 0) {
                await failClosed({
                    ...ctx, amount: delta, capturedTotal,
                    providerCode: charged?.CCode, providerData: charged?.error ? { message: charged.error?.message } : charged,
                    providerTxnId: charged?.Id ? String(charged.Id) : undefined,
                    step: 'payment_capture_failed'
                })
            }
            const deltaId = charged.Id ? String(charged.Id) : undefined
            await okCapture({
                ...ctx, amount: delta,
                providerTxnId: deltaId, providerData: charged,
                step: 'payment_captured_delta', capturedTotal
            })
            captureProviderTxnId = deltaId || captureProviderTxnId
            // Stats already reflect capturedTotal — add only the new delta.
            statsDelta = delta
        }
    }

    if (statsDelta) {
        try {
            await adjustPaidTotal(DL, order, statsDelta)
        } catch { }
    }

    // One document per order, only after every capture leg succeeded. Best
    // effort: a failure here must never fail the charge (it is recorded on the
    // Invoice + timeline and retried by an admin/cron).
    const invoice = await issueInvoice({
        DL, external, utils,
        order: { ...order, ...totals },
        captured: captureAmount,
        source,
        actor
    }).catch(() => null)

    return { captureAmount, totals, captureProviderTxnId, capturedAt, invoice }
}
