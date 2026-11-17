import { round2 } from '../calcOrder/utils.js'

// Money tolerance for the document ↔ charge reconciliation (half an agora).
export const INVOICE_EPS = 0.005

/**
 * Order-level coupon total. Mirrors pick_complete: `finalSum = sum - coupons`,
 * so the invoice must spend exactly this discount across the served lines.
 */
export function couponTotalOf(coupons = []) {
    return round2((coupons || []).reduce((acc, c) => acc + (Number(c?.discount) || 0), 0))
}

/**
 * A line belongs on the tax invoice only if it was actually supplied and
 * charged. Missing lines and replaced originals were never charged
 * (pick_complete zeroes them and excludes them from `sum`), so they must not
 * appear — not as a zero row and not as a discount.
 */
export function isInvoiceLine(line) {
    if (!line) return false
    if (line.missing) return false
    if (line.replacedBy) return false
    const quantity = Number(line.finalAmount ?? line.amount ?? 0)
    const gross = Number(line.totalSum ?? 0)
    return quantity > 0 && gross > 0
}

export function collectInvoiceItems(cart = []) {
    return (cart || [])
        .filter(isInvoiceLine)
        .map(line => ({
            productId: line.id,
            barcode: line.barcode,
            name: line.name,
            quantity: Number(line.finalAmount ?? line.amount ?? 0),
            gross: round2(Number(line.totalSum) || 0),
            // undefined (legacy snapshot) is taxable, matching product.vat default
            vat: line.vat !== false,
            unit: line.unit ? { type: line.unit.type, baseUnit: line.unit.baseUnit } : undefined
        }))
}

/**
 * Spread the coupon over the included lines proportionally to their gross.
 *
 * The discount is kept as its own per-line amount (`discount`) instead of being
 * baked into the unit price. The invoice then shows the price the customer
 * actually saw on the shelf plus an explicit line discount, while
 * `netGross` (= gross - discount) is what was charged for the line.
 *
 * Rounding is applied per line; the largest line absorbs the leftover agorot so
 * the discounts sum to the coupon exactly and no small line can go negative.
 */
export function allocateCoupon({ items = [], couponTotal = 0 } = {}) {
    const total = round2(items.reduce((acc, item) => acc + item.gross, 0))
    const coupon = round2(Math.min(Math.max(Number(couponTotal) || 0, 0), total))

    if (!(coupon > 0) || !(total > 0))
        return items.map(item => ({
            ...item,
            discount: 0,
            gross: round2(item.gross),
            netGross: round2(item.gross)
        }))

    let largest = 0
    for (let i = 1; i < items.length; i++)
        if (items[i].gross > items[largest].gross) largest = i

    const discounts = items.map(item => round2(coupon * item.gross / total))
    const drift = round2(coupon - discounts.reduce((acc, d) => acc + d, 0))
    if (drift !== 0) {
        const target = items[largest].gross
        discounts[largest] = round2(Math.min(Math.max(discounts[largest] + drift, 0), target))
    }

    return items.map((item, i) => {
        const gross = round2(item.gross)
        return {
            ...item,
            discount: discounts[i],
            gross,
            netGross: round2(gross - discounts[i])
        }
    })
}

/**
 * Shipping is a taxable service line, always separate from the goods and never
 * discounted by the coupon (shipping is computed on the pre-coupon sum).
 */
export function buildShippingLine(shipping = 0, { name = 'משלוח' } = {}) {
    const amount = round2(Number(shipping) || 0)
    if (!(amount > 0)) return null
    return { productId: '__shipping', barcode: null, name, quantity: 1, gross: amount, price: amount, vat: true, discount: 0 }
}

/**
 * Compute the displayed unit price for a line.
 *
 * The price is derived from the pre-coupon gross (the shelf price the customer
 * saw), never from the discounted amount. If rounding to 2 decimals would make
 * quantity * price overshoot the line gross, we floor to 2 decimals so that
 * quantity * price <= gross. Any shortfall is expressed as a larger per-line
 * discount and/or the rounding line, so the document total never exceeds the
 * charged amount.
 */
export function computeUnitPrice(gross, quantity) {
    const q = Number(quantity) || 0
    const g = round2(Number(gross) || 0)
    if (!(q > 0)) return g
    const raw = g / q
    const rounded = round2(raw)
    if (round2(q * rounded) > g) {
        return round2(Math.floor((raw + 1e-9) * 100) / 100)
    }
    return rounded
}

/**
 * Rounding adjustment line. Appended when line-level (quantity * price)
 * rounding produces a residual difference against the captured total.
 */
export function buildRoundingLine(drift = 0, { name = 'הפרשי עיגול' } = {}) {
    const amount = round2(Number(drift) || 0)
    if (!(amount > 0)) return null
    return {
        productId: '__rounding',
        barcode: null,
        name,
        quantity: 1,
        gross: amount,
        price: amount,
        vat: true,
        discount: 0
    }
}

/**
 * The invoice body: served lines after coupon + shipping + rounding reconciliation.
 * `order.finalShipping` is written by captureOrder and is the amount charged.
 *
 * Coupon presentation:
 *  - All invoiced lines taxable → one document-level discount (`documentDiscount`),
 *    and the item rows keep their shelf prices untouched. EZcount's document
 *    discount is applied to the taxable side, which is exactly right here.
 *  - Mixed / fully exempt basket → per-line `discount` (EZcount `discount_price`).
 *    A document-level discount would push the whole coupon onto the taxable
 *    side (mixed) or compute negative VAT (all-exempt), so it must be avoided.
 *
 * Each item also keeps `netGross` (= gross - coupon share), which is what was
 * actually charged for the line.
 */
