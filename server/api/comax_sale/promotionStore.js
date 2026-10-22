/**
 * The store codes the promotions are filtered by.
 *
 * A canonical comma separated string ('711,712') — the format the Comax API
 * expects for StoreList.
 */
export function resolvePromotionStoreCodes() {
    const raw = (process.env.COMAX_PROMOTION_STORE_ID || '').trim()
    const storeCodes = raw.split(',').map(code => code.trim()).filter(Boolean)
    if (storeCodes.length === 0) {
        throw new Error('Sales import aborted: COMAX_PROMOTION_STORE_ID is not set')
    }
    return storeCodes.join(',')
}

/**
 * The codes as a list. Accepts the comma separated string or an array.
 *
 * Mongo's $nin needs an array, and the store match has to be exact — a
 * substring check against '711,712' would also match '71'.
 */
export function toStoreCodeList(storeCodes) {
    if (Array.isArray(storeCodes))
        return storeCodes.map(code => String(code).trim()).filter(Boolean)
    return String(storeCodes || '').split(',').map(code => code.trim()).filter(Boolean)
}

export function buildOtherStoreFilter(storeCodes) {
    return {
        swAllBranches: { $ne: true },
        'stores.Kod': { $nin: toStoreCodeList(storeCodes) }
    }
}

export function matchesPromotionStore(promo, storeCodes) {
    if (promo?.swAllBranches === true) return true
    const codes = toStoreCodeList(storeCodes)
    return (promo?.stores || []).some(store => {
        const kod = store?.Kod
        return kod != null && codes.includes(String(kod))
    })
}
