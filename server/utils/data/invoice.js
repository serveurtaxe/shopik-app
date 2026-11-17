import { round2 } from '#common/functions/calcOrder/utils.js'
import {
    buildInvoiceLines,
    buildCreditLines,
    invoiceTotal,
    assertTotalsMatch,
    INVOICE_EPS
} from '#common/functions/invoice/lines.js'
import { buildInvoiceNotes } from '#common/functions/invoice/notes.js'
import { buildDocPayload, buildPaymentRow, DOC_TYPE } from '#common/functions/invoice/payload.js'
import { readVatSummary } from '#common/functions/invoice/summary.js'
import { cleanText } from '#common/functions/invoice/format.js'
import log from '#server/utils/log.js'

export const EZCOUNT_SETTING_KEY = 'ezcount'
export const PENDING_TTL_MS = 2 * 60 * 1000

export const DEFAULT_SETTINGS = {
    enabled: false,
    apiKey: '',
    createdByApiKey: '',
    developerEmail: '',
    baseUrl: '',
    docType: DOC_TYPE.INVOICE,
    creditDocType: DOC_TYPE.CREDIT,
    language: 'he',
    autoIssue: true,
    sendEmail: true,
    shadowMode: false,
    paymentType: 9,
    paymentName: 'כרטיס אשראי',
    invoiceNotes: { replaced: true, missing: true, coupon: true },
    crnThreshold: 5000
}

function envBool(name) {
    const raw = process.env[name]
    if (raw === undefined || raw === null || raw === '') return undefined
    return String(raw).toLowerCase() === 'true'
}

/**
 * Per-domain EZcount configuration, with env fallbacks. Encryption at rest is
 * handled by the Setting model (`formType: 'config'`).
 */
export async function getEzcountConfig(DL, domainId) {
    let stored = null
    try {
        const setting = domainId
            ? await DL.Setting.readOne({ key: EZCOUNT_SETTING_KEY, domainId })
            : await DL.Setting.readOne({ key: EZCOUNT_SETTING_KEY })
        stored = setting?.value || null
    } catch (e) {
        log.warn('[Invoice] failed to read EZcount setting:', e?.message || e)
    }

    const config = { ...DEFAULT_SETTINGS, ...(stored || {}) }
    config.invoiceNotes = { ...DEFAULT_SETTINGS.invoiceNotes, ...(stored?.invoiceNotes || {}) }
    // Credentials stored in the Setting win over env; record where each one
    // came from so a stale stored key is never mistaken for an env problem.
    const storedApiKey = config.apiKey
    const storedCreatedBy = config.createdByApiKey
    const storedEmail = config.developerEmail
    config.apiKey = storedApiKey || process.env.EZCOUNT_API_KEY || ''
    config.createdByApiKey = storedCreatedBy || process.env.EZCOUNT_CREATED_BY_API_KEY || ''
    config.developerEmail = storedEmail || process.env.EZCOUNT_DEVELOPER_EMAIL || ''
    config.baseUrl = config.baseUrl || process.env.EZCOUNT_BASE_URL || ''
    config.sources = {
        apiKey: config.apiKey ? (storedApiKey ? 'setting' : 'env') : 'missing',
        createdByApiKey: config.createdByApiKey ? (storedCreatedBy ? 'setting' : 'env') : 'missing',
        developerEmail: config.developerEmail ? (storedEmail ? 'setting' : 'env') : 'missing',
        baseUrl: config.baseUrl ? ((stored?.baseUrl) ? 'setting' : 'env') : 'default'
    }

    const envEnabled = envBool('EZCOUNT_ENABLED')
    if (envEnabled !== undefined) config.enabled = envEnabled
    const envAutoIssue = envBool('EZCOUNT_AUTO_ISSUE')
    if (envAutoIssue !== undefined) config.autoIssue = envAutoIssue
    const envShadow = envBool('EZCOUNT_SHADOW_MODE')
    if (envShadow !== undefined) config.shadowMode = envShadow

    config.ready = Boolean(config.enabled && config.apiKey && config.developerEmail)
    return config
}

