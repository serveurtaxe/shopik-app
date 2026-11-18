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
    roles: 'roles',
    payment_transactions: 'payment_transactions',
    gov_addresses: 'gov_addresses'
}

export async function loadFixtures(uri, { idNum = null, userPhone = null } = {}) {
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

    // A few ACTIVE products: barcodes for the probe and the search fast path, and
    // the sub-group code category/products needs. comaxSubGroupCode rides along on
    // the same 60-doc sample so no extra scan is needed to find a real code.
    const products = await col('products').find(
        { status: { $in: ['active', 'ACTIVE'] }, barcode: { $exists: true } },
        { projection: { _id: 0, id: 1, barcode: 1, comaxSubGroupCode: 1 } }
    ).limit(60).toArray()
    const subGroupCounts = new Map()
    for (const p of products) {
        if (!p.comaxSubGroupCode) continue
        subGroupCounts.set(p.comaxSubGroupCode, (subGroupCounts.get(p.comaxSubGroupCode) || 0) + 1)
    }
    const subGroupCode = [...subGroupCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null

    // A point that is IN the service area by construction: an address a real
    // delivery order was delivered to. (supply_area/lookup answers through a
    // 2dsphere index, so an invented point would measure a guaranteed miss.)
    const delivered = await col('orders').findOne(
        { 'address.location.coordinates': { $size: 2 } },
        { projection: { _id: 0, id: 1, 'address.location': 1 } }
    )
    const geoPoint = delivered?.address?.location?.coordinates?.length === 2
        ? delivered.address.location.coordinates
        : coordinates

    const categories = await col('categories').find({ active: true }, { projection: { _id: 0, id: 1, path: 1 } }).limit(5).toArray()
    const shipment = await col('shipments').findOne({}, { projection: { _id: 0, id: 1 } })
    const user = await col('users').findOne({}, { projection: { _id: 0, id: 1 } })
    const address = await col('gov_addresses').findOne({}, { projection: { city: 1, street: 1 } })

    let admin = null
    if (idNum)
        admin = await col('admins').findOne({ $or: [{ idNum }, { idNum: String(idNum) }] }, { projection: { _id: 0, id: 1, phone: 1, currentStoreId: 1 } })

    // Sessions beyond the admin, because two families of routes refuse to do any
    // DB work for a super-admin burst:
    // - order/ops/suggest_replacements answers 403 unless the caller IS the
    //   order's picker → sample a real picking order and the admin picking it.
    // - the storefront routes read _user → sample a real shopper with an open cart.
    let pickOrder = null
    let picker = null
    for (const order of await col('orders').find(
        { status: 'picking', 'picker.adminId': { $exists: true }, 'cart.0': { $exists: true } },
        { projection: { _id: 0, id: 1, picker: 1, cart: 1 }, sort: { time: -1 }, limit: 5 }
    ).toArray()) {
        const candidate = await col('admins').findOne({ id: order.picker.adminId }, { projection: { _id: 0, id: 1, idNum: 1, phone: 1, active: 1 } })
        if (!candidate?.idNum || !candidate.phone || candidate.active === false) continue
        const item = order.cart.find(c => c.barcode && c.category?.id) || order.cart.find(c => c.barcode)
        if (!item) continue
        pickOrder = { orderId: order.id, barcode: item.barcode }
        picker = candidate
        break
    }

    // --user-phone picks the shopper; otherwise the newest real cart order that
    // carries a storeId — which is what order/window/options needs to do any work
    // at all (it returns [] straight away for a cart without a store). Owners who
    // ALSO have past orders are preferred: order/mine and order/status would
    // otherwise read an empty result for a first-time shopper.
    const newestOwnOrderNumber = async userId =>
        (await col('orders').findOne({ userId, status: { $ne: 'cart' } }, { projection: { _id: 0, number: 1 }, sort: { time: -1 } }))?.number || null

    let customer = userPhone
        ? await col('users').findOne({ phone: userPhone }, { projection: { _id: 0, id: 1, phone: 1, active: 1 } })
        : null
    let customerCart = customer
        ? await col('orders').findOne({ userId: customer.id, status: 'cart', active: true }, { projection: { _id: 0, id: 1, storeId: 1 } })
        : null
    let customerOrderNumber = customer ? await newestOwnOrderNumber(customer.id) : null
    if (!customer) {
        // Sample recent carts that carry a store, then ask in ONE query which of
        // their owners also have non-cart orders. order/mine and order/status read
        // that history, and the old one-lookup-per-cart loop stopped after 8 carts
        // — it picked a first-time shopper when the repeat customers' carts were
        // simply not among the very newest rows.
        const carts = await col('orders').find(
            { status: 'cart', active: true, storeId: { $type: 'string' }, 'cart.0': { $exists: true } },
            { projection: { _id: 0, id: 1, userId: 1, storeId: 1 }, sort: { updatedAt: -1 }, limit: 80 }
        ).toArray()
        const cartOwners = [...new Set(carts.map(c => c.userId).filter(Boolean))]
        const hasHistory = new Set(cartOwners.length
            ? await col('orders').distinct('userId', { userId: { $in: cartOwners }, status: { $ne: 'cart' } })
            : [])
        const ownerOf = cart =>
            col('users').findOne({ id: cart.userId }, { projection: { _id: 0, id: 1, phone: 1, active: 1 } })
        for (const cart of carts.filter(c => hasHistory.has(c.userId))) {
            const owner = await ownerOf(cart)
            if (!owner?.phone || owner.active === false) continue
            customer = owner
            customerCart = cart
            customerOrderNumber = await newestOwnOrderNumber(owner.id)
            break
        }
        if (!customer) // nobody in the sample has history: fall back to any real cart owner
            for (const cart of carts.filter(c => !hasHistory.has(c.userId)).slice(0, 8)) {
                const owner = await ownerOf(cart)
                if (!owner?.phone || owner.active === false) continue
                customer = owner
                customerCart = cart
                break
            }
    }

    // Real ids for the required:['id'] routes (400 without one) and the
    // readById routes (an undefined id silently reads an arbitrary first doc).
    const [apiKey, cashRegister, comaxProduct, comaxSale, coupon, displayBlock, carouselBlock,
        logDoc, orderWindowTemplate, setting, sale, supplyArea, refundTxn, parentRole] = await Promise.all([
        col('api_keys').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('cash_registers').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('comax_products').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('comax_sales').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('coupons').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('display_blocks').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('display_blocks').findOne({ kind: 'product_carousel', active: true }, { projection: { _id: 0, id: 1 } }),
        // Newest log: prod expires logs after a day, so an arbitrary older doc can
        // disappear between fixture load and the route call.
        col('logs').findOne({}, { projection: { _id: 0, id: 1 }, sort: { createdAt: -1 } }),
        col('order_window_templates').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('settings').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('sales').findOne({}, { projection: { _id: 0, id: 1 } }),
        col('supply_areas').findOne({}, { projection: { _id: 0, id: 1 } }),
        // payment/refunds is only interesting on an order that was actually refunded.
        col('payment_transactions').findOne({ kind: 'refund' }, { projection: { _id: 0, orderId: 1 } }),
        // role/children needs a role that HAS children, else it reads an empty list.
        // distinct over parentIds flattens the arrays into the ids that are parents.
        col('roles').findOne({ id: { $in: await col('roles').distinct('parentIds', { parentIds: { $exists: true } }) } }, { projection: { _id: 0, id: 1 } })
    ])

    const sampled = {
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
        logId: logDoc?.id || null,
        orderWindowTemplateId: orderWindowTemplate?.id || null,
        settingId: setting?.id || null,
        saleId: sale?.id || null,
        supplyAreaId: supplyArea?.id || null,
        productPagePath: categories[0]?.path ? `/products/${categories[0].path}` : '/',
        storeIds: stores.map(s => s.id).filter(Boolean),
        currentStoreId: admin?.currentStoreId || stores[0]?.id || null,
        coordinates,
        geoPoint,
        subGroupCode,
        refundOrderId: refundTxn?.orderId || null,
        parentRoleId: parentRole?.id || null,
        productBarcodes: products.map(p => p.barcode).filter(Boolean),
        productIds: products.map(p => p.id).filter(Boolean),
        categoryIds: categories.map(c => c.id).filter(Boolean),
        categoryPaths: categories.map(c => c.path).filter(Boolean),
        orders,
        orderId: orders[0]?.id || null,
        shipmentId: shipment?.id || null,
        userId: user?.id || null,
        address,
        adminPhone: admin?.phone || null,
        customerPhone: customer?.phone || null,
        customerCartId: customerCart?.id || null,
        customerCartStoreId: typeof customerCart?.storeId === 'string' ? customerCart.storeId : null,
        customerOrderNumber: customerOrderNumber || null,
        pickerIdNum: picker?.idNum ? String(picker.idNum) : null,
        pickerPhone: picker?.phone || null,
        pickOrderId: pickOrder?.orderId || null,
        pickBarcode: pickOrder?.barcode || null,
        month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
        // The cart burst itself can be what creates the cart order (the app creates
        // one on the first read for a shopper who has none) — re-sample after that
        // read so a shopper who just got a store-backed cart is measured, not skipped.
        async refreshCustomerCart() {
            if (!customer) return null
            const cart = await col('orders').findOne({ userId: customer.id, status: 'cart', active: true }, { projection: { _id: 0, id: 1, storeId: 1 } })
            sampled.customerCartId = cart?.id || null
            sampled.customerCartStoreId = typeof cart?.storeId === 'string' ? cart.storeId : null
            return sampled.customerCartStoreId
        },
        async close() { await conn.close() }
    }
    return sampled
}
