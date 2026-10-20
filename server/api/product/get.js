import { withDomainPrice } from '#server/utils/data/withDomainPrice.js'
import { ADMIN_TOKEN_COOKIE } from '#common/constants.js'

export default async function get(payload, { DL, _user, _admin, req, utils, platform }) {
    const { filter = {}, path, id, barcode, select, onSale, domainId } = payload
    // Admin traffic keeps the full multi-domain `prices` array; the
    // storefront gets a resolved flat `price` only (see withDomainPrice).
    const isStorefront = !String(platform || '').includes('admin')
    const { mode, storeId } = await utils.data.withStock.resolveStockContext(req, { DL, utils }, _user)
    const wantFilter = mode === 'filter' && !!storeId
    const wantAnnotate = mode === 'annotate' && !!storeId
    // Storefront scoping: no price entry for the domain = not sold in that domain.
    // Admin callers send no domainId and stay unfiltered.
    const domainPriceFilter = domainId ? { 'prices.domainId': domainId } : {}
    const hasDomainPrice = (p) => !domainId || !Array.isArray(p?.prices) || p.prices.some(e => e?.domainId === domainId)
    // Hidden products are replacement candidates for the admin picker flow only.
    // Public routes skip admin auth in the router, so resolve the admin session
    // here (token verified by getAdmin) when the admin cookie is present.
    let admin = _admin
    if (!admin && req?.cookies?.[ADMIN_TOKEN_COOKIE]) {
        try { admin = await utils.auth.getAdmin(req, { DL, utils }) } catch { }
    }
    const isAdminViewer = !!admin && !admin.isApiKey
    const statusFilter = isAdminViewer
        ? { $in: [DL.Product.constants.STATUS.ACTIVE, DL.Product.constants.STATUS.HIDDEN] }
        : DL.Product.constants.STATUS.ACTIVE

    let products = []
    let categoryName
    let categoryPath

    if (barcode) {
        const sel = wantAnnotate ? { ...DL.Product.defaultSelectOne, storeIds: 1 } : DL.Product.defaultSelectOne
        const product = await DL.Product.readOne({
            barcode,
            status: statusFilter,
            ...domainPriceFilter
        }, sel)
        products = product && hasDomainPrice(product) ? [product] : []
        if (wantAnnotate) products = utils.data.withStock.annotateInStock(products, storeId, mode)
    } else if (id) {
        const sel = wantAnnotate ? { ...DL.Product.defaultSelectOne, storeIds: 1 } : DL.Product.defaultSelectOne
        const product = await DL.Product.readOne({
            id,
            status: statusFilter,
            ...domainPriceFilter
        }, sel)
        products = product && hasDomainPrice(product) ? [product] : []
        if (product?.category?.id) {
            const category = await DL.Category.readOne({ id: product.category.id }, { _id: 0, path: 1 })
            categoryPath = category?.path
        }
        if (wantAnnotate) products = utils.data.withStock.annotateInStock(products, storeId, mode)
    } else {
        if (path) {
            const pathParts = path.split('/').filter(p => p && p != 'products').map(p => decodeURIComponent(p))
            const category = await DL.Category.readOne({ path: pathParts.join('/') })
            if (category) {
                filter['category.pathIds'] = category.id
                categoryName = category.name
            }
        }
        const effectiveFilter = wantFilter ? utils.data.withStock.applyStockFilter(filter, storeId, mode) : filter
        // Public endpoint: ignore client-supplied `select` (arbitrary field
        // projection could expose picking/storeIds/sales internals).
        const selectForStock = wantAnnotate ? { ...DL.Product.defaultSelect, storeIds: 1 } : DL.Product.defaultSelect
        effectiveFilter.status = statusFilter
        Object.assign(effectiveFilter, domainPriceFilter)
        if (onSale) {
            // Better than `saleIds.0 exists`: verify against currently ACTIVE sales
            // (saleIds is denormalized by sale/sync and can lag behind status rollover).
            const activeSaleIds = await DL.Sale.Model.distinct('id', { status: DL.Sale.constants.STATUS.ACTIVE })
            if (activeSaleIds.length === 0) return { products: [], sales: {}, categoryName, categoryPath }
            effectiveFilter.saleIds = { $in: activeSaleIds }
        }
        // Pass effectiveFilter and selectForStock via payload while preserving pagination options
        const readPayload = { ...payload, filter: effectiveFilter, select: selectForStock }
        if (readPayload.limit != null) readPayload.limit = Math.min(Math.max(1, Number(readPayload.limit) || 30), 100)
        if (readPayload.sort == null) readPayload.sort = DL.Product.Model.defaultSort
        products = await DL.Product.read(effectiveFilter, selectForStock, readPayload)
        if (wantAnnotate) products = utils.data.withStock.annotateInStock(products, storeId, mode)
    }

    const saleIdSet = new Set()
    for (const product of products) {
        if (product?.saleIds && Array.isArray(product.saleIds)) {
            for (const saleId of product.saleIds) {
                saleIdSet.add(saleId)
            }
        }
    }

    let sales = {}
    if (saleIdSet.size > 0) {
        const activeSales = await DL.Sale.read(
            {
                id: { $in: Array.from(saleIdSet) },
                status: DL.Sale.constants.STATUS.ACTIVE
            },
            DL.Sale.defaultSelect,
            { limit: 0 }
        )
        for (const sale of activeSales) {
            sales[sale.id] = sale
        }
    }

    if (isStorefront && domainId) {
        products = withDomainPrice(products, domainId)
    }

    return { products, sales, categoryName, categoryPath }
}

get.config = {
    auth: 'none'
}
