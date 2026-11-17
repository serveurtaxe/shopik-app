// The admin Orders table (the only caller that sends no select) renders and exports
// columns only — number/name/phone/email/status/deliveryMethod/sum/paid/window —
// and a full-document read carries both cart arrays with that: ~1.3MB brotli for a
// 30-row page on prod. Without an explicit select this route ships the schema's
// default list minus the carts; a caller that wants them passes its own select.
// Safe to default lean: this route needs order:read, and API keys can only ever
// hold bot:* permissions (common/constants/apiKeyPermissions.js), so no external
// integration reads it.
const listSelect = {
    _id: 0,
    id: 1,
    number: 1,
    name: 1,
    phone: 1,
    email: 1,
    status: 1,
    sum: 1,
    sumWithShipping: 1,
    shipping: 1,
    finalSum: 1,
    finalSumWithShipping: 1,
    finalShipping: 1,
    sumNoCoupon: 1,
    coupons: 1,
    deliveryMethod: 1,
    paid: 1,
    paidAt: 1,
    address: 1,
    storeId: 1,
    window: 1,
    time: 1,
    createdAt: 1,
    updatedAt: 1,
    domainId: 1,
    userId: 1
}

export default async function read(payload, { DL, _admin }) {
    const { filter = {}, select } = payload
    return DL.Order.read(filter, select || listSelect, payload)
}

read.config = {
    permissions: ['order:read']
}
