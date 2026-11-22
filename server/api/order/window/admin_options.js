import { buildWindowOptions } from '#server/utils/data/windowOptions.js'

const ORDER_SELECT = {
    _id: 0,
    id: 1,
    storeId: 1,
    deliveryMethod: 1,
    address: 1,
    window: 1
}

export default async function admin_options({ orderId }, { DL }) {
    const order = await DL.Order.readById(orderId, ORDER_SELECT)
    if (!order) throw { status: 404, message: 'order not found' }
    if (!order.storeId) return []

    return buildWindowOptions({
        DL,
        storeId: order.storeId,
        deliveryMethod: order.deliveryMethod,
        areaId: order.address?.areaId,
        currentWindowId: order.window?.id,
        includeFlags: true
    })
}

admin_options.config = {
    required: ['orderId'],
    permissions: ['order:read']
}
