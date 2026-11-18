// Payload templates: route → (fixtures) => payload | { skip: reason } | null
// (skip/null = don't run this route, the fixture it needs is missing). domainId is
// injected by the runner. Anything not listed runs with {} — safe only for routes
// whose {} payload does REAL work (read/filters/count routes). Routes with
// config.required or that readById(x) MUST be listed: a missing id either 400s
// (bad-payload, zero DB work) or silently reads an arbitrary first document
// (readById(undefined)).

// Which login each route must be fired with to do real work. Everything defaults
// to the admin session; the others are the routes that refuse it:
// - suggest_replacements answers 403 unless the caller IS the order's picker.
// - the storefront routes read _user, which the router only populates for a
//   non-admin platform holding USER_TOKEN_COOKIE. For those, an admin burst would
//   not merely fail: product/search and menu/get take a DIFFERENT code path for
//   admins (hidden products, multi-domain prices), so measuring them as admin
//   would rank a request no shopper ever makes.
export const SESSIONS = {
    picker: new Set(['order/ops/suggest_replacements', 'order/ops/pick_limits']),
    customer: new Set([
        'order/cart/get', 'order/window/options', 'order/mine', 'order/status',
        'user/coupon', 'user/favorites', 'menu/get', 'product/search'
    ])
}
export const CUSTOMER_PLATFORM = 'web'

export function sessionFor(route) {
    if (SESSIONS.picker.has(route)) return 'picker'
    if (SESSIONS.customer.has(route)) return 'customer'
    return 'admin'
}

