// Barcode index that also answers for scan aliases: an order line may still
// name a barcode the alias import folded into this product, and the product is
// where its image/unit/category live.
function barcodeIndex(products = []) {
    const byBarcode = new Map()
    for (const product of products || []) {
        if (product.barcode) byBarcode.set(product.barcode, product)
        for (const alias of product.scannableBarcodes || []) byBarcode.set(String(alias), product)
    }
    return byBarcode
}

// A line is missing display data when the snapshot predates a field. The family
// barcodes are never stored on the line, so they are read for every line the
// scan modal may open — it matches the physical package against them (an alias
// must scan as its product).
const needsDisplay = item => !item.images || !item.images.product?.length || !item.storageType || !item.unit?.step || !item.netContentText
const needsFamily = item => !Array.isArray(item.scannableBarcodes)

export default async function enrichCart(order, DL) {
    if (!order?.cart?.length || !DL?.Product?.Model) return order
    const needsEnrich = []
    const ids = []
    const barcodes = []
    for (let i = 0; i < order.cart.length; i++) {
        const item = order.cart[i]
        if (needsDisplay(item) || needsFamily(item)) {
            needsEnrich.push(i)
            if (item.id) ids.push(item.id)
            if (item.barcode) barcodes.push(item.barcode)
        }
    }
    if (!needsEnrich.length) return order

    // Fetch products by id or barcode. A line whose barcode is now a scan alias
    // (`scannableBarcodes`) belongs to the product that owns it: that is where
    // its image/unit/category live, since the alias doc was folded away.
    const or = []
    if (ids.length) or.push({ id: { $in: ids } })
    if (barcodes.length) or.push({ barcode: { $in: barcodes } }, { scannableBarcodes: { $in: barcodes } })
    const query = or.length === 1 ? or[0] : { $or: or }

    const products = await DL.Product.Model.find(query, {
        _id: 0,
        id: 1,
        barcode: 1,
        scannableBarcodes: 1,
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
    const byBarcode = barcodeIndex(products)

    for (const idx of needsEnrich) {
        const item = order.cart[idx]
        const prod = (item.id && byId.get(item.id)) || (item.barcode && byBarcode.get(item.barcode))
        if (!prod) continue
        if (needsFamily(item)) item.scannableBarcodes = prod.scannableBarcodes || []
        if (!needsDisplay(item)) continue
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
            if (needsDisplay(item) || needsFamily(item)) {
                if (item.id) allIds.add(item.id)
                if (item.barcode) allBarcodes.add(item.barcode)
                needMap.push(item)
            }
        }
    }
    if (!needMap.length) return orders
    const or = []
    if (allIds.size) or.push({ id: { $in: Array.from(allIds) } })
    if (allBarcodes.size) or.push({ barcode: { $in: Array.from(allBarcodes) } }, { scannableBarcodes: { $in: Array.from(allBarcodes) } })
    const query = or.length === 1 ? or[0] : { $or: or }
    const products = await DL.Product.Model.find(query, {
        _id: 0, id: 1, barcode: 1, scannableBarcodes: 1, images: 1, label: 1, producer: 1, netContentText: 1, category: 1, storageType: 1, picking: 1, unit: 1
    }).lean()
    const byId = new Map(products.map(p => [p.id, p]))
    const byBarcode = barcodeIndex(products)
    for (const order of orders) {
        if (!order?.cart?.length) continue
        for (const item of order.cart) {
            if (!needsDisplay(item) && !needsFamily(item)) continue
            const prod = (item.id && byId.get(item.id)) || (item.barcode && byBarcode.get(item.barcode))
            if (!prod) continue
            if (needsFamily(item)) item.scannableBarcodes = prod.scannableBarcodes || []
            if (!needsDisplay(item)) continue
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
