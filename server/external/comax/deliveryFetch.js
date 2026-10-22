import { parseXml, normalizeArray } from './parser.js'
import { parseComaxDateTime } from './utils.js'

const DELIVERY_URL = 'https://ws.comax.co.il/Comax_WebServices/DeliveryDocuments.asmx'
const SOAP_ACTION = '"http://ws.comax.co.il/Comax_WebServices/Get_DeliveryDocument_All"'

function esc(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

/**
 * Pull the GetDos_DetailsOut row list (one per doc line) out of a parsed
 * Get_DeliveryDocument_All SOAP response.
 */
export function extractDeliveryDetails(parsed) {
    const env = parsed?.['soap:Envelope']?.['soap:Body'] ?? parsed
    const result = env?.Get_DeliveryDocument_AllResponse?.Get_DeliveryDocument_AllResult
        ?? parsed?.Get_DeliveryDocument_AllResponse?.Get_DeliveryDocument_AllResult
        ?? env?.Get_DeliveryDocument_AllResult
    return normalizeArray(result?.GetDos_DetailsOut)
}

function num(v) {
    if (v == null || v === '') return 0
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
}

function str(v) {
    return v == null ? '' : String(v)
}

/**
 * Map one GetDos_DetailsOut entry (one doc LINE — the doc header repeats
 * on every line) to a clean line object.
 */
export function mapDeliveryLine(raw) {
    return {
        itemId: str(raw?.ItemID),
        itemName: str(raw?.ItemNm),
        // Cmt = ordered qty. ItemConvertionQty is the unit-conversion factor (0 here).
        // (Comax's Line is always 0 — intentionally not stored.)
        qty: num(raw?.Cmt),
        price: num(raw?.Price),
        priceWithVat: num(raw?.PriceWithVat),
        discount: num(raw?.Discount),
        sum: num(raw?.Scm),
        sumWithVat: num(raw?.ScmWithVat)
    }
}

/**
 * Get_DeliveryDocument_All request.
 *
 * Comax filters by CUSTOMER + date range; DocNumber is optional (empty = every
 * doc of the customer in the range). FromDate is a LOWER bound on the DOC date
 * (a doc from 14/10 is invisible with FromDate=today).
 * NumDaysUpdated/NumDaysCreated are left empty on purpose: NumDaysCreated
 * drops the customer filter and returns the whole company (~100MB).
 */
function buildGetDeliveryDocumentXml({ customerId = '', fromDate = '', toDate = '', docNumber = '' }) {
    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
        '<soap:Body>',
        '<Get_DeliveryDocument_All xmlns="http://ws.comax.co.il/Comax_WebServices/">',
        '<Param>',
        `<CustomerID>${esc(customerId)}</CustomerID>`,
        `<FromDate>${esc(fromDate)}</FromDate>`,
        `<ToDate>${esc(toDate)}</ToDate>`,
        `<DocNumber>${esc(docNumber)}</DocNumber>`,
        '<NumDaysUpdated></NumDaysUpdated>',
        '<NumDaysCreated></NumDaysCreated>',
        '</Param>',
        `<LoginID>${esc(process.env.COMAX_LOGIN_ID)}</LoginID>`,
        `<LoginPassword>${esc(process.env.COMAX_LOGIN_PASSWORD)}</LoginPassword>`,
        '</Get_DeliveryDocument_All>',
        '</soap:Body>',
        '</soap:Envelope>'
    ].join('')
}

/**
 * SOAP round-trip for Get_DeliveryDocument_All.
 * Returns the raw row list; the caller logs the outcome.
 * Transport/Comax errors are logged and rethrown.
 */