export function payloadFor(route, fixtures) {
    const fx = fixtures
    switch (route) {
        case 'admin/id': return fx.adminId ? { id: fx.adminId } : null
        case 'api_key/id': return fx.apiKeyId ? { id: fx.apiKeyId } : null
        case 'cash_register/id': return fx.cashRegisterId ? { id: fx.cashRegisterId } : null
        case 'category/id': return fx.categoryIds[0] ? { id: fx.categoryIds[0] } : null
        // required:['subGroupCode']: Product.read + countDocuments over one Comax
        // sub-group, i.e. the coverage preview the admin UI opens per mapping.
        case 'category/products': return fx.subGroupCode
            ? { subGroupCode: fx.subGroupCode, limit: 60 }
            : { skip: 'no sampled product carries a comaxSubGroupCode' }
        case 'comax_product/id': return fx.comaxProductId ? { id: fx.comaxProductId } : null
        case 'comax_sale/id': return fx.comaxSaleId ? { id: fx.comaxSaleId } : null
        case 'coupon/id': return fx.couponId ? { id: fx.couponId } : null
        // Category picker source for the display-block UI: Category.read over
        // EVERY category (limit 0) — the same read shape that makes category/tree
        // expensive, reached under display_block permissions.
        case 'display_block/categories': return {}
        case 'display_block/carousel': return fx.carouselBlockId ? { id: fx.carouselBlockId } : null
        case 'display_block/get': return { path: fx.productPagePath }
        case 'display_block/id': return fx.displayBlockId ? { id: fx.displayBlockId } : null
        case 'domain/id': return fx.domainId ? { id: fx.domainId } : null
        case 'log/id': return fx.logId ? { id: fx.logId } : null
        case 'order/details': return fx.orderId ? { id: fx.orderId } : null
        case 'order/id': return fx.orderId ? { id: fx.orderId } : null
        case 'order/timeline': return fx.orderId ? { orderId: fx.orderId } : null
        case 'order/cart/get': return fx.customerPhone ? {} : { skip: 'no shopper with a phone in the stress DB (--user-phone)' }
        case 'order/mine': return fx.customerPhone ? { limit: 20 } : { skip: 'no shopper with a phone in the stress DB (--user-phone)' }
        case 'order/ops/list': return { limit: 25 }
        case 'order/ops/pick_limits': return fx.pickOrderId
            ? { id: fx.pickOrderId }
            : { skip: 'no picking order whose picker can log in' }
        // The 400 the plain {} payload produced: the route needs a real order id
        // plus a barcode that is IN that order's cart.
        case 'order/ops/suggest_replacements': return fx.pickOrderId && fx.pickBarcode
            ? { id: fx.pickOrderId, barcode: fx.pickBarcode, limit: 20 }
            : { skip: 'no picking order whose picker can log in' }
        // The route 403s for an order that is not the caller's, so the number must
        // belong to the sampled shopper, not to any order in the DB.
        case 'order/status': return fx.customerPhone && fx.customerOrderNumber
            ? { orderNumber: fx.customerOrderNumber }
            : { skip: 'the sampled shopper owns no past order — order/status would only 404' }
        case 'order/supplier_report': return { month: fx.month }
        case 'order/window/options': return fx.customerPhone && fx.customerCartStoreId
            ? {}
            : { skip: 'shopper cart has no storeId — the route returns [] before touching mongo' }
        case 'order_window/read': return fx.currentStoreId ? { storeId: fx.currentStoreId } : {}
        case 'order_window_template/id': return fx.orderWindowTemplateId ? { id: fx.orderWindowTemplateId } : null
        // Reads the order doc whole, then its refund transactions: the per-refund
        // invoice links the finance screen opens. Only meaningful on an order that
        // was actually refunded.
        case 'payment/refunds': return fx.refundOrderId
            ? { orderId: fx.refundOrderId }
            : { skip: 'no refund transaction in the stress DB' }
        case 'product/get': return fx.productBarcodes.length ? { barcode: fx.productBarcodes[0] } : {}
        case 'product/id': return fx.productIds[0] ? { id: fx.productIds[0] } : null
        // A plain mongod has no Atlas Search: `Using $search and $vectorSearch
        // aggregation stages requires additional configuration`. search.js answers
        // a numeric query through an exact barcode read that never touches Atlas,
        // so the barcode is what can honestly be measured locally — the text path
        // is a prod-side explain question, not a stress one.
        case 'product/search': return fx.productBarcodes.length
            ? { value: String(fx.productBarcodes[0]) }
            : { skip: 'no product barcode to search for' }
        case 'product/upload_images_check':
            return fx.productBarcodes.length
                ? { selection: fx.productBarcodes.slice(0, 8).map(barcode => ({ name: `${barcode}.jpg`, bytes: 100_000 })) }
                : null
        // Children of a role that HAS children — otherwise the read is an empty list.
        case 'role/children': return fx.parentRoleId ? { id: fx.parentRoleId } : { skip: 'no role has children in the stress DB' }
        case 'sale/id': return fx.saleId ? { id: fx.saleId } : null
        case 'setting/id': return fx.settingId ? { id: fx.settingId } : null
        case 'store/id': return fx.storeIds.length ? { id: fx.storeIds[0] } : null
        case 'store/nearby': return { coordinates: fx.coordinates }
        // A point copied from an address a real delivery went to, so the answer is
        // a hit and not a guaranteed miss through the 2dsphere index.
        case 'supply_area/lookup': return fx.geoPoint?.length === 2
            ? { lng: fx.geoPoint[0], lat: fx.geoPoint[1] }
            : { skip: 'no delivered address to take an in-service point from' }
        case 'supply_area/id': return fx.supplyAreaId ? { id: fx.supplyAreaId } : null
        case 'user/coupon': return fx.customerPhone ? {} : { skip: 'no shopper with a phone in the stress DB (--user-phone)' }
        case 'user/details': return fx.userId ? { id: fx.userId } : null
        case 'user/favorites': return fx.customerPhone ? {} : { skip: 'no shopper with a phone in the stress DB (--user-phone)' }
        case 'user/id': return fx.userId ? { id: fx.userId } : null
        default: return {}
    }
}

// The cheap known-good route the probe hammers during every burst: an indexed
// single-doc read that must stay fast no matter what the burst is doing.
export const PROBE_ROUTE = 'product/get'

export function probePayload(fixtures) {
    const barcode = fixtures.productBarcodes[0]
    return barcode ? { barcode } : {}
}
