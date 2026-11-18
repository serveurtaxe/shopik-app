// Payload templates: route → (fixtures) => payload | null (null = skip, the
// fixture this route needs is missing). domainId is injected by the runner.
// Anything not listed runs with {} — safe only for routes whose {} payload does
// REAL work (read/filters/count routes). Routes with config.required or that
// readById(x) MUST be listed: a missing id either 400s (bad-payload, zero DB
// work) or silently reads an arbitrary first document (readById(undefined)).

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
        case 'order/ops/list': return { limit: 25 }
        case 'order/supplier_report': return { month: fx.month }
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
        // Storefront routes that read _user (the logged-in customer) — an admin
        // session never populates _user and the routes 500, so skip them.
        case 'order/cart/get': return null
        case 'order/window/options': return null
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
