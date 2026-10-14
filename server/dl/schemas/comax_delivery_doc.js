/**
 * Persisted Comax delivery document per Shopik order.
 * Row starts as pending at pack (right after Write_DeliveryDocument returns
 * a DocNumber); the per-line prices are backfilled via
 * Get_DeliveryDocument_All (inline attempt + deliveryDocsSync cron).
 */
const comaxDeliveryLineSchema = {
    line: Number,
    itemId: String,
    itemName: String,
    qty: Number,
    price: Number,
    priceWithVat: Number,
    discount: Number,
    sum: Number,
    sumWithVat: Number,
    _id: false
}

const comaxDeliveryDocSchema = {
    orderId: { type: String, filter: true },
    orderNumber: { type: String, filter: true },
    storeId: { type: String, filter: true },
    docNumber: { type: String, required: true, unique: true, filter: true },
    customerId: String,
    reference: String,
    dateDoc: String,
    status: { type: String, default: 'pending', enum: ['pending', 'fetched', 'failed'], filter: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, filter: true },
    lines: [comaxDeliveryLineSchema],
    totals: {
        total: Number,
        totalBeforeVat: Number,
        _id: false
    },
    fetchedAt: Date,
    error: String
}

export default comaxDeliveryDocSchema
