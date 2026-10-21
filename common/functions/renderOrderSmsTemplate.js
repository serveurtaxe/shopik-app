export default function renderOrderSmsTemplate(template, values = {}) {
    return String(template ?? '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
        if (!Object.prototype.hasOwnProperty.call(values, key)) return match
        return String(values[key] ?? '')
    })
}