export async function resolveInvoiceCustomer({ DL, order, user }) {
    let u = user || null
    if (!u && order?.userId) {
        try { u = await DL.User.readById(order.userId) } catch { }
    }
    const req = order?.invoiceRequest || {}
    const addr = order?.address || {}
    const address = [
        addr.street,
        addr.building,
        addr.apartment ? `דירה ${addr.apartment}` : '',
        addr.city
    ].filter(Boolean).join(' ')

    return {
        name: {
            first: u?.name?.first || order?.name?.first,
            last: u?.name?.last || order?.name?.last
        },
        fullName: req.companyName || u?.companyName || '',
        email: req.email || u?.email || order?.email || '',
        phone: u?.phone || order?.phone || '',
        taxId: req.taxId || u?.taxId || '',
        address
    }
}

async function recordEvent({ DL, utils, order, eventType, actor = null, context, outcome, source }) {
    try {
        const record = utils?.data?.timeline?.record
        if (!record) return
        await record({
            DL, order, eventType, actor,
            context,
            outcome,
            metadata: { source }
        })
    } catch { }
}

async function findOrCreateInvoice({ DL, idempotencyKey, defaults }) {
    try {
        const existing = await DL.Invoice.readOne({ idempotencyKey })
        if (existing) return { record: existing, created: false }
    } catch { }
    try {
        const record = await DL.Invoice.create({ ...defaults, idempotencyKey, status: 'pending' })
        return { record, created: true }
    } catch (e) {
        // Unique index race: another worker created the record first.
        const existing = await DL.Invoice.readOne({ idempotencyKey }).catch(() => null)
        if (existing) return { record: existing, created: false }
        throw e
    }
}

async function markInvoiceFailed({ DL, utils, order, record, error, response, actor, source, status = 'failed' }) {
    const message = cleanText(error, 500) || 'EZcount request failed'
    const isCredit = record.kind === 'credit'
    const updated = await DL.Invoice.updateOne(
        { id: record.id },
        { status, error: message, response: response ?? record.response ?? null }
    ).catch(() => null)

    try {
        if (isCredit) {
            // A failed credit note must never rewrite the invoice's own state:
            // the tax invoice is still a valid issued document, only its offset
            // is missing. The detail lives on the Invoice record + timeline.
            await DL.Order.Model.updateOne(
                { id: order.id },
                { 'invoice.creditError': message }
            )
        } else {
            await DL.Order.Model.updateOne(
                { id: order.id },
                { 'invoice.status': status, 'invoice.error': message, invoiceError: message }
            )
        }
    } catch { }

    await recordEvent({
        DL, utils, order, actor,
        eventType: isCredit
            ? DL?.Timeline?.constants?.EVENT_TYPES?.CREDIT_FAILED
            : DL?.Timeline?.constants?.EVENT_TYPES?.INVOICE_FAILED,
        context: {
            step: isCredit ? 'credit_failed' : 'invoice_failed',
            invoiceId: record.id, status, error: message
        },
        outcome: { success: false, errorMessage: message },
        source
    })

    return updated || { ...record, status, error: message }
}

function invoiceFields(record) {
    return {
        docId: record.docId,
        number: record.docNumber,
        url: record.docUrl,
        status: record.status,
        issuedAt: record.issuedAt,
        error: record.error || null
    }
}

async function markCaptureTransactions({ DL, order, record }) {
    try {
        await DL.PaymentTransaction.Model.updateMany(
            {
                orderId: order.id,
                kind: DL.PaymentTransaction.constants.TRANSACTION_KIND.CAPTURE,
                status: DL.PaymentTransaction.constants.TRANSACTION_STATUS.SUCCESS
            },
            {
                $set: {
                    invoiceId: record.id,
                    invoiceDocNumber: record.docNumber,
                    invoiceStatus: record.status
                }
            }
        )
    } catch { }
}

