// Sanitize a free-typed decimal input: digits + single dot, capped decimals.
// Keeps the raw string (no rounding) so typing feels natural.
export default function limitDecimalInput(value, maxDecimals = 3) {
    const v = String(value ?? '').replace(/[^0-9.]/g, '')
    const dot = v.indexOf('.')
    if (dot === -1) return v
    const int = v.slice(0, dot)
    const dec = v.slice(dot + 1).replace(/\./g, '').slice(0, maxDecimals)
    // Preserve a trailing dot so decimals can be typed ("3." stays "3.")
    if (!dec) return v.endsWith('.') ? `${int}.` : int
    return `${int}.${dec}`
}
