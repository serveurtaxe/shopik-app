// Fixture sampling: one raw mongoose connection to the stress DB (no models —
// collection names follow createModels' snake_case-plural convention) providing
// real ids/payloads for the route bursts. Missing pieces degrade to null, and
// routes that need them are reported as skipped instead of guessed.

import mongoose from 'mongoose'

const COLLECTIONS = {
    domains: 'domains',
    stores: 'stores',
    products: 'products',
    categories: 'categories',
    orders: 'orders',
    sales: 'sales',
    shipments: 'shipments',
    admins: 'admins',
    users: 'users',
    otps: 'otps',
    gov_addresses: 'gov_addresses'
}

export async function loadFixtures(uri, { idNum = null } = {}) {
    const conn = await mongoose.createConnection(uri, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 5000,
        bufferCommands: false
    }).asPromise()
    const db = conn.db
    const col = name => db.collection(COLLECTIONS[name] || name)

    const domain = await col('domains').findOne({ isDefault: true }, { projection: { id: 1 } })
        || await col('domains').findOne({ active: true }, { projection: { id: 1 } })

    const stores = await col('stores').find({ active: true }, { projection: { _id: 0, id: 1, address: 1 } }).limit(10).toArray()
    const coordinates = stores.find(s => s.address?.location?.coordinates?.length === 2)?.address?.location?.coordinates
        || [34.78, 32.08] // fallback: Tel Aviv area — nearby just needs a valid point

    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    let orders = await col('orders').find(
        { status: { $in: ['done', 'shipped', 'packed'] }, time: { $gte: new Date(monthStart.getFullYear() - 1, 0, 1) } },
        { projection: { _id: 0, id: 1, number: 1 } }
    ).sort({ time: -1 }).limit(10).toArray()
    if (!orders.length)
        orders = await col('orders').find({}, { projection: { _id: 0, id: 1, number: 1 } }).sort({ _id: -1 }).limit(10).toArray()

    // A few ACTIVE products: barcodes for the probe and search fixtures, and a
    // name word that real search traffic would actually type.
    const products = await col('products').find(
        { status: { $in: ['active', 'ACTIVE'] }, barcode: { $exists: true } },
        { projection: { _id: 0, id: 1, barcode: 1, name: 1 } }
    ).limit(60).toArray()
    const words = products.map(p => String(p.name || '').split(/\s+/).find(w => w.length >= 3)).filter(Boolean)
    const searchTerm = words[0] || 'ח'

    const categories = await col('categories').find({ active: true }, { projection: { _id: 0, id: 1, path: 1 } }).limit(5).toArray()
    const shipment = await col('shipments').findOne({}, { projection: { _id: 0, id: 1 } })
    const user = await col('users').findOne({}, { projection: { _id: 0, id: 1 } })
    const address = await col('gov_addresses').findOne({}, { projection: { city: 1, street: 1 } })

    let admin = null
    if (idNum)
        admin = await col('admins').findOne({ $or: [{ idNum }, { idNum: String(idNum) }] }, { projection: { _id: 0, id: 1, phone: 1, currentStoreId: 1 } })

    // Real ids for the required:['id'] routes (400 without one) and the
    // readById routes (an undefined id silently reads an arbitrary first doc).
    const [apiKey, cashRegister, comaxProduct, comaxSale, coupon, displayBlock, carouselBlock,
        orderWindowTemplate, setting, sale, supplyArea] = await Promise.all([
        col('api_keys').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('cash_registers').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('comax_products').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('comax_sales').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('coupons').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('display_blocks').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('display_blocks').findOne({ kind: 'product_carousel', active: true }, { projection: { _id: 0, id: 1 } }),
        col('order_window_templates').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('settings').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('sales').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('supply_areas').findOne({}, { projection: { _id: 0, id: 1 } })
    ])

    return {
        conn,
        db,
        otpCollection: col('otps'),
        domainId: domain?.id || null,
        adminId: admin?.id || null,
        apiKeyId: apiKey?.id || null,
        cashRegisterId: cashRegister?.id || null,
        comaxProductId: comaxProduct?.id || null,
        comaxSaleId: comaxSale?.id || null,
        couponId: coupon?.id || null,
        displayBlockId: displayBlock?.id || null,
        carouselBlockId: carouselBlock?.id || null,
        orderWindowTemplateId: orderWindowTemplate?.id || null,
        settingId: setting?.id || null,
        saleId: sale?.id || null,
        supplyAreaId: supplyArea?.id || null,
        productPagePath: categories[0]?.path ? `/products/${categories[0].path}` : '/',
        storeIds: stores.map(s => s.id).filter(Boolean),
        currentStoreId: admin?.currentStoreId || stores[0]?.id || null,
        coordinates,
        productBarcodes: products.map(p => p.barcode).filter(Boolean),
        productIds: products.map(p => p.id).filter(Boolean),
        searchTerm,
        categoryIds: categories.map(c => c.id).filter(Boolean),
        categoryPaths: categories.map(c => c.path).filter(Boolean),
        orders,
        orderId: orders[0]?.id || null,
        shipmentId: shipment?.id || null,
        userId: user?.id || null,
        address,
        adminPhone: admin?.phone || null,
        month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
        async close() { await conn.close() }
    }
}
