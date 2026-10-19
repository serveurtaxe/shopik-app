import { getDeliveryDocument } from './deliveryFetch.js'
import { formatComaxDate } from './utils.js'

export const MAX_ATTEMPTS = Number(process.env.COMAX_DELIVERY_FETCH_MAX_ATTEMPTS || 10)
const RETRY_MIN = Number(process.env.COMAX_DELIVERY_FETCH_RETRY_MIN || 5)

function backoffDelay(attempts) {
    // Linear backoff capped at 6h: 5m, 10m, 15m, …
    return Math.min(Math.max(1, attempts) * RETRY_MIN, 360) * 60 * 1000
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
    const fromDate = formatComaxDate(new Date())
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

export default { fetchAndStoreDeliveryDoc, MAX_ATTEMPTS }