/**
 * Issue the single tax invoice for an order, after all capture legs succeeded.
 *
 * Never throws for a provider or configuration problem: the charge is already
 * done, so the failure is recorded (Invoice.status='failed' + order error +
 * timeline) and can be retried. Returns the Invoice record or
 * `{ skipped: reason }`.
 */
export async function issueInvoice({
    DL, external, utils, order, user = null,
    captured, source = 'capture', actor = null, force = false
}) {
    const config = await getEzcountConfig(DL, order?.domainId)
    if (!force && (!config.enabled || !config.autoIssue))
        return { skipped: 'disabled' }
    if (!order?.id)
        return { skipped: 'no_order' }

    const idempotencyKey = `invoice:${order.id}`
    const charged = round2(Number(captured ?? order.finalSumWithShipping ?? 0) || 0)
    const existing = await DL.Invoice.readOne({ idempotencyKey }).catch(() => null)

    if (existing?.status === 'issued') {
        // The amount charged after the document was issued must not be folded
        // into it — that needs a supplementary document or a credit, manually.
        if (Math.abs(Number(existing.amount || 0) - charged) > INVOICE_EPS) {
            try {
                await DL.Order.Model.updateOne({ id: order.id }, { billingAdjustment: 'pending' })
            } catch { }
            await recordEvent({
                DL, utils, order, actor,
                eventType: DL?.Timeline?.constants?.EVENT_TYPES?.INVOICE_FAILED,
                context: {
                    step: 'invoice_amount_changed', invoiceId: existing.id,
                    invoiced: existing.amount, charged
                },
                outcome: { success: false, errorMessage: 'amount changed after invoice was issued' },
                source
            })
        }
        return existing
    }
    if (existing?.status === 'pending' && Date.now() - new Date(existing.createdAt || 0).getTime() < PENDING_TTL_MS)
        return existing

    if (!config.ready) {
        const record = existing || (await findOrCreateInvoice({
            DL, idempotencyKey, defaults: {
                domainId: order.domainId, orderId: order.id, orderNumber: order.number,
                userId: order.userId, kind: 'invoice', provider: 'ezcount', amount: charged
            }
        })).record
        return markInvoiceFailed({
            DL, utils, order, record, actor, source,
            error: 'EZcount is not configured (missing apiKey/developerEmail)'
        })
    }

    let lines
    try {
        lines = buildInvoiceLines({ order })
        assertTotalsMatch({
            items: lines.items,
            discountLines: lines.discountLines,
            shippingLine: lines.shippingLine,
            roundingLine: lines.roundingLine,
            captured: charged
        })
    } catch (e) {
        const record = existing || (await findOrCreateInvoice({
            DL, idempotencyKey, defaults: {
                domainId: order.domainId, orderId: order.id, orderNumber: order.number,
                userId: order.userId, kind: 'invoice', provider: 'ezcount', amount: charged
            }
        })).record
        return markInvoiceFailed({
            DL, utils, order, record, actor, source,
            error: e?.message || String(e)
        })
    }

    const customer = await resolveInvoiceCustomer({ DL, order, user })
    if (charged >= Number(config.crnThreshold || 0) && !customer.taxId) {
        const record = existing || (await findOrCreateInvoice({
            DL, idempotencyKey, defaults: {
                domainId: order.domainId, orderId: order.id, orderNumber: order.number,
                userId: order.userId, kind: 'invoice', provider: 'ezcount', amount: charged
            }
        })).record
        return markInvoiceFailed({
            DL, utils, order, record, actor, source,
            status: 'pending_customer_details',
            error: `חשבונית מעל ${config.crnThreshold} ₪ דורשת ח.פ/ת.ז של הלקוח`
        })
    }

    const items = [
        ...lines.items,
        ...(lines.discountLines || []),
        ...(lines.shippingLine ? [lines.shippingLine] : []),
        ...(lines.roundingLine ? [lines.roundingLine] : [])
    ]
    const notes = buildInvoiceNotes({
        cart: order.cart,
        coupons: order.coupons,
        orderNumber: order.number,
        include: config.invoiceNotes
    })
    const payload = buildDocPayload({
        order,
        lines: items,
        docType: Number(config.docType) || DOC_TYPE.INVOICE,
        customer,
        notes,
        settings: config,
        sendEmail: config.sendEmail,
        payment: [buildPaymentRow({ amount: charged, settings: config })],
        idTransaction: idempotencyKey
    })

    const itemSnapshot = items.map(({ productId, barcode, name, quantity, gross, price, vat }) => ({
        productId, barcode, name, quantity, gross,
        price: price != null ? price : (quantity > 0 ? round2(gross / quantity) : gross), vat
    }))
    const { record, created } = await findOrCreateInvoice({
        DL,
        idempotencyKey,
        defaults: {
            domainId: order.domainId,
            orderId: order.id,
            orderNumber: order.number,
            userId: order.userId,
            kind: 'invoice',
            provider: 'ezcount',
            amount: charged,
            docType: Number(config.docType) || DOC_TYPE.INVOICE,
            items: itemSnapshot,
            notes,
            email: customer.email ? { to: customer.email, requestedAt: new Date() } : undefined,
            request: payload
        }
    })

    // A retry (failed record, manual re-issue, cron) reuses the original row, so
    // the create defaults never land. Refresh the audit snapshot explicitly, or
    // the record ends up "issued" with no trace of what was actually sent.
    if (!created) {
        await DL.Invoice.updateOne(
            { id: record.id },
            { request: payload, items: itemSnapshot, notes, amount: charged }
        ).catch(() => null)
    }

    if (config.shadowMode) {
        await DL.Invoice.updateOne(
            { id: record.id },
            { status: 'pending', request: payload, response: { shadow: true } }
        ).catch(() => null)
        log.info(`[Invoice] shadow mode — ${idempotencyKey} prepared for ${charged}`)
        return { ...record, status: 'pending', shadow: true }
    }

    let result
    try {
        result = await external.ezcount.createDoc({ config, payload })
    } catch (e) {
        return markInvoiceFailed({
            DL, utils, order, record, actor, source,
            error: e?.message || String(e)
        })
    }

    if (!result?.ok) {
        return markInvoiceFailed({
            DL, utils, order, record, actor, source,
            error: result?.error || 'EZcount rejected the document',
            response: result?.raw ?? null
        })
    }

    const issuedAt = new Date()
    const vatBreakdown = readVatSummary(result.raw)
    const updated = await DL.Invoice.updateOne(
        { id: record.id },
        {
            status: 'issued',
            docId: result.docId ?? null,
            docNumber: result.docNumber ?? null,
            docUrl: result.docUrl ?? null,
            response: result.raw ?? null,
            error: null,
            vatBreakdown: vatBreakdown || null,
            issuedAt
        }
    ).catch(() => null)

    const finalRecord = updated || { ...record, status: 'issued', docId: result.docId, docNumber: result.docNumber, docUrl: result.docUrl, issuedAt }

    try {
        const set = {
            'invoice.docId': finalRecord.docId,
            'invoice.number': finalRecord.docNumber,
            'invoice.url': finalRecord.docUrl,
            'invoice.status': 'issued',
            'invoice.issuedAt': issuedAt,
            'invoice.error': null,
            invoiceError: null,
            vatBreakdown: vatBreakdown || null
        }
        await DL.Order.Model.updateOne({ id: order.id }, set)
    } catch { }

    await markCaptureTransactions({ DL, order, record: finalRecord })

    await recordEvent({
        DL, utils, order, actor,
        eventType: DL?.Timeline?.constants?.EVENT_TYPES?.INVOICE_ISSUED,
        context: {
            step: 'invoice_issued', invoiceId: finalRecord.id,
            docNumber: finalRecord.docNumber, amount: charged,
            email: customer.email || null
        },
        outcome: { success: true },
        source
    })

    return finalRecord
}

