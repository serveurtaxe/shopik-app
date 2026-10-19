import { round2 } from '#common/functions/calcOrder/utils.js'

/**
 * Snapshot current supplier cost onto the order cart.
 * Source: local ComaxProduct.supplierPrice by barcode (nightly import).
 * Qty basis: finalAmount (packed qty), missing/zero lines get supplierSum 0.
 * Fail-open: unknown barcodes get supplierPrice null and count as missing.
 * Returns { cart, supplierTotal, supplierMissingCount, supplierCapturedAt }
 * without persisting — caller merges into its $set.
 */
export async function snapshotSupplierCost({ DL, order }) {
    const cart = Array.isArray(order.cart) ? order.cart : []
    const barcodes = [...new Set(cart.map(l => String(l?.barcode || '').trim()).filter(Boolean))]
    let byBarcode = new Map()
    try {
        if (barcodes.length) {
            const rows = await DL.ComaxProduct.read(
                { barcode: { $in: barcodes } },
                { _id: 0, barcode: 1, supplierPrice: 1 },
                { limit: 0 }
            )
            byBarcode = new Map((rows || []).map(r => [String(r.barcode), r]))
        }
    } catch {}
    const capturedAt = new Date()
    let supplierTotal = 0
    let supplierMissingCount = 0
    const nextCart = cart.map(l => {
        const qty = l?.missing ? 0 : Number(l?.finalAmount ?? l?.amount ?? 0)
        const q = Number.isFinite(qty) && qty > 0 ? qty : 0
        const row = byBarcode.get(String(l?.barcode || '').trim())
        const sp = row?.supplierPrice != null && Number.isFinite(Number(row.supplierPrice)) ? Number(row.supplierPrice) : null
        if (q > 0 && sp == null) supplierMissingCount += 1
        const supplierSum = sp != null ? round2(sp * q) : 0
        if (q > 0) supplierTotal = round2(supplierTotal + supplierSum)
        return { ...l, supplierPrice: sp, supplierSum }
    })
    return { cart: nextCart, supplierTotal, supplierMissingCount, supplierCapturedAt: capturedAt }
}

export default snapshotSupplierCost
