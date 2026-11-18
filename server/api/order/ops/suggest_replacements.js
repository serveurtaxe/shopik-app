import { isProductInCart } from '#common/functions/cartReplacements.js'

export default async function suggest_replacements(payload, { DL, _admin }) {
    const { id, barcode, search = '', limit = 20 } = payload || {}
    if (!id || !barcode) throw { status: 400, message: 'id, barcode required' }

    const order = await DL.Order.readById(id)
    if (!order) throw { status: 404, message: 'order not found' }
    if (order.status !== 'picking') throw { status: 400, message: 'order not in picking' }
    if (order.picker?.adminId !== _admin.id) throw { status: 403, message: 'not your order' }

    const cart = order.cart || []
    const item = cart.find(c => c.barcode === barcode)
    if (!item) throw { status: 404, message: 'item not found' }

    const lim = Math.min(Math.max(Number(limit) || 20, 1), 50)
    // Products the order already has are never candidates, but they still count
    // against the query limit — read extra rows so the filtered list stays full.
    const fetchLimit = Math.min(lim + cart.length, 100)
    const candidates = (products) => (products || [])
        .filter(p => !isProductInCart(p, cart))
        .slice(0, lim)
    const STATUS = DL.Product.constants.STATUS.ACTIVE
    const select = {
        _id: 0, id: 1, barcode: 1, scannableBarcodes: 1, name: 1,
        'images.product': 1, /* images: 1, */ prices: 1, price: 1,
        label: 1, producer: 1, netContentText: 1, unit: 1, saleIds: 1,
        category: 1, storageType: 1, picking: 1, status: 1
    }

    const q = String(search ?? '').trim()

    // Picker replacements must be sellable in the order's domain:
    // only products with a price entry for order.domainId are candidates.
    const domainPriceFilter = order.domainId ? { 'prices.domainId': order.domainId } : {}

    // Exact barcode fast-path (scanner): numeric scan jumps straight to that product
    if (q && /^\d+$/.test(q)) {
        const exact = await DL.Product.readOne(
            { $or: [{ barcode: q }, { scannableBarcodes: q }] },
            select
        )
        if (exact && exact.status !== DL.Product.constants.STATUS.ARCHIVED
            && (!order.domainId || (exact.prices || []).some(p => p?.domainId === order.domainId))) {
            // The cart already has this product — it is not an alternative.
            if (isProductInCart(exact, cart))
                return { products: [], sales: {} }
            const sales = await collectSales([exact], DL)
            return { products: [exact], sales }
        }
        // fall through to text search if no exact hit
    }

    const baseFilter = { status: STATUS, barcode: { $ne: barcode }, ...domainPriceFilter }

    // Scope to same category when known (original item category or live product category)
    let categoryId = item.category?.id || null
    let categoryPathIds = item.category?.pathIds || []
    if (!categoryId) {
        try {
            const orig = await DL.Product.Model.findOne(
                { $or: [{ barcode }, { scannableBarcodes: barcode }] },
                { _id: 0, category: 1 }
            ).lean()
            categoryId = orig?.category?.id || null
            categoryPathIds = orig?.category?.pathIds || []
        } catch { }
    }
    // Filter on category.pathIds, never on category.id: nothing indexes
    // category.id, so the planner fell back to {status, prices.domainId,
    // totalSalesUnits, id} and walked EVERY active product of the domain
    // (6.8k-7.2k docs measured on the prod copy, to return 19-100 candidates).
    // pathIds is indexed and stores the whole assigned path (the leaf id is its
    // last element), so equality on the item's category id reads only that
    // category — 20-110 docs for the identical result set — and anything mapped
    // to a sub-category of it, which is a valid substitute too.
    if (categoryId) baseFilter['category.pathIds'] = categoryId
    else if (categoryPathIds?.length) baseFilter['category.pathIds'] = { $in: categoryPathIds }

    let products = []
    try {
        if (q) {
            products = await DL.Product.search(q, baseFilter, { limit: fetchLimit, select })
        } else {
            // Sort keys have to match an index the collection actually owns:
            // {totalSalesUnits, sortOrder} is neither the storefront order
            // ({sortOrder, totalSalesUnits}) nor the {status, prices.domainId,
            // totalSalesUnits, id} index, so the read ended in a blocking sort of
            // every active product of the domain — 7 442 docs × 3.3 KB, the same
            // 32 MB sort buffer that already killed the skip-paged sync. With only
            // the tiebreaker the index answers the order (explain: no SORT stage).
            // Sales ranking is what replacements are about; sortOrder (0-5) was a
            // near-no-op tiebreak next to it.
            products = await DL.Product.read(baseFilter, select, { limit: fetchLimit, sort: { totalSalesUnits: -1 } })
        }
    } catch (err) {
        products = []
    }

    // Fallback: no same-category candidates → broaden to same storage type
    if (!candidates(products).length && !q && (categoryId || categoryPathIds?.length)) {
        try {
            const broad = { status: STATUS, barcode: { $ne: barcode }, ...domainPriceFilter }
            if (item.storageType) broad.storageType = item.storageType
            products = await DL.Product.read(broad, select, { limit: fetchLimit, sort: { totalSalesUnits: -1 } })
        } catch {
            products = []
        }
    }

    const result = candidates(products)
    const sales = await collectSales(result, DL)
    return { products: result, sales }

    async function collectSales(prods, DL) {
        const saleIdSet = new Set()
        for (const p of prods || []) {
            if (p?.saleIds && Array.isArray(p.saleIds)) {
                for (const sid of p.saleIds) saleIdSet.add(sid)
            }
        }
        if (!saleIdSet.size) return {}
        try {
            const activeSales = await DL.Sale.read(
                { id: { $in: Array.from(saleIdSet) }, status: DL.Sale.constants.STATUS.ACTIVE },
                DL.Sale.defaultSelect,
                { limit: 0 }
            )
            const map = {}
            for (const s of activeSales) map[s.id] = s
            return map
        } catch {
            return {}
        }
    }
}

suggest_replacements.config = {
    permissions: ['order:pick']
}