/**
 * Issue a credit note for money already refunded (or a canceled charge).
 *
 * The refund must never be repeated because the document failed; the failure is
 * recorded and can be retried. Returns the credit Invoice record or
 * `{ skipped: reason }`.
 */
export async function issueCreditNote({
    DL, external, utils, order, user = null,
    refundItems = [], amount, refundTxnId,
    reason = '', source = 'refund', actor = null, force = false
}) {
    const config = await getEzcountConfig(DL, order?.domainId)
    if (!force && !config.enabled) return { skipped: 'disabled' }
    if (!order?.id) return { skipped: 'no_order' }
    if (!config.ready)
        return { skipped: 'not_configured' }

    const total = round2(Number(amount) || 0)
    if (!(total > 0)) return { skipped: 'zero_amount' }

    const invoice = await DL.Invoice.readOne({ orderId: order.id, kind: 'invoice', status: 'issued' })
        .catch(() => null)
    if (!invoice) return { skipped: 'no_invoice' }

    const key = refundTxnId ? `credit:${order.id}:${refundTxnId}` : `credit:${order.id}:cancel`
    const existing = await DL.Invoice.readOne({ idempotencyKey: key }).catch(() => null)
    if (existing?.status === 'issued') return existing
    if (existing?.status === 'pending' && Date.now() - new Date(existing.createdAt || 0).getTime() < PENDING_TTL_MS)
        return existing

    const lines = buildCreditLines({ refundItems, cart: order.cart })
    if (!lines.length) {
        const { record } = await findOrCreateInvoice({
            DL, idempotencyKey: key, defaults: {
                domainId: order.domainId, orderId: order.id, orderNumber: order.number,
                userId: order.userId, kind: 'credit', provider: 'ezcount', amount: total,
                linkedInvoiceId: invoice.id, linkedDocNumber: invoice.docNumber,
                refundTxnId
            }
        })
        return markInvoiceFailed({
            DL, utils, order, record, actor, source,
            error: 'credit note requires line attribution (no refund items)'
        })
    }

    try {
        assertTotalsMatch({ items: lines, captured: total })
    } catch (e) {
        const { record } = await findOrCreateInvoice({
            DL, idempotencyKey: key, defaults: {
                domainId: order.domainId, orderId: order.id, orderNumber: order.number,
                userId: order.userId, kind: 'credit', provider: 'ezcount', amount: total,
                linkedInvoiceId: invoice.id, linkedDocNumber: invoice.docNumber,
                refundTxnId
            }
        })
        return markInvoiceFailed({
            DL, utils, order, record, actor, source,
            error: e?.message || String(e)
        })
    }

    const customer = await resolveInvoiceCustomer({ DL, order, user })
    const notes = [
        `זיכוי לחשבונית ${invoice.docNumber || ''}`.trim(),
        reason ? `סיבה: ${cleanText(reason, 120)}` : ''
    ].filter(Boolean).join('\n')

    const payload = buildDocPayload({
        order,
        lines,
        docType: Number(config.creditDocType) || DOC_TYPE.CREDIT,
        customer,
        notes,
        settings: config,
        sendEmail: config.sendEmail,
        parent: invoice.docId || undefined,
        idTransaction: key
    })

    const creditItemSnapshot = lines.map(({ productId, barcode, name, quantity, gross, vat }) => ({
        productId, barcode, name, quantity, gross, vat
    }))
    const { record, created } = await findOrCreateInvoice({
        DL,
        idempotencyKey: key,
        defaults: {
            domainId: order.domainId,
            orderId: order.id,
            orderNumber: order.number,
            userId: order.userId,
            kind: 'credit',
            provider: 'ezcount',
            amount: total,
            docType: Number(config.creditDocType) || DOC_TYPE.CREDIT,
            items: creditItemSnapshot,
            notes,
            linkedInvoiceId: invoice.id,
            linkedDocNumber: invoice.docNumber,
            refundTxnId,
            email: customer.email ? { to: customer.email, requestedAt: new Date() } : undefined,
            request: payload
        }
    })

    // Same as the invoice path: a retried credit note must keep the payload it
    // was actually sent with, plus the linkage to the document it offsets.
    if (!created) {
        await DL.Invoice.updateOne(
            { id: record.id },
            {
                request: payload,
                items: creditItemSnapshot,
                notes,
                amount: total,
                linkedInvoiceId: invoice.id,
                linkedDocNumber: invoice.docNumber
            }
        ).catch(() => null)
    }

    if (config.shadowMode) {
        await DL.Invoice.updateOne(
            { id: record.id },
            { status: 'pending', request: payload, response: { shadow: true } }
        ).catch(() => null)
        log.info(`[Invoice] shadow mode — credit ${key} prepared for ${total}`)
        return { ...record, status: 'pending', shadow: true }
    }

    let result
    try {
        result = await external.ezcount.createDoc({ config, payload })
    } catch (e) {
        return markInvoiceFailed({
            DL, utils, order, record, actor, source,
            error: e?.message || String(e)
        })
    }

    if (!result?.ok) {
        return markInvoiceFailed({
            DL, utils, order, record, actor, source,
            error: result?.error || 'EZcount rejected the credit note',
            response: result?.raw ?? null
        })
    }

    const issuedAt = new Date()
    const updated = await DL.Invoice.updateOne(
        { id: record.id },
        {
            status: 'issued',
            docId: result.docId ?? null,
            docNumber: result.docNumber ?? null,
            docUrl: result.docUrl ?? null,
            response: result.raw ?? null,
            error: null,
            vatBreakdown: readVatSummary(result.raw) || null,
            issuedAt
        }
    ).catch(() => null)
    const finalRecord = updated || { ...record, status: 'issued', docId: result.docId, docNumber: result.docNumber, docUrl: result.docUrl, issuedAt }

    try {
        await DL.Order.Model.updateOne(
            { id: order.id },
            {
                $push: {
                    'invoice.credits': {
                        invoiceId: finalRecord.id,
                        docId: finalRecord.docId,
                        number: finalRecord.docNumber,
                        url: finalRecord.docUrl,
                        amount: total,
                        refundTxnId: refundTxnId ?? null,
                        issuedAt
                    }
                },
                $set: { 'invoice.creditError': null }
            }
        )
    } catch { }

    if (refundTxnId) {
        try {
            await DL.PaymentTransaction.Model.updateOne(
                { orderId: order.id, providerTxnId: String(refundTxnId) },
                { $set: { creditInvoiceId: finalRecord.id, creditDocNumber: finalRecord.docNumber } }
            )
        } catch { }
    }

    await recordEvent({
        DL, utils, order, actor,
        eventType: DL?.Timeline?.constants?.EVENT_TYPES?.CREDIT_ISSUED,
        context: {
            step: 'credit_issued', invoiceId: finalRecord.id,
            linkedInvoiceId: invoice.id, linkedDocNumber: invoice.docNumber,
            docNumber: finalRecord.docNumber, amount: total,
            refundTxnId: refundTxnId || null
        },
        outcome: { success: true },
        source
    })

    return finalRecord
}

/**
 * Admin retry: re-run the provider call for an existing Invoice record.
 */
export async function retryInvoice({ DL, external, utils, order, record, actor, source = 'payment/invoice/issue' }) {
    if (!record) return null
    if (record.kind === 'credit') {
        return issueCreditNote({
            DL, external, utils, order,
            amount: record.amount,
            refundTxnId: record.refundTxnId,
            refundItems: record.items?.map(i => ({
                productId: i.productId, barcode: i.barcode, name: i.name, amount: i.gross
            })) || [],
            source, actor, force: true
        })
    }
    return issueInvoice({
        DL, external, utils, order,
        captured: record.amount,
        source, actor, force: true
    })
}

export { invoiceTotal }
