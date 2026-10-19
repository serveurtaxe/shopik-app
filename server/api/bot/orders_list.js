import resolveBotUser from '#server/utils/auth/resolveBotUser.js'

const LIST_SELECT = {
    _id: 0,
    number: 1,
    status: 1,
    time: 1,
    'window.date': 1,
    'window.end': 1,
    'window.start': 1,
    'window.startTimestamp': 1,
    'window.endTimestamp': 1,
    'window.leadTimestamp': 1,
    deliveryMethod: 1,
    finalSumWithShipping: 1
}

/**
 * POST /api/bot/orders_list
 * Auth: API key with `bot:order` permission (router enforces).
 * Body: { userToken, limit?, skip? }
 * Bot equivalent of order/mine (which needs a cookie session).
 */
export default async function orders_list(payload, info) {
    const { DL, utils } = info
    const { userToken, domainId, limit = 20, skip = 0 } = payload || {}

    const user = await resolveBotUser({ DL, utils, domainId, userToken })

    const docs = await DL.Order.Model.find(
        { userId: user.id, status: { $ne: 'cart' } },
        LIST_SELECT
    )
        .sort({ time: -1, _id: -1 })
        .skip(Math.max(0, Number(skip) || 0))
        .limit(Math.min(Math.max(1, Number(limit) || 20), 50))
        .lean()
    return docs
}

orders_list.config = {
    auth: 'none',
    permissions: ['bot:order'],
    required: ['userToken']
}
