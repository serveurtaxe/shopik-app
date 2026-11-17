import { round2 } from '../calcOrder/utils.js'
import { cleanText, formatQuantity } from './format.js'
import { findReplacement, isReplacedLine } from '../cartReplacements.js'
import hebrewTexts from '../../texts/hebrew.json' with { type: 'json' }

export const DEFAULT_NOTE_LIMIT = 5
export const DEFAULT_NOTE_LENGTH = 500

// The note is printed on a Hebrew (RTL) document, so its wording lives in
// hebrew.json (keys below) instead of inline. In RTL the ordered item sits on
// the right and its replacement on the left, so the arrow between them must
// point left (`←`) — `→` reads as the swap happening backwards.
const texts = hebrewTexts.texts || {}

function text(key, fallback, params) {
    const template = texts[key] || fallback
    if (!params) return template
    return String(template).replace(/\[(\w+)\]/g, (_, name) =>
        params[name] !== undefined && params[name] !== null ? String(params[name]) : `[${name}]`
    )
}

function replacementEntry(cart, line) {
    const replacement = findReplacement(cart, line)
    if (!replacement) return null
    const from = [cleanText(line.name, 120), formatQuantity(line.amount, line.unit)].filter(Boolean).join(' ')
    const to = [cleanText(replacement.name, 120), formatQuantity(replacement.finalAmount ?? replacement.amount, replacement.unit)].filter(Boolean).join(' ')
    return text('invoice_note_replaced', 'הוחלף: [from] ← [to]', { from, to })
}

function missingEntry(line) {
    const name = cleanText(line.name, 120)
    const qty = formatQuantity(line.amount, line.unit)
    return text('invoice_note_missing', 'לא סופק: [name]', { name: [name, qty].filter(Boolean).join(' ') })
}

function couponEntries(coupons) {
    return (coupons || [])
        .filter(c => c && Number(c.discount) > 0)
        .map(c => {
            const name = cleanText(c.name || c.code || c.title || c.couponName, 80)
            const amount = round2(Number(c.discount)).toFixed(2)
            return name
                ? text('invoice_note_coupon', 'קופון [name]: -[amount]', { name, amount })
                : text('invoice_note_coupon_plain', 'קופון: -[amount]', { amount })
        })
}

/**
 * The note printed on the invoice (`comment` in the EZcount payload).
 *
 * It describes what changed between the order and what was actually supplied:
 * replacements, items that were not supplied, and the coupon discount that is
 * applied either as a single document discount or as an explicit discount on
 * the line rows (never folded into the unit prices). Raw picker data
 * (`missingReason`, picker names) never reaches the document.
 *
 * Capped at `maxLines` entries plus a pointer to the order; the EZcount comment
 * length limit is still unverified, so the total length is capped too.
 *
 * @returns {string} empty string when there is nothing to say
 */
export function buildInvoiceNotes({
    cart = [],
    coupons = [],
    orderNumber,
    include = {},
    maxLines = DEFAULT_NOTE_LIMIT,
    maxLength = DEFAULT_NOTE_LENGTH
} = {}) {
    const wanted = { replaced: true, missing: true, coupon: true, ...include }
    const entries = []

    if (wanted.replaced) {
        for (const line of cart || []) {
            if (!line?.missing) continue
            if (!isReplacedLine(line)) continue
            const entry = replacementEntry(cart, line)
            // A replaced original whose replacement line is gone is not a
            // replacement any more — fall through to the missing wording.
            if (entry) entries.push(entry)
            else if (wanted.missing) entries.push(missingEntry(line))
        }
    }

    if (wanted.missing) {
        for (const line of cart || []) {
            if (!line?.missing || isReplacedLine(line)) continue
            entries.push(missingEntry(line))
        }
    }

    if (wanted.coupon) entries.push(...couponEntries(coupons))

    if (!entries.length) return ''

    const summary = orderNumber != null && String(orderNumber).trim()
        ? text('invoice_note_summary', 'פרטים מלאים בהזמנה [number]', { number: String(orderNumber).trim() })
        : ''

    const kept = []
    let truncated = false
    for (const entry of entries) {
        if (kept.length >= maxLines) { truncated = true; break }
        const next = [...kept, entry]
        const withSummary = summary ? [...next, summary] : next
        if (withSummary.join('\n').length > maxLength) { truncated = true; break }
        kept.push(entry)
    }

    if (truncated && summary) kept.push(summary)
    return kept.join('\n')
}
