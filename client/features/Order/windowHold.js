// Client mirror of the server's window-hold rule. The server always sends
// `window.holdUntil`; the reservedAt fallback only covers carts created
// before the hold field existed.
export const WINDOW_HOLD_MINUTES = 30
const MINUTE_MS = 60 * 1000
const HOLD_MS = WINDOW_HOLD_MINUTES * MINUTE_MS

function timestamp(value) {
    if (!value) return null
    const t = new Date(value).getTime()
    return Number.isNaN(t) ? null : t
}

export function holdDeadline(window) {
    if (!window?.id) return null
    const explicit = timestamp(window.holdUntil)
    if (explicit != null) return explicit
    const reservedAt = timestamp(window.reservedAt)
    if (reservedAt == null) return null
    const fullHold = reservedAt + HOLD_MS
    const lead = timestamp(window.leadTimestamp)
    return lead == null ? fullHold : Math.min(fullHold, lead)
}

export function isHoldExpired(window, now = Date.now()) {
    const deadline = holdDeadline(window)
    if (deadline != null) return deadline <= now
    // No hold information (legacy cart): fall back to the lead-time rule.
    const lead = timestamp(window?.leadTimestamp)
    return lead != null && lead < now
}
