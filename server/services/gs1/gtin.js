/**
 * Which codes it is worth asking GS1 about.
 *
 * GS1 keys products by GTIN: 13 digits, or a 12-digit UPC-A written with a
 * leading zero. Comax item codes (1001004) and short internal barcodes are not
 * GTINs, and a typo'd EAN is not either — asking costs a request that can only
 * answer "not in our account", and the answer would be stored under a barcode
 * that is not a barcode. So every GS1 enqueue goes through this filter first.
 *
 * EAN-8 is deliberately excluded: nothing in our catalog or in gs1_products
 * uses it, and how GS1 pads an 8-digit code is unverified.
 */

// Weights run from the check digit outwards: 3,1,3,1… That makes a 13-digit
// EAN start at 1 and a 12-digit UPC start at 3, which is why validating the
// zero-padded form is enough for both.
function checksumOk(digits) {
    let sum = 0
    for (let i = 0; i < digits.length - 1; i++)
        sum += Number(digits[i]) * ((digits.length - 1 - i) % 2 === 0 ? 1 : 3)
    return (10 - sum % 10) % 10 === Number(digits[digits.length - 1])
}

/**
 * @returns the GS1 lookup code (13 digits) for a plausible GTIN, else null.
 */
export function gtinOf(code) {
    const raw = String(code ?? '').trim()
    if (!/^\d{12,13}$/.test(raw)) return null
    const gtin = raw.length === 12 ? `0${raw}` : raw
    return checksumOk(gtin) ? gtin : null
}

export default { gtinOf }
