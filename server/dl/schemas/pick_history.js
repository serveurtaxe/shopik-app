/**
 * pick_history — per-pick interaction log used to learn store layout and replacement quality.
 * One doc per cart-item handling event (scan / weight / replace / missing) plus an order-level summary.
 */
const pickHistorySchema = {
    orderId: { type: String, required: true, filter: true },
    storeId: { type: String, required: true, filter: true },
    adminId: { type: String, required: true, filter: true },
    adminName: String,
    // item-level
    barcode: { type: String, filter: true },
    productId: String,
    productName: String,
    categoryId: String,
    categoryPathIds: [String],
    storageType: String,
    action: {
        type: String,
        enum: ['scan', 'weight', 'replace', 'missing', 'complete', 'pack', 'reset'],
        required: true,
        filter: true
    },
    amount: Number,
    finalAmount: Number,
    // replacement tracking
    replacedBarcode: String,      // original barcode that was replaced
    replacementBarcode: String,   // new barcode chosen
    replacementReason: String,
    // layout learning — sequence within the order
    seq: Number,                  // order in which picker handled this item
    totalItems: Number,           // snapshot of order size
    pickedAt: { type: Date, default: Date.now, filter: true },
    windowDate: String,           // denormalized window.date for daily analysis
    // duration inside picker
    pickStart: Date,
    pickEnd: Date
}

export const meta = {
    index: [
        { storeId: 1, adminId: 1, pickedAt: -1 },
        { barcode: 1, action: 1 },
        { replacedBarcode: 1, replacementBarcode: 1 },
        { storeId: 1, categoryId: 1 },
        { orderId: 1 }
    ]
}

export default pickHistorySchema
