import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import renderOrderSmsTemplate from '../../common/functions/renderOrderSmsTemplate.js'
import {
    DEFAULT_ORDER_SMS_TEMPLATES,
    ORDER_SMS_TEMPLATE_KEYS,
    ORDER_SMS_VARIABLES
} from '../../common/constants/orderSms.js'
import { buildOrderSmsValues, sendOrderStageSms } from '../../server/utils/data/orderSms.js'

function createHarness({ send } = {}) {
    const order = {
        id: 'o1',
        number: '100245',
        phone: '0501234567',
        domainId: 'd1',
        deliveryMethod: 'pickup',
        storeId: 's1',
        storeName: 'Fallback store',
        name: { first: 'דוד' },
        window: { date: '2026-10-22', start: 14, end: 16 },
        notifications: {}
    }
    const domain = { id: 'd1', url: 'shefa.click' }
    const store = { id: 's1', name: 'סניף ירושלים' }
    const calls = { sends: [], writes: [] }
    const DL = {
        Order: {
            readById: async () => order,
            updateOne: async (filter, update) => {
                const path = `notifications.orderSmsSent.${'paid'}`
                if (filter[path]?.$exists === false) {
                    if (order.notifications.orderSmsSent?.paid) return null
                    order.notifications.orderSmsSent = { ...order.notifications.orderSmsSent, paid: new Date() }
                    return order
                }
                calls.writes.push({ filter, update })
                return order
            },
            Model: {
                updateOne: async (filter, update) => {
                    calls.writes.push({ filter, update })
                    if (update.$unset?.['notifications.orderSmsSent.paid'])
                        delete order.notifications.orderSmsSent.paid
                    return order
                }
            }
        },
        Domain: {
            readById: async () => domain,
            readOne: async () => domain
        },
        Setting: { readOne: async () => ({ value: 'Hi {{customer_first_name}} at {{pickup_store_name}}' }) },
        Store: { readById: async () => store },
        User: { readById: async () => ({ name: { first: 'דוד' } }) }
    }
    const external = {
        sms: {
            send: async (phones, message, opts) => {
                calls.sends.push({ phones, message, opts })
                if (send) return send(phones, message, opts)
                return { shipment_id: 123 }
            }
        }
    }
    return { DL, external, order, calls }
}

describe('renderOrderSmsTemplate', () => {
    it('replaces known placeholders and preserves unknown ones', () => {
        const rendered = renderOrderSmsTemplate(
            '{{customer_first_name}} / {{order_number}} / {{unknown}}',
            { customer_first_name: 'דוד', order_number: '100245' }
        )
        assert.equal(rendered, 'דוד / 100245 / {{unknown}}')
    })
})

describe('buildOrderSmsValues', () => {
    it('formats dates, hours, link, and pickup store name', () => {
        const values = buildOrderSmsValues({
            order: {
                number: '100245',
                name: { first: 'דוד' },
                window: { date: '2026-10-22', start: 9, end: 11 }
            },
            domain: { url: 'https://shefa.click/' },
            store: { name: 'סניף ירושלים' }
        })
        assert.deepEqual(values, {
            customer_first_name: 'דוד',
            order_number: '100245',
            delivery_date: '22/10/2026',
            delivery_window_start: '09:00',
            delivery_window_end: '11:00',
            order_link: 'https://shefa.click/account/orders',
            pickup_store_name: 'סניף ירושלים'
        })
    })
})

describe('order SMS defaults', () => {
    it('covers every stage for delivery and pickup', () => {
        for (const method of ['delivery', 'pickup']) {
            assert.deepEqual(
                Object.keys(DEFAULT_ORDER_SMS_TEMPLATES[method]),
                Object.keys(ORDER_SMS_TEMPLATE_KEYS[method])
            )
            for (const template of Object.values(DEFAULT_ORDER_SMS_TEMPLATES[method]))
                assert.ok(template.length > 0)
        }
        assert.equal(Object.keys(ORDER_SMS_TEMPLATE_KEYS.pickup).length, 4)
        assert.ok(DEFAULT_ORDER_SMS_TEMPLATES.delivery.done.includes('0552903627'))
        assert.ok(DEFAULT_ORDER_SMS_TEMPLATES.pickup.shipped.includes('{{pickup_store_name}}'))
        assert.ok(ORDER_SMS_VARIABLES.some(variable => variable.key === 'pickup_store_name'))
    })
})

describe('sendOrderStageSms', () => {
    it('sends pickup template with domainId and records the message once', async () => {
        const { DL, external, calls } = createHarness()
        const first = await sendOrderStageSms({ DL, external, order: { id: 'o1' }, stage: 'paid' })
        const second = await sendOrderStageSms({ DL, external, order: { id: 'o1' }, stage: 'paid' })

        assert.deepEqual(first, { shipment_id: 123 })
        assert.equal(second, null)
        assert.equal(calls.sends.length, 1)
        assert.equal(calls.sends[0].message, 'Hi דוד at סניף ירושלים')
        assert.deepEqual(calls.sends[0].opts, { domainId: 'd1' })
        const push = calls.writes.find(call => call.update.$push)
        assert.ok(push.update.$push.messages)
        assert.equal(push.update.$push.messages.source, 'order:sms:paid')
        assert.deepEqual(push.update.$inc, { 'notifications.notifyUserSms': 1 })
    })

    it('clears the claim when sending fails so a later attempt can retry', async () => {
        let attempts = 0
        const { DL, external, order, calls } = createHarness({
            send: async () => {
                attempts++
                if (attempts === 1) throw new Error('provider down')
                return { shipment_id: 456 }
            }
        })
        const first = await sendOrderStageSms({ DL, external, order: { id: 'o1' }, stage: 'paid' })
        assert.equal(first, null)
        assert.equal(order.notifications.orderSmsSent.paid, undefined)
        assert.ok(calls.writes.some(call => call.update.$unset))

        const second = await sendOrderStageSms({ DL, external, order: { id: 'o1' }, stage: 'paid' })
        assert.deepEqual(second, { shipment_id: 456 })
        assert.equal(attempts, 2)
    })

    it('falls back to the default template when the domain has no setting', async () => {
        const { DL, external, calls } = createHarness()
        DL.Setting.readOne = async () => null
        await sendOrderStageSms({ DL, external, order: { id: 'o1' }, stage: 'paid' })
        assert.ok(calls.sends[0].message.includes('100245'))
    })
})
