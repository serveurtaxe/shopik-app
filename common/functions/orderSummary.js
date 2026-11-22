import { round2, round3 } from './calcOrder/utils.js'
import { groupCart } from './cartReplacements.js'

// The order screen shows money that was already decided when the order was
// placed and picked. Everything here is derived from the order document alone:
// each cart line carries the price split the server calculated for it
// (priceDistribution), so the sale a line got is on the line itself and no
// catalog lookup is needed — the sale may well be gone from the catalog by now.
//
// The rows are built to reconcile: products before sales − sale savings =
// products after sales − coupons = after discounts + shipping = charged.

const EPS = 0.005

function num(value, fallback = 0) {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
}

function formatMoney(value) {
    const n = round2(value)
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.00$/, '')
}

// The short label of a sale as the line recorded it. A bundle ("4 ב-11") reads
// better than the catalog's long sale name, and both come from the line: the
// price split kept the sale kind, size and price at the time of the order, so
// nothing is looked up in the catalog. The bundle price is reconstructed from
// the group's own money, which also absorbs the agorot split across its legs.
function saleLabel(sale, unitPrice) {
    const kind = sale.saleKind
    const size = Math.max(1, num(sale.saleAmount))
    const perUnit = sale.amount > 0 ? sale.totalSum / sale.amount : NaN

    if ((kind === 'price' || kind === 'amount') && size > 1 && Number.isFinite(perUnit)) {
        return `${size} ב-${formatMoney(perUnit * size)}`
    }

    if (kind === 'percent' && Number.isFinite(unitPrice) && unitPrice > 0 && Number.isFinite(perUnit)) {
        const percent = Math.round((1 - perUnit / unitPrice) * 100)
        if (percent > 0) return `${percent}% הנחה`
    }

    return String(sale.saleName || '').trim()
}

// finalAmount and the missing flags are only meaningful once the picker
// finished; before that the cart is still the customer's checkout.
export function isOrderFinalized(order = {}) {
    return !['cart', 'paid', 'picking'].includes(order.status)
}

// A line that was not supplied was never charged, even if its checkout
// totalSum still sits on the document (missing/replaced originals keep it).
export function isLineNotSupplied(line) {
    return Boolean(line) && Boolean(line.missing || line.replacedBy || line.missingReason === 'replaced')
}

/**
 * What one cart line costs and what its sale saved.
 *
 * units is what was actually supplied: finalAmount once picking is finished,
 * the summed priceDistribution amounts when it was recalculated, and amount
 * before the order was picked. charged is the money the line contributed to
 * the order. While picking is still open (`finalized: false`) the checkout
 * amounts are kept: finalAmount fills in line by line, so the order total must
 * not follow a half-picked cart.
 */
export function getLineSummary(line, { finalized = true } = {}) {
    if (!line) return null

    const distributions = Array.isArray(line.priceDistribution) ? line.priceDistribution.filter(Boolean) : []
    const unitPrice = num(line.price, NaN)
    const hasPrice = Number.isFinite(unitPrice)
    const ordered = Math.max(0, num(line.amount))
    const notSupplied = finalized ? isLineNotSupplied(line) : false
    // An admin-added replacement line has no pricing until pick_complete runs,
    // so it is not part of the order total yet.
    const priced = distributions.length > 0
        || (line.totalSum != null && Number.isFinite(Number(line.totalSum)))

    const distAmount = round3(distributions.reduce((sum, d) => sum + num(d.amount), 0))
    const distTotal = round2(distributions.reduce((sum, d) => sum + num(d.totalSum), 0))

    let units = 0
    if (!notSupplied) {
        if (!finalized) units = distAmount > 0 ? distAmount : ordered
        else if (line.finalAmount != null) units = Math.max(0, num(line.finalAmount))
        else if (distAmount > 0) units = distAmount
        else units = ordered
    }
    units = round3(units)

    const regular = hasPrice && priced ? round2(unitPrice * units) : 0

    let charged = 0
    if (units > 0 && priced) {
        charged = distributions.length ? distTotal : round2(num(line.totalSum))
    }

    const saved = round2(Math.max(0, regular - charged))
    const chargePerUnit = units > 0 ? round2(charged / units) : 0

    // The sale names live on the line's own price split. They are grouped by
    // sale id so a bundle split over several legs ("4 ב-11" plus the agorot
    // leg) reads once, with the money of all its legs.
    const salesById = new Map()
    for (const dist of distributions) {
        if (dist?.type !== 'sale') continue
        const amount = num(dist.amount)
        if (!(amount > 0)) continue
        const key = dist.saleId || String(dist.saleName || '').trim() || 'sale'
        const entry = salesById.get(key) || {
            amount: 0,
            totalSum: 0,
            saved: 0,
            saleKind: dist.saleKind,
            saleAmount: num(dist.saleAmount),
            saleName: String(dist.saleName || '').trim()
        }
        entry.amount = round3(entry.amount + amount)
        entry.totalSum = round2(entry.totalSum + num(dist.totalSum))
        const salePrice = num(dist.salePrice, NaN)
        if (hasPrice && Number.isFinite(salePrice)) {
            entry.saved = round2(entry.saved + Math.max(0, unitPrice - salePrice) * amount)
        }
        salesById.set(key, entry)
    }
    const sales = [...salesById.values()].map(sale => ({
        name: saleLabel(sale, unitPrice),
        amount: sale.amount,
        saved: sale.saved,
        // What one unit cost under the sale — the price the site shows large
        // next to the struck-through regular one.
        perUnit: sale.amount > 0 ? round2(sale.totalSum / sale.amount) : 0
    }))
    if (!sales.length && saved > EPS) sales.push({ name: '', amount: units, saved, perUnit: chargePerUnit })

    return {
        line,
        priced,
        supplied: !notSupplied && units > 0,
        notSupplied,
        units,
        ordered,
        unitPrice: hasPrice ? unitPrice : 0,
        regular,
        charged,
        saved,
        sales
    }
}

