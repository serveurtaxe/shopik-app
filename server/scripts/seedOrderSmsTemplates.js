/**
 * Seed order SMS templates (idempotent, safe to re-run).
 * Usage:
 *   node server/scripts/runSeed.js seedOrderSmsTemplates
 *   node server/scripts/runSeed.js seedOrderSmsTemplates <domainId>
 *
 * Creates only missing settings and never overwrites edited templates.
 * Stored hidden under category 'notifications' / subCategory 'order-sms' so
 * only the admin SMS Templates page manages them per domain.
 */
import {
    DEFAULT_ORDER_SMS_TEMPLATES,
    ORDER_SMS_CATEGORY,
    ORDER_SMS_METHODS,
    ORDER_SMS_SUB_CATEGORY,
    ORDER_SMS_TEMPLATE_KEYS
} from '#common/constants/orderSms.js'

export default async function seedOrderSmsTemplates({ DL }) {
    const domainFilter = process.argv[3]
    const domains = await DL.Domain.read(
        domainFilter ? { id: domainFilter } : {},
        { _id: 0, id: 1, name: 1 },
        { limit: 0 }
    )
    if (!domains?.length) {
        console.log('[orderSmsTemplates] no domains found, nothing to seed')
        return
    }

    let created = 0
    for (const domain of domains) {
        for (const method of ORDER_SMS_METHODS) {
            for (const [stage, key] of Object.entries(ORDER_SMS_TEMPLATE_KEYS[method.key])) {
                const existing = await DL.Setting.readOne({ domainId: domain.id, key })
                if (existing) {
                    if (!existing.hidden)
                        await DL.Setting.updateOne({ id: existing.id }, { hidden: true })
                    continue
                }
                await DL.Setting.create({
                    key,
                    value: DEFAULT_ORDER_SMS_TEMPLATES[method.key][stage],
                    domainId: domain.id,
                    category: ORDER_SMS_CATEGORY,
                    subCategory: ORDER_SMS_SUB_CATEGORY,
                    formType: 'textarea',
                    renderType: 'string',
                    public: false,
                    hidden: true
                })
                created++
            }
        }
        console.log(`[orderSmsTemplates] domain ${domain.id} ready`)
    }
    console.log(`[orderSmsTemplates] Done - ${created} created, rest already existed`)
}
