import { parseXml } from './parser.js'
import { buildDeliveryDocumentSoap } from './deliveryMapper.js'
import { resolveDeliveryConfig } from './resolveDeliveryConfig.js'
import { findDeliveryDocByReference, docMatchesOrder } from './deliveryFetch.js'
import { formatComaxDate } from './utils.js'

const DELIVERY_URL = 'https://ws.comax.co.il/Comax_WebServices/DeliveryDocuments.asmx'
const SOAP_ACTION = '"http://ws.comax.co.il/Comax_WebServices/Write_DeliveryDocument"'

// How far back to look for a doc that already carries our reference.
const LOOKBACK_DAYS = Number(process.env.COMAX_DELIVERY_LOOKBACK_DAYS || 30)
const DOUBLE_REFERENCE_RE = /double\s*reference/i

function extractResult(parsed) {
    const env = parsed?.['soap:Envelope']?.['soap:Body'] ?? parsed
    const resp = env?.Write_DeliveryDocumentResponse
        ?? parsed?.Write_DeliveryDocumentResponse
    const ok = resp?.Write_DeliveryDocumentResult
    const details = resp?.DocumentDetails ?? null
    return { ok, details }
}

function isTruthy(v) {
    return v === true || String(v).toLowerCase() === 'true' || String(v) === '1'
}

/**
 * Did Comax refuse the write because the reference is already taken?
 * (Comax's ErrorTypes enum: DoubleReference.)
 */
export function isDoubleReferenceError(details) {
    const message = [details?.ErrorMessage, details?.ErrorMessage_Details].filter(Boolean).join(' | ')
    return DOUBLE_REFERENCE_RE.test(message)
}

/**
 * "Double reference" means a doc with this reference already exists in Comax —
 * the write may have succeeded earlier with a lost response. Find that doc and
 * hand it back so the caller can continue with it.
 *
 * Only OUR customer's docs are searched (the reference alone is not unique in
 * the Comax company), and the doc must match the order: same reference, same
 * store and the same items we sent. Returns null when there is no such doc.
 */
async function adoptExistingDeliveryDoc({ DL, order, cfg, lines, idByBarcode }) {
    const reference = String(order?.number || '')
    if (!reference) return null
    // The doc can only be newer than the order; look from today first (the
    // common case: an earlier attempt minutes ago), then widen the window.
    const today = formatComaxDate(new Date())
    const earliest = new Date(Date.now() - LOOKBACK_DAYS * 86400000)
    const created = order?.createdAt ? new Date(order.createdAt) : null
    const lower = created && created > earliest ? new Date(created.getTime() - 86400000) : earliest
    const fromDates = [today]
    const wide = formatComaxDate(lower)
    if (wide !== today) fromDates.push(wide)

    for (const fromDate of fromDates) {
        try {
            const doc = await findDeliveryDocByReference({ DL, customerId: cfg.customerId, reference, fromDate })
            if (!doc) continue
            if (!docMatchesOrder(doc, {
                reference,
                storeId: cfg.comaxStoreId,
                expectedLines: lines,
                aliasByBarcode: idByBarcode
            })) return null
            return {
                docNumber: doc.docNumber,
                totalSum: doc.totalSum,
                linesCount: String(doc.lines.length),
                dateDoc: doc.dateDoc
            }
        } catch {
            // Never mask the original Comax error with a lookup failure.
        }
    }
    return null
}

/**
 * Create the Comax delivery document for a packed Shopik order.
 * Prices come from the Comax price list (PriceFromPriceList=true).
 * Fail-open: throws on error, caller decides.
 *
 * "Double reference" (the reference is already taken in Comax) is recovered
 * from: the existing doc is fetched and returned as if the write succeeded.
 *
 * Returns { docNumber, totalSum, linesCount } (+ dateDoc when adopted).
 */
