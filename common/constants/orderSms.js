export const ORDER_SMS_CATEGORY = 'notifications'
export const ORDER_SMS_SUB_CATEGORY = 'order-sms'

export const ORDER_SMS_STAGES = [
    { key: 'paid', label: 'Order received', description: 'Sent after a successful payment.' },
    { key: 'picking', label: 'Picking started', description: 'Sent when an operator starts picking the order.' },
    { key: 'shipped', label: 'On the way / ready', description: 'Sent when the order leaves the store or is ready for pickup.' },
    { key: 'done', label: 'Delivered / picked up', description: 'Sent when the order is completed.' }
]

export const ORDER_SMS_METHODS = [
    { key: 'delivery', label: 'Delivery' },
    { key: 'pickup', label: 'Pickup' }
]

export const ORDER_SMS_TEMPLATE_KEYS = {
    delivery: {
        paid: 'order_sms_paid_delivery',
        picking: 'order_sms_picking_delivery',
        shipped: 'order_sms_shipped_delivery',
        done: 'order_sms_done_delivery'
    },
    pickup: {
        paid: 'order_sms_paid_pickup',
        picking: 'order_sms_picking_pickup',
        shipped: 'order_sms_shipped_pickup',
        done: 'order_sms_done_pickup'
    }
}

export const ORDER_SMS_VARIABLES = [
    { key: 'customer_first_name', label: 'Customer first name' },
    { key: 'order_number', label: 'Order number' },
    { key: 'delivery_date', label: 'Delivery / pickup date' },
    { key: 'delivery_window_start', label: 'Window start' },
    { key: 'delivery_window_end', label: 'Window end' },
    { key: 'order_link', label: 'Order link' },
    { key: 'pickup_store_name', label: 'Pickup store name' }
]

export const DEFAULT_ORDER_SMS_TEMPLATES = {
    delivery: {
        paid: `{{customer_first_name}}, ההזמנה שלך נקלטה בהצלחה! מספר הזמנה: {{order_number}}. מועד אספקה: {{delivery_date}} בין {{delivery_window_start}} ל-{{delivery_window_end}}. תודה שקנית בשפע קליק!`,
        picking: `{{customer_first_name}}, ההזמנה שלך בהכנה! מספר הזמנה: {{order_number}}. מועד אספקה: {{delivery_date}} בין {{delivery_window_start}} ל-{{delivery_window_end}}.`,
        shipped: `{{customer_first_name}}, ההזמנה שלך בדרך אליך! מספר הזמנה: {{order_number}}. מועד אספקה: {{delivery_date}} בין {{delivery_window_start}} ל-{{delivery_window_end}}.`,
        done: `{{customer_first_name}}, ההזמנה שלך נמסרה בהצלחה! מספר הזמנה: {{order_number}}. תודה שקנית בשפע קליק! לכל שאלה ניתן לפנות אלינו בוואטסאפ: 0552903627.`
    },
    pickup: {
        paid: `{{customer_first_name}}, ההזמנה שלך נקלטה בהצלחה! מספר הזמנה: {{order_number}}. האיסוף מתוכנן ליום {{delivery_date}} בין {{delivery_window_start}} ל-{{delivery_window_end}} בשפע קליק - {{pickup_store_name}}.`,
        picking: `{{customer_first_name}}, ההזמנה שלך בהכנה! מספר הזמנה: {{order_number}}. האיסוף מתוכנן ליום {{delivery_date}} בין {{delivery_window_start}} ל-{{delivery_window_end}} בשפע קליק - {{pickup_store_name}}.`,
        shipped: `{{customer_first_name}}, ההזמנה שלך מוכנה לאיסוף! מספר הזמנה: {{order_number}}. ניתן לאסוף ביום {{delivery_date}} בין {{delivery_window_start}} ל-{{delivery_window_end}} בשפע קליק - {{pickup_store_name}}.`,
        done: `{{customer_first_name}}, ההזמנה שלך נמסרה בהצלחה! מספר הזמנה: {{order_number}}. תודה שקנית בשפע קליק! לכל שאלה ניתן לפנות אלינו בוואטסאפ: 0552903627.`
    }
}

export function getOrderSmsMethod(order) {
    return order?.deliveryMethod === 'pickup' ? 'pickup' : 'delivery'
}

export function getOrderSmsTemplateKey(method, stage) {
    return ORDER_SMS_TEMPLATE_KEYS[method]?.[stage] || null
}

export function getDefaultOrderSmsTemplate(method, stage) {
    return DEFAULT_ORDER_SMS_TEMPLATES[method]?.[stage] || ''
}
