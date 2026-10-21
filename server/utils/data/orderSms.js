import {
    ORDER_SMS_STAGES,
    getDefaultOrderSmsTemplate,
    getOrderSmsMethod,
    getOrderSmsTemplateKey
} from '#common/constants/orderSms.js'
import renderOrderSmsTemplate from '#common/functions/renderOrderSmsTemplate.js'

const STAGE_KEYS = new Set(ORDER_SMS_STAGES.map(stage => stage.key))

function formatDate(value) {
    if (!value) return ''
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
    if (!match) return String(value)
    return `${match[3]}/${match[2]}/${match[1]}`
}

function formatHour(value) {
    if (value === undefined || value === null || value === '') return ''
    const number = Number(value)
    if (!Number.isFinite(number)) return String(value)
    return `${String(Math.trunc(number)).padStart(2, '0')}:00`
}

function getDomainUrl(domain) {
    const url = String(domain?.url || '').trim().replace(/\/+$/, '')
    if (!url) return ''
    return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

export function buildOrderSmsValues({ order, domain, store } = {}) {
    const orderUrl = getDomainUrl(domain)
    return {
        customer_first_name: order?.name?.first || 'לקוח',
        order_number: order?.number || '',
        delivery_date: formatDate(order?.window?.date),
        delivery_window_start: formatHour(order?.window?.start),
        delivery_window_end: formatHour(order?.window?.end),
        order_link: orderUrl ? `${orderUrl}/account/orders` : '',
        pickup_store_name: store?.name || order?.storeName || ''
    }
}

async function resolveDomain({ DL, order }) {
    let domain = null
    if (order.domainId) domain = await DL.Domain.readById(order.domainId).catch(() => null)
    if (!domain) domain = await DL.Domain.readOne({ isDefault: true, active: true }).catch(() => null)
    return domain
}

async function resolveTemplate({ DL, order, domain, stage }) {
    const method = getOrderSmsMethod(order)
    const key = getOrderSmsTemplateKey(method, stage)
    if (!key) return null
    const setting = domain?.id
        ? await DL.Setting.readOne({ domainId: domain.id, key }).catch(() => null)
        : null
    const value = typeof setting?.value === 'string' ? setting.value.trim() : ''
    return value || getDefaultOrderSmsTemplate(method, stage)
}

export async function sendOrderStageSms({ DL, external, order, stage, adminId } = {}) {
    if (!order?.id || !STAGE_KEYS.has(stage)) return null

    try {
        const current = await DL.Order.readById(order.id)
        if (!current) return null
        if (current.notifications?.orderSmsSent?.[stage]) return null
        if (!current.phone) {
            console.warn(`[order-sms] skipping ${stage} for order ${current.id}: no phone`)
            return null
        }

        const domain = await resolveDomain({ DL, order: current })
        if (!domain?.id) {
            console.warn(`[order-sms] skipping ${stage} for order ${current.id}: no domain`)
            return null
        }

        const template = await resolveTemplate({ DL, order: current, domain, stage })
        if (!template) return null

        let firstName = current.name?.first
        if (!firstName && current.userId) {
            const user = await DL.User.readById(current.userId).catch(() => null)
            firstName = user?.name?.first
        }

        const store = current.deliveryMethod === 'pickup' && current.storeId
            ? await DL.Store.readById(current.storeId).catch(() => null)
            : null

        const message = renderOrderSmsTemplate(template, buildOrderSmsValues({
            order: { ...current, name: { ...current.name, first: firstName } },
            domain,
            store
        }))

        const claimed = await DL.Order.updateOne(
            {
                id: current.id,
                [`notifications.orderSmsSent.${stage}`]: { $exists: false }
            },
            { $set: { [`notifications.orderSmsSent.${stage}`]: new Date() } }
        )
        if (!claimed) return null

        let result
        try {
            result = await external.sms.send([current.phone], message, { domainId: domain.id })
        } catch (error) {
            await DL.Order.Model.updateOne(
                { id: current.id },
                { $unset: { [`notifications.orderSmsSent.${stage}`]: 1 } }
            ).catch(() => { })
            console.error(`[order-sms] ${stage} send failed for order ${current.id}:`, error?.message || error)
            return null
        }

        const update = {
            $push: {
                messages: {
                    phone: current.phone,
                    messageId: result?.shipment_id != null ? String(result.shipment_id) : undefined,
                    type: 'sms',
                    message,
                    date: new Date(),
                    source: `order:sms:${stage}`,
                    adminId
                }
            }
        }
        if (!result?.stubbed) update.$inc = { 'notifications.notifyUserSms': 1 }
        await DL.Order.Model.updateOne({ id: current.id }, update).catch(() => { })

        return result
    } catch (error) {
        console.error(`[order-sms] ${stage} failed for order ${order?.id}:`, error?.message || error)
        return null
    }
}
