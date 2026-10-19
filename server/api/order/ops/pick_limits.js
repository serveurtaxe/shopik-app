import getPickLimits from '#server/utils/data/getPickLimits.js'

// Client UX helper: effective pick deviation limits for an order's domain.
// Pickers don't have setting:read, so the limits are served here instead.
// Enforcement lives in pick_item (server); these values are display-only.
export default async function pick_limits(payload, { DL }) {
    const { id } = payload
    if (!id) throw { status: 400, message: 'id required' }

    const order = await DL.Order.readById(id)
    if (!order) throw { status: 404, message: 'order not found' }

    return getPickLimits(DL, order.domainId)
}

pick_limits.config = {
    permissions: ['order:pick']
}
