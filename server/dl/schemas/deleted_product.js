import mongoose from 'mongoose'

// Recycle bin for product docs removed by the barcode-alias import.
//
// The import deletes the doc whose barcode became another product's scan alias
// (otherwise the same barcode would resolve to two products). Deleting
// outright loses everything the doc carried — images, GS1 fields, price
// history — so the whole raw document is kept here first, together with the
// owner it was merged into and the owner's alias list *before* the merge. That
// is everything `scripts/restoreDeletedProducts.js` needs to put the catalog
// back exactly as it was.
const deletedProductSchema = {
    // The deleted product's own barcode (now an alias of `mainBarcode`).
    barcode: {
        type: String,
        required: true,
        trim: true,
        filter: 'exact',
        index: true
    },
    productId: String,
    // The complete document as it was stored (findById(...).lean()).
    product: {
        type: mongoose.Schema.Types.Mixed,
        required: true
    },
    // The product whose scannableBarcodes absorbed `barcode`.
    mainBarcode: {
        type: String,
        trim: true,
        filter: 'exact',
        index: true
    },
    // Owner aliases before the import, so a restore removes only what it added.
    previousScannableBarcodes: { type: [String], default: [] },
    reason: String,
    deletedBy: String,
    deletedAt: { type: Date, default: Date.now },
    // Set by scripts/restoreDeletedProducts.js. The snapshot stays as an audit
    // trail; a restored row is never inserted twice.
    restoredAt: Date
}

export const meta = {
    index: [
        { barcode: 1, deletedAt: -1 },
        { mainBarcode: 1, deletedAt: -1 }
    ]
}

export default deletedProductSchema