async function fetchDeliveryRows({
    DL, customerId, fromDate = '', toDate = '', docNumber = '',
    timeoutMs = 60000, action = 'comax_get_delivery_document'
}) {
    const xml = buildGetDeliveryDocumentXml({ customerId, fromDate, toDate, docNumber })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const log = DL.Log.start({
        action,
        direction: DL.Log.constants.DIRECTION.OUT,
        data: { request: { docNumber: str(docNumber), customerId: str(customerId), fromDate: str(fromDate), toDate: str(toDate), transport: 'soap-post' } }
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
        return { rows: extractDeliveryDetails(parseXml(rawBody)), log }
    } catch (e) {
        await log.error({ docNumber: str(docNumber), message: e?.message || String(e) }).catch(() => {})
        throw e
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Fetch a delivery document back from Comax (per-line prices).
 * Query by DocNumber (+CustomerID, FromDate DD/MM/YYYY).
 * Returns null when the doc is not visible yet (retryable);
 * throws on transport / Comax errors.
 */
export async function getDeliveryDocument({ DL, customerId, docNumber, fromDate, timeoutMs = 60000 }) {
    if (!docNumber) throw new Error('docNumber required')
    const { rows, log } = await fetchDeliveryRows({ DL, customerId, fromDate, docNumber, timeoutMs })
    if (!rows.length) {
        await log.success({ docNumber: str(docNumber), lines: 0, pending: true }).catch(() => {})
        return null
    }
    const errMsg = str(rows[0]?.ErrorMessage)
    if (errMsg) {
        await log.error({ docNumber: str(docNumber), message: `Comax delivery fetch failed: ${errMsg}` }).catch(() => {})
        throw new Error(`Comax delivery fetch failed: ${errMsg}`)
    }
    const lines = rows.map(mapDeliveryLine).filter(l => l.itemId)
    if (!lines.length) {
        await log.success({ docNumber: str(docNumber), lines: 0, pending: true }).catch(() => {})
        return null
    }
    const head = rows[0]
    const out = {
        docNumber: str(head?.DocNumber ?? docNumber),
        reference: str(head?.Reference),
        dateDoc: str(head?.DateDoc),
        customerId: str(head?.CustomerID ?? customerId),
        storeId: head?.StoreID != null ? str(head.StoreID) : '',
        totals: {
            total: num(head?.TotalScm),
            totalBeforeVat: num(head?.TotalScmBeforeVat)
        },
        lines
    }
    await log.success({ docNumber: out.docNumber, lines: lines.length, total: out.totals.total }).catch(() => {})
    return out
}

/**
 * Group GetDos_DetailsOut rows into the docs that carry `reference`.
 *
 * The doc header repeats on every line, so rows are grouped by DocNumber.
 * Pure — no network — so it can be unit-tested.
 */
export function groupDeliveryDocsByReference(rows, reference) {
    const ref = str(reference)
    const docs = new Map()
    for (const row of rows || []) {
        if (str(row?.Reference) !== ref) continue
        const docNumber = str(row?.DocNumber)
        if (!docNumber) continue
        let doc = docs.get(docNumber)
        if (!doc) {
            doc = {
                docNumber,
                reference: ref,
                storeId: str(row?.StoreID),
                customerId: str(row?.CustomerID),
                dateDoc: str(row?.DateDoc),
                totalSum: num(row?.TotalScm),
                lines: []
            }
            docs.set(docNumber, doc)
        }
        doc.lines.push({ itemId: str(row?.ItemID), qty: num(row?.Cmt) })
    }
    // Newest doc wins (Comax DateDoc is "DD/MM/YYYY HH:mm:ss").
    return [...docs.values()].sort((a, b) =>
        (parseComaxDateTime(a.dateDoc)?.getTime() || 0) - (parseComaxDateTime(b.dateDoc)?.getTime() || 0)
    )
}

/**
 * Find a delivery document by its Reference (= our order number).
 *
 * Comax has no Reference filter, so we pull the customer's docs for the date
 * window and keep the ones whose Reference matches. Returns null when the
 * customer has no such doc.
 */
export async function findDeliveryDocByReference({ DL, customerId, reference, fromDate, timeoutMs = 60000 }) {
    if (!reference) return null
    const { rows, log } = await fetchDeliveryRows({
        DL, customerId, fromDate, docNumber: '',
        timeoutMs,
        action: 'comax_find_delivery_doc_by_reference'
    })
    const docs = groupDeliveryDocsByReference(rows, reference)
    await log.success({ reference: str(reference), docs: docs.length }).catch(() => {})
    return docs.length ? docs[docs.length - 1] : null
}

/**
 * Does a fetched Comax doc belong to this order?
 *
 * The reference is the order number and the store must match. Lines are
 * compared per item (Comax may split one ordered item into several lines),
 * summing quantities. An item id that Comax returns as the barcode instead
 * of the comaxId we sent is resolved through `aliasByBarcode`.
 */
export function docMatchesOrder(doc, { reference, storeId, expectedLines = [], aliasByBarcode } = {}) {
    if (!doc) return false
    if (reference != null && str(doc.reference) !== str(reference)) return false
    if (storeId != null && str(storeId) !== '' && str(doc.storeId) !== str(storeId)) return false

    const aliases = aliasByBarcode instanceof Map ? aliasByBarcode : new Map(Object.entries(aliasByBarcode || {}))
    const canonical = id => aliases.get(id) || id

    const expectedQty = new Map()
    for (const line of expectedLines) {
        const id = str(line?.id)
        if (!id) continue
        expectedQty.set(id, (expectedQty.get(id) || 0) + num(line?.qty))
    }
    const docQty = new Map()
    for (const line of doc.lines || []) {
        const raw = str(line?.itemId)
        if (!raw) continue
        const id = canonical(raw)
        docQty.set(id, (docQty.get(id) || 0) + num(line?.qty))
    }
    if (expectedQty.size !== docQty.size) return false
    for (const [id, qty] of expectedQty) {
        const got = docQty.get(id)
        if (got == null) return false
        if (Math.abs(got - qty) > 0.001) return false
    }
    return true
}

export default { getDeliveryDocument, findDeliveryDocByReference, docMatchesOrder, groupDeliveryDocsByReference, mapDeliveryLine, extractDeliveryDetails }