/**
 * The whole money side of an order, from the stored order only.
 *
 * `itemsCount` groups a replacement pair as one product, exactly like the
 * products list, so the two numbers on the screen can never disagree.
 */
export function getOrderSummary(order = {}) {
    const cart = Array.isArray(order.cart) ? order.cart.filter(Boolean) : []
    const entries = groupCart(cart)
    const finalized = isOrderFinalized(order)
    const lines = cart.map(line => getLineSummary(line, { finalized })).filter(Boolean)
    const suppliedLines = lines.filter(l => l.supplied)

    const linesRegular = round2(suppliedLines.reduce((sum, l) => sum + l.regular, 0))
    const linesCharged = round2(suppliedLines.reduce((sum, l) => sum + l.charged, 0))

    const storedSum = num(order.sum, NaN)
    const productsAfterSales = suppliedLines.length
        ? linesCharged
        : (Number.isFinite(storedSum) ? round2(storedSum) : 0)

    // Pre-sale money comes from the line prices, not from sumNoCoupon: the
    // checkout field is not refreshed when picking changes the cart (a missing
    // line used to make it lower than the post-sale sum).
    let productsBeforeSales = suppliedLines.length
        ? linesRegular
        : round2(num(order.sumNoCoupon, productsAfterSales))
    if (productsBeforeSales < productsAfterSales) productsBeforeSales = productsAfterSales
    const saleSavings = round2(productsBeforeSales - productsAfterSales)

    const coupons = (Array.isArray(order.coupons) ? order.coupons : [])
        .map(coupon => ({
            code: coupon?.code || '',
            amount: round2(num(coupon?.appliedDiscount ?? coupon?.discount))
        }))
        .filter(coupon => coupon.amount > EPS)
    const couponTotal = round2(coupons.reduce((sum, coupon) => sum + coupon.amount, 0))

    const afterDiscounts = coupons.length
        ? Math.max(0, round2(productsAfterSales - couponTotal))
        : productsAfterSales

    const shipping = round2(num(order.finalShipping ?? order.shipping))
    const storedCharged = num(order.finalSumWithShipping, NaN)
    const derivedCharged = round2(afterDiscounts + shipping)
    // Derive so the rows always add up; a stored total is only a fallback for
    // an order with no cart money left to derive it from.
    const charged = (afterDiscounts > 0 || shipping > 0 || !Number.isFinite(storedCharged))
        ? derivedCharged
        : round2(storedCharged)

    const refundedTotal = round2(num(order.refundedTotal))
    const refundPending = round2(num(order.refundPending))
    const netAfterRefunds = Math.max(0, round2(charged - refundedTotal))

    return {
        itemsCount: entries.length,
        cartLines: cart.length,
        productsBeforeSales,
        saleSavings,
        productsAfterSales,
        coupons,
        couponTotal,
        afterDiscounts,
        shipping,
        charged,
        refundedTotal,
        netAfterRefunds,
        refundPending,
        hasSales: saleSavings > EPS,
        hasCoupons: coupons.length > 0 && couponTotal > EPS,
        hasRefunds: refundedTotal > EPS
    }
}
