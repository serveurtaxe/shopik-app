const allowedFields = [
    'id',
    'barcode',
    'name',
    'amount',
    'finalAmount',
    'price',
    'totalSum',
    'regularSum',
    'saleSum',
    'saleIds',
    'missing',
    'replacedBy',
    'label',
    'netContentText',
    'unit'
]
export default function filterClientOrder(order) {
    if (!order) return null

    // Strict whitelist: internal ops fields (picker/shipper/*Finalizer,
    // messages, boxes, origin, payment secrets, logistics, ...) never
    // reach the storefront, even when new keys are added to the schema.
    const ORDER_CLIENT_FIELDS = [
        'id', 'number', 'status', 'time', 'deliveryMethod', 'address',
        'storeId', 'storeName', 'window', 'sum', 'sumNoCoupon',
        'sumWithShipping', 'shipping', 'finalSum', 'finalSumNoCoupon',
        'finalSumWithShipping', 'finalShipping', 'coupons', 'cart',
        'customerUpdatedAt', 'comment', 'replaceProducts',
        'replaceProductsNoCall', 'leaveOrderAtDoor', 'name', 'phone',
        'secondPhone', 'email', 'paid', 'paidAt'
        // NOTE: no `domainId` — domain pricing is resolved server-side into a
        // flat `price`; the storefront carries no domain logic.
    ]
    const filtered = {}
    for (const key of ORDER_CLIENT_FIELDS) {
        if (order[key] !== undefined) filtered[key] = order[key]
    }
    // Client-safe payment subset only (no cardToken/terminalId/authCode).
    if (order.payment && typeof order.payment === 'object') {
        const safePayment = {}
        for (const k of ['last4digits', 'cardCompany', 'authorizedAmount', 'capturedAt']) {
            if (order.payment[k] !== undefined) safePayment[k] = order.payment[k]
        }
        if (Object.keys(safePayment).length) filtered.payment = safePayment
    }
    // Strip coupon targeting PII that may already be persisted on old orders.
    if (Array.isArray(filtered.coupons)) {
        filtered.coupons = filtered.coupons.map(c => {
            if (!c || typeof c !== 'object') return c
            const { whitelist, blacklist, condition, ...safe } = c
            return safe
        })
    }

    if (filtered.cart && Array.isArray(filtered.cart)) {
        filtered.cart = filtered.cart.map(item => {
            const clientItem = {}
            for (const key of Object.keys(item)) {
                if (key.startsWith('admin') || key.startsWith('internal')) continue
                if (allowedFields.includes(key)) {
                    clientItem[key] = item[key]
                }
            }
            // ensure unit present even if missing
            if (!clientItem.unit && item.unit) clientItem.unit = item.unit
            return clientItem
        })
    }

    return filtered
}