export async function writeDeliveryDocument({ DL, order, timeoutMs = 60000, opts = {} }) {
    const cfg = await resolveDeliveryConfig(DL, order.storeId)
    if (!cfg.customerId) throw new Error('missing Comax CustomerID (cash_register.data.DeliveryCustomerID or COMAX_CUSTOMER_ID)')
    if (!cfg.comaxStoreId) throw new Error('missing Comax StoreID (cash_register.data.OrderStoreID)')
    if (!cfg.priceListId) throw new Error('missing Comax PriceListID (COMAX_DELIVERY_PRICELIST_ID or COMAX_PRICELIST_ID)')

    // Resolve Comax internal item IDs by barcode (falls back to barcode).
    let idByBarcode = new Map()
    try {
        const barcodes = [...new Set((order.cart || []).map(l => String(l?.barcode || '').trim()).filter(Boolean))]
        if (barcodes.length) {
            const rows = await DL.ComaxProduct.read(
                { barcode: { $in: barcodes } },
                { _id: 0, barcode: 1, comaxId: 1 },
                { limit: 0 }
            )
            idByBarcode = new Map((rows || [])
                .filter(r => r?.barcode && r?.comaxId)
                .map(r => [String(r.barcode), String(r.comaxId)]))
        }
    } catch {}

    const { xml, lines } = buildDeliveryDocumentSoap(order, {
        customerId: cfg.customerId,
        comaxStoreId: cfg.comaxStoreId,
        priceListId: cfg.priceListId,
        loginId: cfg.loginId,
        loginPassword: cfg.loginPassword,
        idByBarcode
    }, opts)
    if (!lines.length) throw new Error('no packable lines (all missing/zero qty)')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    // Full sent payload (password excluded) so the logs collection shows
    // exactly what Comax received. View: logs where action=comax_write_delivery_document.
    const log = DL.Log.start({
        action: 'comax_write_delivery_document',
        direction: DL.Log.constants.DIRECTION.OUT,
        data: {
            request: {
                orderId: order.id, orderNumber: order.number,
                customerId: cfg.customerId, storeId: cfg.comaxStoreId, priceListId: cfg.priceListId,
                mode: 'Add', reference: String(order.number || ''), priceFromPriceList: true,
                transport: 'soap-post', flatSiblings: Boolean(opts.flatSiblings),
                lines: lines.map(l => ({ id: l.id, qty: l.qty }))
            }
        }
    })
    try {
        log.actor({ type: DL.Log.constants.ACTOR.API })
        const response = await fetch(DELIVERY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                SOAPAction: SOAP_ACTION
            },
            body: xml,
            signal: controller.signal
        })
        // Capture fault bodies — otherwise all we keep is the bare HTTP status.
        const rawBody = await response.text().catch(() => '')
        if (!response.ok) {
            const fault = rawBody.replace(/\s+/g, ' ').trim().slice(0, 800)
            throw new Error(`Comax HTTP ${response.status}: ${response.statusText}${fault ? ` — ${fault}` : ''}`)
        }
        const { ok, details } = extractResult(parseXml(rawBody))
        const docNumber = details?.DocNumber != null ? String(details.DocNumber) : ''
        const errMsg = details?.ErrorMessage || details?.ErrorMessage_Details || ''
        if (!isTruthy(ok) || !docNumber || docNumber === '0') {
            if (isDoubleReferenceError(details)) {
                const adopted = await adoptExistingDeliveryDoc({ DL, order, cfg, lines, idByBarcode })
                if (adopted) {
                    await log.success({
                        orderId: order.id,
                        ...adopted,
                        adopted: 'double_reference',
                        comaxError: errMsg
                    }).catch(() => {})
                    return adopted
                }
            }
            throw new Error(`Comax delivery doc failed${errMsg ? `: ${errMsg}` : ': empty DocNumber'}`)
        }
        const out = {
            docNumber,
            totalSum: details?.TotalSum != null && details.TotalSum !== '' ? Number(details.TotalSum) : 0,
            linesCount: String(lines.length)
        }
        await log.success({ orderId: order.id, ...out }).catch(() => {})
        return out
    } catch (e) {
        await log.error({ orderId: order.id, message: e?.message || String(e) }).catch(() => {})
        throw e
    } finally {
        clearTimeout(timer)
    }
}

export default { writeDeliveryDocument }
