// Statuses in which an admin may move an order to another delivery window.
// Packing captures the payment, so a packed order is always charged and never
// eligible.
export const WINDOW_CHANGE_STATUSES = ['paid', 'picking', 'picked']

export function isOrderCaptured(order) {
    return Boolean(order?.payment?.captureProviderTxnId)
}

export function canChangeOrderWindow(order) {
    return WINDOW_CHANGE_STATUSES.includes(order?.status) && !isOrderCaptured(order)
}

// A window is "full" when either its global counter or the counter of the
// order's area group reached its capacity.
export function isWindowFull(windowDoc, groupEntry) {
    if (!windowDoc) return false

    const maxCapacity = Number(windowDoc.maxCapacity)
    const totalOrders = Number(windowDoc.totalOrders || 0)
    const globalFull = Number.isFinite(maxCapacity) && totalOrders >= maxCapacity

    const groupFull = Boolean(groupEntry) &&
        Number(groupEntry.count || 0) >= Number(groupEntry.capacity || 0)

    return globalFull || groupFull
}
