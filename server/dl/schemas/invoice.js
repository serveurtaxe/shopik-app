const INVOICE_KIND = { INVOICE: 'invoice', CREDIT: 'credit' }
const INVOICE_STATUS = {
    PENDING: 'pending',
    ISSUED: 'issued',
    FAILED: 'failed',
    PENDING_CUSTOMER_DETAILS: 'pending_customer_details'
}

// Source of truth / audit trail for every document issued through EZcount.
// `idempotencyKey` is unique, so a retried capture or refund can never create
// a second document.
const invoiceSchema = {
    domainId: String,
    orderId: { type: String, filter: true },
    orderNumber: { type: String, filter: true },
    userId: { type: String, filter: true },
    kind: {
        type: String,
        enum: Object.values(INVOICE_KIND),
        filter: true
    },
    provider: { type: String, default: 'ezcount' },
    docId: String,
    docNumber: { type: String, filter: true },
    docUrl: String,
    docType: Number,
    status: {
        type: String,
        enum: Object.values(INVOICE_STATUS),
        default: INVOICE_STATUS.PENDING,
        filter: true
    },
    amount: Number,
    // Copied from the provider response — never calculated here.
    vatBreakdown: Object,
    items: [{
        _id: false,
        productId: String,
        barcode: String,
        name: String,
        quantity: Number,
        gross: Number,
        price: Number,
        vat: Boolean
    }],
    notes: String,
    // Credit notes only: the invoice they offset.
    linkedInvoiceId: String,
    linkedDocNumber: String,
    refundTxnId: { type: String, filter: true },
    idempotencyKey: { type: String, unique: true },
    // EZcount sends the document; we record who we asked it to send to.
    email: {
        to: String,
        requestedAt: Date
    },
    request: Object,
    response: Object,
    error: String,
    attempts: { type: Number, default: 0, filter: true },
    lastAttemptAt: Date,
    issuedAt: Date
}

const index = [
    { orderId: 1, kind: 1 },
    { docId: 1 },
    { status: 1 },
    { status: 1, attempts: 1 }
]

export const meta = {
    constants: { INVOICE_KIND, INVOICE_STATUS },
    index
}

export default invoiceSchema
