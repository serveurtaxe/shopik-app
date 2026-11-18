// Payload templates: route → (fixtures) => payload | { skip: reason } | null
// (skip/null = don't run this route, the fixture it needs is missing). domainId is
// injected by the runner. Anything not listed runs with {} — safe only for routes
// whose {} payload does REAL work (read/filters/count routes). Routes with
// config.required or that readById(x) MUST be listed: a missing id either 400s
// (bad-payload, zero DB work) or silently reads an arbitrary first document
// (readById(undefined)).

// Which login each route must be fired with to do real work. Everything defaults
// to the admin session; these two are the routes that refuse it:
// - suggest_replacements answers 403 unless the caller IS the order's picker.
// - the storefront routes read _user, which the router only populates for a
//   non-admin platform holding USER_TOKEN_COOKIE.
export const SESSIONS = {
    picker: new Set(['order/ops/suggest_replacements']),
    customer: new Set(['order/cart/get', 'order/window/options'])
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
        case 'comax_product/id': return fx.comaxProductId ? { id: fx.comaxProductId } : null
        case 'comax_sale/id': return fx.comaxSaleId ? { id: fx.comaxSaleId } : null
        case 'coupon/id': return fx.couponId ? { id: fx.couponId } : null
        case 'display_block/carousel': return fx.carouselBlockId ? { id: fx.carouselBlockId } : null
        case 'display_block/get': return { path: fx.productPagePath }
        case 'display_block/id': return fx.displayBlockId ? { id: fx.displayBlockId } : null
        case 'domain/id': return fx.domainId ? { id: fx.domainId } : null
        case 'log/id': return fx.logId ? { id: fx.logId } : null
        case 'order/details': return fx.orderId ? { id: fx.orderId } : null
        case 'order/id': return fx.orderId ? { id: fx.orderId } : null
        case 'order/timeline': return fx.orderId ? { orderId: fx.orderId } : null
        case 'order/cart/get': return fx.customerPhone ? {} : { skip: 'no shopper with a phone in the stress DB (--user-phone)' }
        case 'order/ops/list': return { limit: 25 }
        // The 400 the plain {} payload produced: the route needs a real order id
        // plus a barcode that is IN that order's cart.
        case 'order/ops/suggest_replacements': return fx.pickOrderId && fx.pickBarcode
            ? { id: fx.pickOrderId, barcode: fx.pickBarcode, limit: 20 }
            : { skip: 'no picking order whose picker can log in' }
        case 'order/supplier_report': return { month: fx.month }
        case 'order/window/options': return fx.customerPhone && fx.customerCartStoreId
            ? {}
            : { skip: 'shopper cart has no storeId — the route returns [] before touching mongo' }
        case 'order_window/read': return fx.currentStoreId ? { storeId: fx.currentStoreId } : {}
        case 'order_window_template/id': return fx.orderWindowTemplateId ? { id: fx.orderWindowTemplateId } : null
        case 'product/get': return fx.productBarcodes.length ? { barcode: fx.productBarcodes[0] } : {}
        case 'product/id': return fx.productIds[0] ? { id: fx.productIds[0] } : null
        case 'product/search': return { value: fx.searchTerm }
        case 'product/upload_images_check':
            return fx.productBarcodes.length
                ? { selection: fx.productBarcodes.slice(0, 8).map(barcode => ({ name: `${barcode}.jpg`, bytes: 100_000 })) }
                : null
        case 'sale/id': return fx.saleId ? { id: fx.saleId } : null
        case 'setting/id': return fx.settingId ? { id: fx.settingId } : null
        case 'store/id': return fx.storeIds.length ? { id: fx.storeIds[0] } : null
        case 'store/nearby': return { coordinates: fx.coordinates }
        case 'supply_area/id': return fx.supplyAreaId ? { id: fx.supplyAreaId } : null
        case 'user/details': return fx.userId ? { id: fx.userId } : null
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
