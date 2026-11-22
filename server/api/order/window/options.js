import { buildWindowOptions } from '#server/utils/data/windowOptions.js'

export default async function options(payload, { DL, _user, utils }) {
    const cartOrder = await utils.data.getUserOrder({ DL, _user })

    if (!cartOrder?.storeId) return []

    return buildWindowOptions({
        DL,
        storeId: cartOrder.storeId,
        deliveryMethod: cartOrder.deliveryMethod,
        areaId: cartOrder.address?.areaId,
        currentWindowId: cartOrder.window?.id
    })
}

options.config = { auth: 'required' }
