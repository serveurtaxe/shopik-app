import { round2 } from '../calcOrder/utils.js'
import { cleanText, describeInvoiceLine } from './format.js'

// EZcount document types (see the API docs; configurable in the Setting).
export const DOC_TYPE = {
    INVOICE: 320,   // חשבונית מס קבלה
    CREDIT: 330     // חשבונית זיכוי
}

// EZcount item VAT type: INC = VAT included / shown, NON = exempt.
export const VAT_TYPE = {
    TAXABLE: 'INC',
    EXEMPT: 'NON'
}

export function vatTypeOf(vat) {
    return vat === false ? VAT_TYPE.EXEMPT : VAT_TYPE.TAXABLE
}

/**
 * One EZcount item row.
 *
 * `amount` is the actual item quantity (e.g. 2, 3, 1.35) and `price` is the
 * pre-coupon unit price the customer saw. A coupon is sent as its own
 * negative-price row (see invoice lines), never baked into the unit price.
 *
 * Rounding drifts across lines are reconciled with a dedicated rounding line so
 * the sum of line totals matches the charged total exactly.
 */
export function buildInvoiceItem(line = {}) {
    const qty = Number(line.quantity ?? line.amount ?? 1)
    const unitPrice = line.price != null
        ? Number(line.price)
        : (qty > 0 ? round2(Number(line.gross) / qty) : Number(line.gross) || 0)
    return {
        details: describeInvoiceLine(line),
        amount: String(qty),
        price: round2(unitPrice).toFixed(2),
        vat_type: vatTypeOf(line.vat)
    }
}

export function lineTotalOf(item = {}) {
    return round2(Number(item.amount ?? 1) * Number(item.price || 0))
}

export function buildInvoiceItems(lines = []) {
    return (lines || [])
        // Keep negative coupon rows; drop only empty/skipped lines.
        .filter(line => line && Number(line.gross) !== 0)
        .map(buildInvoiceItem)
}

function customerName(customer = {}, order = {}) {
    if (typeof customer.fullName === 'string' && customer.fullName.trim())
        return cleanText(customer.fullName, 100)
    const fromParts = [customer.name?.first, customer.name?.last].filter(Boolean).join(' ')
    const plain = typeof customer.name === 'string' ? customer.name : ''
    return cleanText(fromParts || plain || order.name, 100)
}

/**
 * The EZcount `createDoc` body (credentials are added by the client).
 *
 * Only document fields are ever sent — never card or payment fields, so the
 * provider can never settle a charge.
 */
export function buildDocPayload({
    order = {},
    lines = [],
    docType = DOC_TYPE.INVOICE,
    customer = {},
    notes = '',
    settings = {},
    sendEmail = true,
    payment = null,
    parent,
    idTransaction
} = {}) {
    const email = cleanText(customer.email || order.email, 120)
    const items = buildInvoiceItems(lines)
    const payload = {
        type: docType,
        lang: settings.language || 'he',
        customer_name: customerName(customer, order),
        item: items
    }

    // Display-only flag: item prices already carry the exact charged gross
    // (vat_type INC), but EZcount prints them before VAT unless asked otherwise.
    // This only changes the printed price per row; net/VAT/total are untouched.
    // Must be the number 1 — EZcount ignores the string 'true' for this field.
    payload.show_items_including_vat = 1

    // 320 (invoice receipt) rejects the request without `price_total` and a
    // payment row. Item rows include the negative coupon row(s), so their sum
    // is the captured total — no recalculation, and it matches
    // assertTotalsMatch by construction. Credit notes (330) must not carry
    // either: price_total is positive-only and a credit is not a payment.
    if (docType === DOC_TYPE.INVOICE) {
        if (items.length)
            payload.price_total = round2(items.reduce((sum, item) => sum + lineTotalOf(item), 0))
        // EZcount recalculates `amount * price` per line with its own rounding,
        // so a line landing on an exact half-cent can disagree with ours by one
        // agora. auto_balance lets the provider absorb that cent as a discount
        // instead of rejecting the document.
        payload.auto_balance = 'true'
        if (Array.isArray(payment) && payment.length) payload.payment = payment
    }

    if (email) {
        payload.customer_email = email
        payload.dont_send_email = sendEmail ? 'false' : 'true'
    } else {
        // EZcount requires customer_email when sending; without one we create
        // the document and leave delivery to the account link.
        payload.dont_send_email = 'true'
    }

    const phone = cleanText(customer.phone || order.phone, 30)
    if (phone) payload.customer_phone = phone

    const taxId = cleanText(customer.taxId || order.invoiceRequest?.taxId, 20)
    if (taxId) payload.customer_crn = taxId

    const address = cleanText(customer.address, 60)
    if (address) payload.customer_address = address

    if (notes) payload.comment = notes
    // Credit notes link to the document they offset by its UUID (`parent`).
    if (parent) payload.parent = String(parent)
    if (idTransaction) payload.transaction_id = String(idTransaction)

    return payload
}

/**
 * One payment row for an invoice receipt (320).
 *
 * EZcount requires card fields (brand, last 4, deal type) for payment_type 3,
 * but our capture flow never stores them, so the supported default is 9
 * ("other") with a free-text name. Switching to 3 means persisting the card
 * metadata at capture time first.
 */
export function buildPaymentRow({ amount, settings = {}, date = new Date() } = {}) {
    const type = Number(settings.paymentType) || 9
    const day = String(date.getDate()).padStart(2, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const row = {
        payment_type: type,
        payment_sum: round2(Number(amount) || 0),
        date: `${day}/${month}/${date.getFullYear()}`
    }
    if (type === 9) row.other_payment_type_name = cleanText(settings.paymentName, 40) || 'כרטיס אשראי'
    return row
}
