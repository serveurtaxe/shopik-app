import { getDeliveryDocument } from './deliveryFetch.js'
import { formatComaxDate, parseComaxDate } from './utils.js'

export const MAX_ATTEMPTS = Number(process.env.COMAX_DELIVERY_FETCH_MAX_ATTEMPTS || 10)
const RETRY_MIN = Number(process.env.COMAX_DELIVERY_FETCH_RETRY_MIN || 5)
// Comax filters FromDate as a LOWER bound on the DOC date: a doc created
// yesterday is invisible with FromDate=today. Look back a few days so a doc
// that Comax indexed late (or that was created before midnight) is still
// found and backfilled.
const LOOKBACK_DAYS = Number(process.env.COMAX_DELIVERY_FETCH_LOOKBACK_DAYS || 30)

function backoffDelay(attempts) {
    // Linear backoff capped at 6h: 5m, 10m, 15m, …
    return Math.min(Math.max(1, attempts) * RETRY_MIN, 360) * 60 * 1000
}

/**
 * FromDate for a fetch: the doc's own date minus a day when we know it,
 * otherwise today minus the lookback window.
 */
function fetchFromDate(doc) {
    const docDate = doc?.dateDoc ? parseComaxDate(String(doc.dateDoc).slice(0, 10)) : null
    if (docDate) return formatComaxDate(new Date(docDate.getTime() - 86400000))
    return formatComaxDate(new Date(Date.now() - LOOKBACK_DAYS * 86400000))
}

/**
 * Create (or refresh) the comax_delivery_docs row of a written doc.
 *
 * Idempotent: docNumber is unique, so a plain create throws on a retry and
 * would skip the inline price fetch. A row that is already fetched keeps its
 * status; anything else goes back to pending so the cron retries it.
 */
export async function ensureDeliveryDoc({ DL, order, docNumber, customerId = '', dateDoc = '', nextAttemptAt = new Date() }) {
    if (!docNumber) return null
    const data = {
        orderId: order.id,
        orderNumber: String(order.number || ''),
        storeId: order.storeId,
        docNumber: String(docNumber),
        customerId: String(customerId || ''),
        reference: String(order.number || ''),
        status: 'pending',
        attempts: 0,
        error: null,
        nextAttemptAt
    }
    if (dateDoc) data.dateDoc = String(dateDoc)
    const existing = await DL.ComaxDeliveryDoc.readOne({ docNumber: data.docNumber }).catch(() => null)
    if (existing) {
        const patch = { ...data }
        if (existing.status === 'fetched') {
            patch.status = 'fetched'
            patch.nextAttemptAt = null
            delete patch.attempts
        }
        await DL.ComaxDeliveryDoc.updateOne({ docNumber: data.docNumber }, patch).catch(() => {})
        return existing
    }
    try {
        return await DL.ComaxDeliveryDoc.create(data)
    } catch {
        return null
    }
}

/**
 * One fetch-and-store attempt for a comax_delivery_docs row.
 * Reads the row fresh, calls Get_DeliveryDocument_All, persists lines+totals.
 * Never throws — outcomes are recorded on the row (and order on success).
 * Returns 'fetched' | 'pending' | 'failed'.
 */
export async function fetchAndStoreDeliveryDoc({ DL, docNumber }) {
    if (!docNumber) throw new Error('docNumber required')
    const doc = await DL.ComaxDeliveryDoc.readOne({ docNumber: String(docNumber) }).catch(() => null)
    if (!doc) throw new Error(`delivery doc row not found: ${docNumber}`)
    if (doc.status === 'fetched') return 'fetched'

    const attempts = Number(doc.attempts || 0) + 1
    const fromDate = fetchFromDate(doc)
    try {
        const fetched = await getDeliveryDocument({
            DL,
            customerId: doc.customerId,
            docNumber: doc.docNumber,
            fromDate
        })
        if (!fetched) {
            // Not visible in Comax yet — retryable.
            const exhausted = attempts >= MAX_ATTEMPTS
            await DL.ComaxDeliveryDoc.updateOne({ docNumber: doc.docNumber }, {
                attempts,
                status: exhausted ? 'failed' : 'pending',
                nextAttemptAt: exhausted ? null : new Date(Date.now() + backoffDelay(attempts)),
                error: exhausted ? 'not visible in Comax after max attempts' : 'not visible in Comax yet'
            }).catch(() => {})
            return exhausted ? 'failed' : 'pending'
        }
        await DL.ComaxDeliveryDoc.updateOne({ docNumber: doc.docNumber }, {
            status: 'fetched',
            attempts,
            lines: fetched.lines,
            totals: fetched.totals,
            reference: fetched.reference || doc.reference,
            dateDoc: fetched.dateDoc || doc.dateDoc,
            fetchedAt: new Date(),
            nextAttemptAt: null,
            error: null
        }).catch(() => {})
        // Write totals back to the order for existing reports.
        if (doc.orderId) {
            await DL.Order.updateOne({ id: doc.orderId }, {
                'comaxDoc.totalSum': fetched.totals.total
            }).catch(() => {})
        }
        return 'fetched'
    } catch (e) {
        const exhausted = attempts >= MAX_ATTEMPTS
        await DL.ComaxDeliveryDoc.updateOne({ docNumber: doc.docNumber }, {
            attempts,
            status: exhausted ? 'failed' : 'pending',
            nextAttemptAt: exhausted ? null : new Date(Date.now() + backoffDelay(attempts)),
            error: e?.message || String(e)
        }).catch(() => {})
        return exhausted ? 'failed' : 'pending'
    }
}

export default { fetchAndStoreDeliveryDoc, ensureDeliveryDoc, MAX_ATTEMPTS }
