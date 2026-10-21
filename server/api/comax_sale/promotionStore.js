export function resolvePromotionStoreCodes() {
    const raw = (process.env.COMAX_PROMOTION_STORE_ID || '').trim()
    const storeCodes = raw.split(',').map(code => code.trim()).filter(Boolean)
    if (storeCodes.length === 0) {
        throw new Error('Sales import aborted: COMAX_PROMOTION_STORE_ID is not set')
    }
    return storeCodes.join(',')
}

export function buildOtherStoreFilter(storeCodes) {
    return {
        swAllBranches: { $ne: true },
        'stores.Kod': { $nin: storeCodes }
    }
}

export function matchesPromotionStore(promo, storeCodes) {
    if (promo?.swAllBranches === true) return true
    return (promo?.stores || []).some(store => {
        const kod = store?.Kod
        return kod != null && storeCodes.includes(String(kod))
    })
}
