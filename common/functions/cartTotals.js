import { round2 } from './calcOrder/utils.js'

// Display-only fallback for carts restored from device storage without
// server-computed sums (guest with no guest cookie). Prefers the last-synced
// per-line sale snapshot (totalSum) so sale prices are honored offline.
// The server remains the source of truth once it responds.
export function fallbackLineTotal(item) {
    if (!item) return 0
    if (typeof item.totalSum === 'number' && !Number.isNaN(item.totalSum)) return item.totalSum
    if (typeof item.saleSum === 'number' || typeof item.regularSum === 'number')
        return round2((Number(item.saleSum) || 0) + (Number(item.regularSum) || 0))
    return round2((Number(item.price) || 0) * (Number(item.amount) || 0))
}

export function fallbackCartTotals(cart) {
    let sum = 0
    let sumNoCoupon = 0
    for (const item of cart || []) {
        sum = round2(sum + fallbackLineTotal(item))
        sumNoCoupon = round2(sumNoCoupon + round2((Number(item?.price) || 0) * (Number(item?.amount) || 0)))
    }
    return { sum, sumNoCoupon, savings: Math.max(0, round2(sumNoCoupon - sum)) }
}