export function buildInvoiceLines({ order, settings = {} } = {}) {
    const coupon = couponTotalOf(order?.coupons)
    const rawItems = allocateCoupon({
        items: collectInvoiceItems(order?.cart),
        couponTotal: coupon
    })
    // EZcount applies a document-level discount to the taxable side only, so
    // this presentation is safe only when every invoiced line is taxable.
    const allTaxable = rawItems.length > 0 && rawItems.every(item => item.vat !== false)
    const grossTotal = round2(rawItems.reduce((acc, item) => acc + item.gross, 0))
    const documentDiscount = allTaxable ? round2(Math.min(coupon, grossTotal)) : 0

    const items = rawItems.map(item => {
        const price = computeUnitPrice(item.gross, item.quantity)
        const quantity = Number(item.quantity) || 0
        const lineTotal = round2(quantity * price)
        // Discount is capped at the line total so a row can never go negative.
        // A floor-priced row can land below netGross; that residual is picked
        // up by the rounding line instead of turning into a negative discount.
        const discount = documentDiscount > 0
            ? 0
            : round2(Math.min(Math.max(lineTotal - item.netGross, 0), lineTotal))
        return { ...item, price, discount }
    })
    const shipping = round2(Number(order?.finalShipping ?? order?.shipping ?? 0) || 0)
    const shippingLine = buildShippingLine(shipping, { name: settings.shippingLabel })

    const lineTotalOf = item => round2(round2(Number(item.quantity) * Number(item.price)) - round2(Number(item.discount) || 0))
    const invoicedItemsGross = round2(items.reduce((acc, item) => acc + lineTotalOf(item), 0))
    const shippingTotal = shippingLine ? lineTotalOf(shippingLine) : 0
    const totalWithoutRounding = round2(invoicedItemsGross + shippingTotal - documentDiscount)
    const targetTotal = round2(rawItems.reduce((acc, item) => acc + item.netGross, 0) + shipping)
    const drift = round2(targetTotal - totalWithoutRounding)
    const roundingLine = buildRoundingLine(drift, { name: settings.roundingLabel })

    const total = round2(totalWithoutRounding + (roundingLine?.gross || 0))
    return { items, shippingLine, roundingLine, shipping, total, drift, coupon, documentDiscount }
}

export function invoiceTotal({ items = [], shippingLine, roundingLine, documentDiscount = 0 } = {}) {
    const lineTotal = (line) => {
        const q = Number(line.quantity ?? 1)
        const p = line.price != null ? Number(line.price) : round2(Number(line.gross) / q)
        return round2(round2(q * p) - (Number(line.discount) || 0))
    }
    const itemsSum = round2(items.reduce((acc, item) => acc + lineTotal(item), 0))
    const ship = shippingLine ? lineTotal(shippingLine) : 0
    const round = roundingLine ? lineTotal(roundingLine) : 0
    return round2(itemsSum + ship + round - (Number(documentDiscount) || 0))
}

/**
 * Credit-note rows. The refund engine works with amounts only
 * (`{ productId, barcode, name, amount }`), so the VAT class is looked up from
 * the order line snapshot; shipping is always taxable.
 */
export function buildCreditLines({ refundItems = [], cart = [] } = {}) {
    const byId = new Map()
    const byBarcode = new Map()
    for (const line of cart || []) {
        if (!line) continue
        if (line.id != null) byId.set(String(line.id), line)
        if (line.barcode != null) byBarcode.set(String(line.barcode), line)
    }

    return (refundItems || [])
        .filter(item => item && Number(item.amount) > 0)
        .map(item => {
            const shipping = item.productId === '__shipping'
            const general = item.productId === '__general'
            // Pseudo items (shipping / general refund) have no cart line.
            const line = (shipping || general)
                ? null
                : (byId.get(String(item.productId)) || byBarcode.get(String(item.productId)) || byBarcode.get(String(item.barcode)))
            const amount = round2(Number(item.amount))
            return {
                productId: item.productId,
                barcode: item.barcode ?? line?.barcode,
                name: shipping
                    ? (item.name || 'משלוח')
                    : general
                        ? 'החזר כללי'
                        : (item.name || line?.name || 'פריט'),
                quantity: 1,
                gross: amount,
                price: amount,
                vat: (shipping || general) ? true : (typeof item.vat === 'boolean' ? item.vat : line?.vat !== false),
                unit: line?.unit ? { type: line.unit.type, baseUnit: line.unit.baseUnit } : undefined
            }
        })
}

/**
 * The document total must equal the captured amount. This is the only hard
 * assertion in the flow: a mismatch means the wrong rows would be invoiced.
 */
export function assertTotalsMatch({ items = [], shippingLine, roundingLine, documentDiscount = 0, captured } = {}) {
    const total = invoiceTotal({ items, shippingLine, roundingLine, documentDiscount })
    const charged = round2(Number(captured) || 0)
    if (Math.abs(total - charged) > INVOICE_EPS) {
        const error = new Error(`invoice total ${total} does not match captured ${charged}`)
        error.code = 'INVOICE_TOTALS_MISMATCH'
        error.total = total
        error.captured = charged
        throw error
    }
    return total
}
