import { parseXml } from './parser.js'
import { buildDeliveryDocumentSoap } from './deliveryMapper.js'
import { resolveDeliveryConfig } from './resolveDeliveryConfig.js'

const DELIVERY_URL = 'https://ws.comax.co.il/Comax_WebServices/DeliveryDocuments.asmx'
const SOAP_ACTION = '"http://ws.comax.co.il/Comax_WebServices/Write_DeliveryDocument"'

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
 * Create the Comax delivery document for a packed Shopik order.
 * Prices come from the Comax price list (PriceFromPriceList=true).
 * Fail-open: throws on error, caller decides.
 * Returns { docNumber, totalSum, linesCount }.
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
