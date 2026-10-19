import { parseXml, normalizeArray } from './parser.js'

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
 * Fetch a delivery document back from Comax (per-line prices).
 * Query by DocNumber (+CustomerID, FromDate DD/MM/YYYY).
 * Returns null when the doc is not visible yet (retryable);
 * throws on transport / Comax errors.
 */
export async function getDeliveryDocument({ DL, customerId, docNumber, fromDate, timeoutMs = 60000 }) {
    if (!docNumber) throw new Error('docNumber required')
    const xml = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
        '<soap:Body>',
        '<Get_DeliveryDocument_All xmlns="http://ws.comax.co.il/Comax_WebServices/">',
        '<Param>',
        `<CustomerID>${esc(customerId || '')}</CustomerID>`,
        `<FromDate>${esc(fromDate || '')}</FromDate>`,
        '<ToDate></ToDate>',
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

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const log = DL.Log.start({
        action: 'comax_get_delivery_document',
        direction: DL.Log.constants.DIRECTION.OUT,
        data: { request: { docNumber: str(docNumber), customerId: str(customerId), fromDate: str(fromDate), transport: 'soap-post' } }
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
        const rawBody = await response.text().catch(() => '')
        if (!response.ok) {
            const fault = rawBody.replace(/\s+/g, ' ').trim().slice(0, 800)
            throw new Error(`Comax HTTP ${response.status}: ${response.statusText}${fault ? ` — ${fault}` : ''}`)
        }
        const rows = extractDeliveryDetails(parseXml(rawBody))
        if (!rows.length) {
            await log.success({ docNumber: str(docNumber), lines: 0, pending: true }).catch(() => {})
            return null
        }
        const errMsg = str(rows[0]?.ErrorMessage)
        if (errMsg) throw new Error(`Comax delivery fetch failed: ${errMsg}`)
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
    } catch (e) {
        await log.error({ docNumber: str(docNumber), message: e?.message || String(e) }).catch(() => {})
        throw e
    } finally {
        clearTimeout(timer)
    }
}

export default { getDeliveryDocument, mapDeliveryLine, extractDeliveryDetails }
