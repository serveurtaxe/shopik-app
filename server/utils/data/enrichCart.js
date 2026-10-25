export default async function enrichCart(order, DL) {
    if (!order?.cart?.length || !DL?.Product?.Model) return order
    const needsEnrich = []
    const ids = []
    const barcodes = []
    for (let i = 0; i < order.cart.length; i++) {
        const item = order.cart[i]
        const missingImages = !item.images || !item.images.product || item.images.product.length === 0
        const missingUnit = !item.unit || item.unit.step == null || item.unit.minAmount == null
        const missingMeta = !item.storageType || !item.category || !item.label || !item.netContentText
        if (missingImages || missingUnit || missingMeta) {
            needsEnrich.push(i)
            if (item.id) ids.push(item.id)
            if (item.barcode) barcodes.push(item.barcode)
        }
    }
    if (!needsEnrich.length) return order

    // fetch products by id or barcode
    const or = []
    if (ids.length) or.push({ id: { $in: ids } })
    if (barcodes.length) or.push({ barcode: { $in: barcodes } })
    const query = or.length === 1 ? or[0] : { $or: or }

    const products = await DL.Product.Model.find(query, {
        _id: 0,
        id: 1,
        barcode: 1,
        images: 1,
        label: 1,
        producer: 1,
        netContentText: 1,
        category: 1,
        storageType: 1,
        picking: 1,
        unit: 1
    }).lean()

    const byId = new Map(products.map(p => [p.id, p]))
    const byBarcode = new Map(products.map(p => [p.barcode, p]))

    for (const idx of needsEnrich) {
        const item = order.cart[idx]
        const prod = (item.id && byId.get(item.id)) || (item.barcode && byBarcode.get(item.barcode))
        if (!prod) continue
        if (!item.images || !item.images.product?.length) {
            item.images = prod.images || item.images
        }
        if (!item.label && prod.label) item.label = prod.label
        if (!item.producer && prod.producer) item.producer = prod.producer
        if (!item.netContentText && prod.netContentText) item.netContentText = prod.netContentText
        if (!item.category && prod.category) item.category = prod.category
        if (!item.storageType && prod.storageType) item.storageType = prod.storageType
        if (!item.picking && prod.picking) item.picking = prod.picking
        if (prod.unit) {
            if (!item.unit) item.unit = {}
            if (item.unit.type == null && prod.unit.type) item.unit.type = prod.unit.type
            if (item.unit.baseUnit == null && prod.unit.baseUnit) item.unit.baseUnit = prod.unit.baseUnit
            if (item.unit.minAmount == null && prod.unit.minAmount != null) item.unit.minAmount = prod.unit.minAmount
            if (item.unit.step == null && prod.unit.step != null) item.unit.step = prod.unit.step
        }
    }
    return order
}

export async function enrichOrders(orders, DL) {
    if (!Array.isArray(orders) || !orders.length) return orders
    // collect all barcodes/ids across orders that need enrich
    const allBarcodes = new Set()
    const allIds = new Set()
    const needMap = []
    for (const order of orders) {
        if (!order?.cart?.length) continue
        for (const item of order.cart) {
            const miss = !item.images || !item.images.product?.length || !item.storageType || !item.unit?.step || !item.netContentText
            if (miss) {
                if (item.id) allIds.add(item.id)
                if (item.barcode) allBarcodes.add(item.barcode)
                needMap.push(item)
            }
        }
    }
    if (!needMap.length) return orders
    const or = []
    if (allIds.size) or.push({ id: { $in: Array.from(allIds) } })
    if (allBarcodes.size) or.push({ barcode: { $in: Array.from(allBarcodes) } })
    const query = or.length === 1 ? or[0] : { $or: or }
    const products = await DL.Product.Model.find(query, {
        _id: 0, id: 1, barcode: 1, images: 1, label: 1, producer: 1, netContentText: 1, category: 1, storageType: 1, picking: 1, unit: 1
    }).lean()
    const byId = new Map(products.map(p => [p.id, p]))
    const byBarcode = new Map(products.map(p => [p.barcode, p]))
    for (const order of orders) {
        if (!order?.cart?.length) continue
        for (const item of order.cart) {
            const miss = !item.images || !item.images.product?.length || !item.storageType || !item.unit?.step || !item.netContentText
            if (!miss) continue
            const prod = (item.id && byId.get(item.id)) || (item.barcode && byBarcode.get(item.barcode))
            if (!prod) continue
            if (!item.images || !item.images.product?.length) item.images = prod.images || item.images
            if (!item.label && prod.label) item.label = prod.label
            if (!item.producer && prod.producer) item.producer = prod.producer
            if (!item.netContentText && prod.netContentText) item.netContentText = prod.netContentText
            if (!item.category && prod.category) item.category = prod.category
            if (!item.storageType && prod.storageType) item.storageType = prod.storageType
            if (!item.picking && prod.picking) item.picking = prod.picking
            if (prod.unit) {
                if (!item.unit) item.unit = {}
                if (item.unit.type == null && prod.unit.type) item.unit.type = prod.unit.type
                if (item.unit.baseUnit == null && prod.unit.baseUnit) item.unit.baseUnit = prod.unit.baseUnit
                if (item.unit.minAmount == null && prod.unit.minAmount != null) item.unit.minAmount = prod.unit.minAmount
                if (item.unit.step == null && prod.unit.step != null) item.unit.step = prod.unit.step
            }
        }
    }
    return orders
}
