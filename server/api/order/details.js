import { MAX_ATTEMPTS } from '#server/cron/refundRetry.js'
import {
    DEFAULT_REFUND_REASONS,
    parseRefundReasons,
    parseSettingBoolean,
    REFUND_ALLOW_OTHER_KEY,
    REFUND_REASONS_KEY,
} from '#common/constants/refundReasons.js'

const DETAILS_SELECT = {
    _id: 0,
    id: 1,
    number: 1,
    domainId: 1,
    status: 1,
    userId: 1,
    paid: 1,
    paidAt: 1,
    time: 1,
    labels: 1,
    name: 1,
    phone: 1,
    secondPhone: 1,
    email: 1,
    address: 1,
    deliveryMethod: 1,
    deliveryDetails: 1,
    window: 1,
    replaceProducts: 1,
    replaceProductsNoCall: 1,
    leaveOrderAtDoor: 1,
    comment: 1,
    cart: 1,
    coupons: 1,
    payment: 1,
    refundedTotal: 1,
    refundedShipping: 1,
    refundPending: 1,
    refundPendingAttempts: 1,
    finalSumAfterRefunds: 1,
    cancelDate: 1,
    bags: 1,
    sum: 1,
    sumNoCoupon: 1,
    finalSum: 1,
    finalSumWithShipping: 1,
    shipping: 1,
    finalShipping: 1,
    picker: 1,
    pickFinalizer: 1,
    shipper: 1,
    orderFinalizer: 1,
    pickStart: 1,
    pickEnd: 1,
    deliveryProof: 1,
    cancelReason: 1,
    invoice: 1,
    invoiceRequest: 1,
    invoiceError: 1,
    vatBreakdown: 1,
    billingAdjustment: 1
}

export default async function details({ id }, { DL }) {
    const order = await DL.Order.readById(id, DETAILS_SELECT)
    if (!order) throw { status: 404, message: 'Order not found' }

    // paidAt isn't written by the payment callback — fall back to the first
    // successful auth transaction so we show the first payment, not the capture
    let paidAt = order.paidAt
    if (!paidAt && order.status !== 'cart') {
        const [firstAuth] = await DL.PaymentTransaction.read(
            { orderId: id, kind: 'auth', status: 'success' },
            { _id: 0, createdAt: 1 },
            { sort: { createdAt: 1 }, limit: 1 }
        )
        paidAt = firstAuth?.createdAt
    }

    // Manual-refund UI gate: auto-retry had its chance (attempts exhausted)
    // and a balance is still owed — only then show the banner + input.
    const refundPending = Number(order.refundPending || 0)
    const manualRequired = refundPending > 0 && Number(order.refundPendingAttempts || 0) >= MAX_ATTEMPTS

    // A successfully voided payment (CancelTrans) leaves no invoice doc behind,
    // unlike a cancel that went through refunds. Only void paths write a
    // SUCCESS cancel transaction, so its presence means "not invoiceable".
    let paymentVoided = false
    if (order.status === 'canceled') {
        const [voidTxn] = await DL.PaymentTransaction.read(
            { orderId: id, kind: 'cancel', status: 'success' },
            { _id: 0, providerTxnId: 1 },
            { limit: 1 }
        )
        paymentVoided = Boolean(voidTxn)
    }

    // General-refund reasons are configured per domain. Missing settings fall
    // back to the built-in list and keep the free-text "other" option enabled.
    let refundSettings = []
    try {
        refundSettings = await DL.Setting.read(
            { domainId: order.domainId, key: { $in: [REFUND_REASONS_KEY, REFUND_ALLOW_OTHER_KEY] } },
            { _id: 0, key: 1, value: 1 }
        ) || []
    } catch { refundSettings = [] }
    const refundByKey = Object.fromEntries(refundSettings.map(s => [s.key, s.value]))
    const hasReasonsSetting = Object.prototype.hasOwnProperty.call(refundByKey, REFUND_REASONS_KEY)
    const refundReasons = hasReasonsSetting
        ? parseRefundReasons(refundByKey[REFUND_REASONS_KEY])
        : DEFAULT_REFUND_REASONS
    const refundAllowOther = parseSettingBoolean(refundByKey[REFUND_ALLOW_OTHER_KEY], true)

    return {
        ...order,
        paidAt,
        manualRequired,
        paymentVoided,
        refundReasons,
        refundAllowOther,
    }
}

details.config = {
    required: ['id'],
    permissions: ['order:read']
}
