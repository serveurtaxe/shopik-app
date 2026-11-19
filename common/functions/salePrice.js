import { round2 } from './calcOrder/utils.js'
import { getSalesCache } from './salesCache.js'

// Sale pricing helpers shared by the storefront components and the server-side
// sitemap / Google Merchant feed. Pure (no React, no CSS) so the feed builder
// can import them.

export function getFirstSale(product, sales) {
    const saleId = product?.saleIds?.[0]
    if (!saleId) return null
    if (sales && sales[saleId]) return sales[saleId]
    try {
        const cache = getSalesCache?.()
        if (cache && cache[saleId]) return cache[saleId]
    } catch { }
    return null
}

export function getSalePriceInfo(product, sale) {
    if (!sale || !product) return null
    const regular = Number(product.price)
    if (isNaN(regular)) return null
    const amount = Number(sale.amount) || 1
    const kind = sale.kind
    const price = sale.price
    const percent = sale.percent
    let saleSingle = null
    let saleTotal = null
    if (kind === 'percent' && percent != null) {
        const p = Number(percent)
        saleSingle = round2(regular * (1 - p / 100))
        saleTotal = round2(saleSingle * amount)
    } else if (price != null) {
        const total = Number(price)
        saleTotal = round2(total)
        saleSingle = amount > 1 ? round2(total / amount) : saleTotal
    } else {
        return null
    }
    if (saleSingle < 0) saleSingle = 0
    if (saleTotal < 0) saleTotal = 0
    return { regular, saleSingle, saleTotal, amount, kind, isBundle: amount > 1 }
}

// A Google `sale_price` is the price of ONE unit. A quantity bundle ("3 ב-10")
// does not discount a single unit, so it has no valid feed representation.
export function isSingleUnitSale(sale) {
    return !!sale && (Number(sale.amount) || 1) <= 1
}

export default { getFirstSale, getSalePriceInfo, isSingleUnitSale }
