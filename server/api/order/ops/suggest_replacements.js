export default async function suggest_replacements(payload, { DL, _admin }) {
    const { id, barcode, search = '', limit = 20 } = payload || {}
    if (!id || !barcode) throw { status: 400, message: 'id, barcode required' }

    const order = await DL.Order.readById(id)
    if (!order) throw { status: 404, message: 'order not found' }
    if (order.status !== 'picking') throw { status: 400, message: 'order not in picking' }
    if (order.picker?.adminId !== _admin.id) throw { status: 403, message: 'not your order' }

    const item = (order.cart || []).find(c => c.barcode === barcode)
    if (!item) throw { status: 404, message: 'item not found' }

    const lim = Math.min(Math.max(Number(limit) || 20, 1), 50)
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
    if (categoryId) baseFilter['category.id'] = categoryId
    else if (categoryPathIds?.length) baseFilter['category.pathIds'] = { $in: categoryPathIds }

    let products = []
    try {
        if (q) {
            products = await DL.Product.search(q, baseFilter, { limit: lim, select })
        } else {
            products = await DL.Product.read(baseFilter, select, { limit: lim, sort: { totalSalesUnits: -1, sortOrder: -1 } })
        }
    } catch (err) {
        products = []
    }

    // Fallback: no same-category candidates → broaden to same storage type
    if (!products?.length && !q && (categoryId || categoryPathIds?.length)) {
        try {
            const broad = { status: STATUS, barcode: { $ne: barcode }, ...domainPriceFilter }
            if (item.storageType) broad.storageType = item.storageType
            products = await DL.Product.read(broad, select, { limit: lim, sort: { totalSalesUnits: -1 } })
        } catch {
            products = []
        }
    }

    const sales = await collectSales(products, DL)
    return { products: products || [], sales }

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
