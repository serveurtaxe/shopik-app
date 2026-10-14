// Build a wa.me deep link from a local/ international phone number.
// Local Israeli mobile "05x-xxxxxxx" is normalized to the 9725 country prefix,
// because wa.me rejects the leading zero. Returns '' when there is no number.
export default function whatsappUrl(number) {
    const digits = String(number || '').replace(/[^0-9]/g, '')
    if (!digits) return ''
    return `https://wa.me/${digits.replace(/^0?5/, '9725')}`
}