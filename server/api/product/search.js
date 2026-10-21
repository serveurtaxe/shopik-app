import { withDomainPrice } from '#server/utils/data/withDomainPrice.js'
import { ADMIN_TOKEN_COOKIE } from '#common/constants.js'

export default async function search(payload, { DL, req, _user, _admin, utils, platform }) {
    const { value = '', filter = {}, skip = 0, limit = 20, domainId } = payload
    // Admin traffic keeps the full multi-domain `prices` array; the
    // storefront gets a resolved flat `price` only (see withDomainPrice).
    const isStorefront = !String(platform || '').includes('admin')
    const priceFor = (products) => (isStorefront && domainId ? withDomainPrice(products, domainId) : products)
    const safeSkip = Math.max(0, Number(skip) || 0)
    const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100)
    const { mode, storeId } = await utils.data.withStock.resolveStockContext(req, { DL, utils }, _user)
    const wantFilter = mode === 'filter' && !!storeId
    const wantAnnotate = mode === 'annotate' && !!storeId

    const effectiveFilter = wantFilter ? utils.data.withStock.applyStockFilter(filter, storeId, mode) : filter
    // Hidden products are replacement candidates for the admin picker flow only.
    // Public routes skip admin auth in the router, so resolve the admin session
    // here (token verified by getAdmin) when the admin cookie is present.
    let admin = _admin
    if (!admin && req?.cookies?.[ADMIN_TOKEN_COOKIE]) {
        try { admin = await utils.auth.getAdmin(req, { DL, utils }) } catch { }
    }
    const isAdminViewer = !!admin && !admin.isApiKey
    effectiveFilter.status = isAdminViewer
        ? { $in: [DL.Product.constants.STATUS.ACTIVE, DL.Product.constants.STATUS.HIDDEN] }
        : DL.Product.constants.STATUS.ACTIVE
    if (domainId)
        effectiveFilter['prices.domainId'] = domainId

    // Public endpoint: ignore client-supplied `select` (see get.js).
    const selectForStock = wantAnnotate ? { ...DL.Product.defaultSelect, storeIds: 1 } : DL.Product.defaultSelect

    // Barcode exact fast-path: numeric-only search bypasses Atlas entirely (barcode is no longer indexed)
    const trimmed = (value || '').trim()
    if (/^\d+$/.test(trimmed)) {
        const exactFilter = { ...effectiveFilter, barcode: trimmed }
        let products = await DL.Product.read(exactFilter, selectForStock, { limit: safeLimit, skip: safeSkip })
        if (wantAnnotate) products = utils.data.withStock.annotateInStock(products, storeId, mode)
        const sales = await collectSales(products)
        return { products: priceFor(products), sales }
    }

    let products = await DL.Product.search(value, effectiveFilter, { skip: safeSkip, limit: safeLimit, select: selectForStock })

    if (wantAnnotate) products = utils.data.withStock.annotateInStock(products, storeId, mode)

    const sales = await collectSales(products)
    return { products: priceFor(products), sales }

    async function collectSales(prods) {
        const saleIdSet = new Set()
        for (const p of prods || []) {
            if (p?.saleIds && Array.isArray(p.saleIds)) {
                for (const sid of p.saleIds) saleIdSet.add(sid)
            }
        }
        if (!saleIdSet.size) return {}
        const activeSales = await DL.Sale.read(
            { id: { $in: Array.from(saleIdSet) }, status: DL.Sale.constants.STATUS.ACTIVE },
            DL.Sale.defaultSelect,
            { limit: 0 }
        )
        const map = {}
        for (const s of activeSales) map[s.id] = s
        return map
    }
}

search.config = {
    auth: 'lax'
}
