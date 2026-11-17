// Payload templates: route → (fixtures) => payload | null (null = skip, the
// fixture this route needs is missing). domainId is injected by the runner.
// Anything not listed runs with {} — the read routes all accept an empty
// payload; a resulting 400 shows up as bad-payload in the report instead of a
// guess.

export function payloadFor(route, fixtures) {
    const fx = fixtures
    switch (route) {
        case 'product/search': return { value: fx.searchTerm }
        case 'product/get':
            return fx.productBarcodes.length ? { barcode: fx.productBarcodes[0] } : {}
        case 'product/count': return {}
        case 'category/tree': return {}
        case 'category/id': return fx.categoryIds[0] ? { id: fx.categoryIds[0] } : null
        case 'comax_product/search': return fx.searchTerm ? { search: fx.searchTerm } : {}
        case 'comax_product/sales_window': return {}
        case 'comax_sale/read': return {}
        case 'order/details': return fx.orderId ? { id: fx.orderId } : null
        case 'order/timeline': return fx.orderId ? { id: fx.orderId } : null
        case 'order/supplier_report': return { month: fx.month }
        case 'order/ops/list': return { limit: 25 }
        case 'order/ops/count': return {}
        // Storefront routes that read _user (the logged-in customer) — an admin
        // session never populates _user and the routes 500, so skip them.
        case 'order/cart/get': return null
        case 'order/window/options': return null
        case 'order_window/read': return fx.currentStoreId ? { storeId: fx.currentStoreId } : {}
        case 'store/nearby': return { coordinates: fx.coordinates }
        case 'shipment/id': return fx.shipmentId ? { id: fx.shipmentId } : null
        case 'shipment/location': return fx.shipmentId ? { id: fx.shipmentId } : null
        case 'shipment/route': return fx.shipmentId ? { id: fx.shipmentId } : null
        case 'user/id': return fx.userId ? { id: fx.userId } : null
        case 'menu/get': return {}
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
