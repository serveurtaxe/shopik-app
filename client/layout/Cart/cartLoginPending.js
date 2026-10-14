// One-shot intent flag: guest tapped pay on mobile, so the mobile menu
// opened on its login section. After a successful login the cart reopens
// (instead of the desktop-style delivery prompt). Module singleton —
// DigitsInputStep sits outside CartProvider, so context can't reach it.
let pending = false

export function markCartLoginPending() {
    pending = true
}

export function takeCartLoginPending() {
    const was = pending
    pending = false
    return was
}
