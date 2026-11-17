import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { issueInvoice, issueCreditNote, retryInvoice } from '../../server/utils/data/invoice.js'

// ---- Minimal in-memory DL -------------------------------------------------
// The invoice orchestration only needs create/read/update + dot-path updates;
// keeping it here (instead of pulling Mongo) makes the provider contract the
// only thing under test.

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

function getPath(doc, path) {
    return String(path).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), doc)
}

function setPath(doc, path, value) {
    const keys = String(path).split('.')
    let current = doc
    for (let i = 0; i < keys.length - 1; i++) {
        if (current[keys[i]] == null || typeof current[keys[i]] !== 'object') current[keys[i]] = {}
        current = current[keys[i]]
    }
    current[keys[keys.length - 1]] = value
}

function matches(doc, filter = {}) {
    for (const [key, expected] of Object.entries(filter)) {
        const actual = getPath(doc, key)
        if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
            if ('$in' in expected && !expected.$in.includes(actual)) return false
            if ('$ne' in expected && actual === expected.$ne) return false
            if ('$exists' in expected && (actual !== undefined) !== expected.$exists) return false
            if ('$lt' in expected && !(actual < expected.$lt)) return false
            if ('$gt' in expected && !(actual > expected.$gt)) return false
            continue
        }
        if (actual !== expected) return false
    }
    return true
}

function applyUpdate(doc, update) {
    for (const [key, value] of Object.entries(update || {})) {
        if (key === '$set') {
            for (const [path, set] of Object.entries(value)) setPath(doc, path, set)
        } else if (key === '$inc') {
            for (const [path, inc] of Object.entries(value)) setPath(doc, path, (Number(getPath(doc, path)) || 0) + Number(inc))
        } else if (key === '$push') {
            for (const [path, pushed] of Object.entries(value)) {
                const arr = getPath(doc, path) || []
                arr.push(...(Array.isArray(pushed) ? pushed : [pushed]))
                setPath(doc, path, arr)
            }
        } else if (key === '$unset') {
            for (const path of Object.keys(value)) setPath(doc, path, undefined)
        } else {
            setPath(doc, key, value)
        }
    }
    doc.updatedAt = new Date()
    return doc
}

function collection() {
    const docs = []
    let seq = 0
    const api = {
        docs,
        async create(data) {
            const doc = { id: `id${++seq}`, createdAt: new Date(), ...clone(data) }
            docs.push(doc)
            return clone(doc)
        },
        async readOne(filter = {}) {
            const doc = docs.find(d => matches(d, filter))
            return doc ? clone(doc) : null
        },
        async readById(id) {
            const doc = docs.find(d => d.id === id)
            return doc ? clone(doc) : null
        },
        async read(filter = {}) {
            return docs.filter(d => matches(d, filter)).map(clone)
        },
        async updateOne(filter = {}, update = {}) {
            const doc = docs.find(d => matches(d, filter))
            if (!doc) return null
            applyUpdate(doc, update)
            return clone(doc)
        }
    }
    return api
}

function makeFakeDL({ settings } = {}) {
    const Invoice = collection()
    const Order = collection()
    const PaymentTransaction = collection()
    const Setting = collection()

    if (settings) Setting.docs.push({ id: 'setting1', ...settings })

    return {
        Invoice,
        Order: {
            docs: Order.docs,
            Model: {
                updateOne: (filter, update) => Order.updateOne(filter, update)
            }
        },
        PaymentTransaction: {
            docs: PaymentTransaction.docs,
            Model: {
                updateMany: async () => ({ modifiedCount: 0 }),
                updateOne: (filter, update) => PaymentTransaction.updateOne(filter, update)
            },
            constants: {
                TRANSACTION_KIND: { CAPTURE: 'capture', REFUND: 'refund' },
                TRANSACTION_STATUS: { SUCCESS: 'success' }
            }
        },
        Timeline: {
            constants: {
                EVENT_TYPES: {
                    INVOICE_ISSUED: 'invoice_issued',
                    INVOICE_FAILED: 'invoice_failed',
                    CREDIT_ISSUED: 'credit_issued',
                    CREDIT_FAILED: 'credit_failed'
                }
            }
        },
        Setting
    }
}

const ENABLED_SETTING = {
    key: 'ezcount',
    domainId: 'd1',
    value: { enabled: true, apiKey: 'key', developerEmail: 'dev@example.com' }
}

const events = []
const utils = {
    data: {
        timeline: {
            record: async (entry) => { events.push(entry) }
        }
    }
}

beforeEach(() => { events.length = 0 })

const orderFixture = () => ({
    id: 'o1',
    number: 12345,
    domainId: 'd1',
    userId: 'u1',
    name: { first: 'Dana', last: 'Levi' },
    phone: '0501234567',
    email: 'dana@example.com',
    deliveryMethod: 'delivery',
    finalShipping: 20,
    coupons: [{ code: 'SAVE10', name: 'SAVE10', discount: 15 }],
    cart: [
        { id: '1', barcode: 'T1', name: 'Tomatoes', finalAmount: 2, totalSum: 50, vat: false, unit: { baseUnit: 'kg' } },
        { id: '2', barcode: 'M1', name: 'Milk', finalAmount: 3, totalSum: 100, vat: true, unit: { baseUnit: 'unit' } },
        { id: '3', barcode: 'X1', name: 'Basil', finalAmount: 1, totalSum: 0, missing: true, vat: true }
    ]
})

function fakeExternal(result) {
    const calls = []
    return {
        calls,
        ezcount: {
            createDoc: async (args) => {
                calls.push(args)
                return typeof result === 'function' ? result(args) : result
            }
        }
    }
}

const OK_RESPONSE = {
    ok: true,
    docId: 'uuid-1',
    docNumber: '30012',
    docUrl: 'https://demo.ezcount.co.il/doc/30012.pdf',
    raw: { success: true, doc_number: '30012', total: 155, vat: 16.78, net: 138.22 }
}

// ---------------------------------------------------------------------------

describe('issueInvoice', () => {
    it('is skipped when EZcount is disabled', async () => {
        const DL = makeFakeDL({ settings: { key: 'ezcount', domainId: 'd1', value: { enabled: false } } })
        const external = fakeExternal(OK_RESPONSE)
        const result = await issueInvoice({ DL, external, utils, order: orderFixture(), captured: 155 })
        assert.deepEqual(result, { skipped: 'disabled' })
        assert.equal(external.calls.length, 0)
    })

    it('creates a 320 document for the captured amount and links it everywhere', async () => {
        const DL = makeFakeDL({ settings: ENABLED_SETTING })
        DL.PaymentTransaction.docs.push({ id: 'txn1', orderId: 'o1', kind: 'capture', status: 'success', amount: 155 })
        DL.Order.docs.push({ id: 'o1', number: 12345 })
        const external = fakeExternal(OK_RESPONSE)

        const record = await issueInvoice({
            DL, external, utils, order: orderFixture(), captured: 155
        })

        assert.equal(record.status, 'issued')
        assert.equal(record.docNumber, '30012')

        // Provider payload: one document, mixed VAT classes, exact gross.
        assert.equal(external.calls.length, 1)
        const payload = external.calls[0].payload
        assert.equal(payload.type, 320)
        assert.equal(payload.transaction_id, 'invoice:o1')
        assert.equal(payload.dont_send_email, 'false')
        assert.equal(payload.customer_email, 'dana@example.com')
        assert.equal(payload.price_total, 155)
        assert.equal(payload.payment[0].payment_sum, 155)
        assert.equal(payload.show_items_including_vat, 1)
        assert.deepEqual(payload.item.map(i => i.vat_type), ['NON', 'INC', 'INC', 'NON', 'INC', 'INC'])
        assert.deepEqual(payload.item.map(i => i.amount), ['2', '3', '1', '1', '1', '1'])
        // Unit prices are the pre-coupon shelf prices.
        assert.deepEqual(payload.item.map(i => i.price), ['25.00', '33.33', '-10.00', '-5.00', '20.00', '0.01'])
        // Mixed basket: one coupon row per VAT class.
        assert.deepEqual(payload.item.filter(i => i.price.startsWith('-')).map(i => i.vat_type), ['INC', 'NON'])
        assert.equal(payload.item.length, 6)

        // Local record + order mirror.
        assert.equal(DL.Invoice.docs.length, 1)
        assert.equal(DL.Invoice.docs[0].status, 'issued')
        assert.equal(DL.Invoice.docs[0].idempotencyKey, 'invoice:o1')
        assert.deepEqual(DL.Invoice.docs[0].vatBreakdown, { total: 155, vat: 16.78, net: 138.22 })
        assert.equal(DL.Order.docs[0].invoice.number, '30012')
        assert.equal(DL.Order.docs[0].invoice.status, 'issued')
        assert.equal(DL.Order.docs[0].vatBreakdown.total, 155)
        assert.ok(events.some(e => e.eventType === 'invoice_issued'))
    })

    it('uses one document-level coupon line for an all-taxable basket', async () => {
        const DL = makeFakeDL({ settings: ENABLED_SETTING })
        const external = fakeExternal(OK_RESPONSE)
        const order = orderFixture()
        order.cart = [
            { id: '1', barcode: 'T1', name: 'Tomatoes', finalAmount: 2, totalSum: 50, vat: true },
            { id: '2', barcode: 'M1', name: 'Milk', finalAmount: 3, totalSum: 100, vat: true }
        ]

        const record = await issueInvoice({ DL, external, utils, order, captured: 155 })

        assert.equal(record.status, 'issued')
        const payload = external.calls[0].payload
        // One coupon row instead of a discount on every item.
        const coupon = payload.item.find(i => i.price === '-15.00')
        assert.ok(coupon)
        assert.equal(coupon.details, 'קופון SAVE10')
        assert.equal(coupon.vat_type, 'INC')
        assert.deepEqual(payload.item.map(i => i.price), ['25.00', '33.33', '-15.00', '20.00', '0.01'])
        assert.equal(payload.price_total, 155)
    })

    it('does not create a second document for the same order', async () => {
        const DL = makeFakeDL({ settings: ENABLED_SETTING })
        const external = fakeExternal(OK_RESPONSE)

        await issueInvoice({ DL, external, utils, order: orderFixture(), captured: 155 })
        const second = await issueInvoice({ DL, external, utils, order: orderFixture(), captured: 155 })

        assert.equal(external.calls.length, 1)
        assert.equal(second.status, 'issued')
        assert.equal(DL.Invoice.docs.length, 1)
    })

    it('records a provider failure without throwing, then retries', async () => {
        const DL = makeFakeDL({ settings: ENABLED_SETTING })
        const external = fakeExternal({ ok: false, error: 'customer not found', raw: { error: 'customer not found' } })

        const failed = await issueInvoice({ DL, external, utils, order: orderFixture(), captured: 155 })
        assert.equal(failed.status, 'failed')
        assert.equal(failed.error, 'customer not found')
        assert.ok(events.some(e => e.eventType === 'invoice_failed'))

        external.ezcount.createDoc = async () => OK_RESPONSE
        const retried = await retryInvoice({
            DL, external, utils, order: orderFixture(), record: failed
        })
        assert.equal(retried.status, 'issued')
        assert.equal(DL.Invoice.docs.length, 1)
        assert.equal(DL.Invoice.docs[0].attempts || 0, 0)
    })

    it('refuses to silently change an already issued document amount', async () => {
        const DL = makeFakeDL({ settings: ENABLED_SETTING })
        const external = fakeExternal(OK_RESPONSE)
        const order = orderFixture()
        order.invoice = undefined

        await issueInvoice({ DL, external, utils, order, captured: 155 })
        const changed = await issueInvoice({ DL, external, utils, order, captured: 175 })

        assert.equal(external.calls.length, 1)
        assert.equal(changed.status, 'issued')
        assert.ok(events.some(e => e.eventType === 'invoice_failed'
            && e.context?.step === 'invoice_amount_changed'))
    })

    it('flags a mismatched captured amount as failed instead of printing a wrong total', async () => {
        const DL = makeFakeDL({ settings: ENABLED_SETTING })
        const external = fakeExternal(OK_RESPONSE)
        const failed = await issueInvoice({ DL, external, utils, order: orderFixture(), captured: 160 })
        assert.equal(failed.status, 'failed')
        assert.match(failed.error, /does not match captured/)
        assert.equal(external.calls.length, 0)
    })

    it('asks for customer details above the CRN threshold', async () => {
        const DL = makeFakeDL({
            settings: { key: 'ezcount', domainId: 'd1', value: { ...ENABLED_SETTING.value, crnThreshold: 100 } }
        })
        const external = fakeExternal(OK_RESPONSE)
        const order = orderFixture()
        const record = await issueInvoice({ DL, external, utils, order, captured: 155 })
        assert.equal(record.status, 'pending_customer_details')
        assert.equal(external.calls.length, 0)
    })

    it('sends the customer tax id and company name from the checkout request', async () => {
        const DL = makeFakeDL({
            settings: { key: 'ezcount', domainId: 'd1', value: { ...ENABLED_SETTING.value, crnThreshold: 100 } }
        })
        const external = fakeExternal(OK_RESPONSE)
        const order = {
            ...orderFixture(),
            invoiceRequest: { required: true, taxId: '514123456', companyName: 'Shopik Ltd', email: 'billing@example.com' }
        }
        await issueInvoice({ DL, external, utils, order, captured: 155 })
        const payload = external.calls[0].payload
        assert.equal(payload.customer_crn, '514123456')
        assert.equal(payload.customer_name, 'Shopik Ltd')
        assert.equal(payload.customer_email, 'billing@example.com')
    })
})

describe('issueCreditNote', () => {
    async function issueAndGetInvoice() {
        const DL = makeFakeDL({ settings: ENABLED_SETTING })
        DL.PaymentTransaction.docs.push({ id: 'txn1', orderId: 'o1', kind: 'capture', status: 'success', amount: 155 })
        const external = fakeExternal(OK_RESPONSE)
        await issueInvoice({ DL, external, utils, order: orderFixture(), captured: 155 })
        return { DL, external }
    }

    it('offsets the invoice with a linked 330 credit note', async () => {
        const { DL, external } = await issueAndGetInvoice()
        const refundItems = [
            { productId: '1', barcode: 'T1', name: 'Tomatoes', amount: 15 },
            { productId: '__shipping', name: 'shipping', amount: 5 }
        ]

        const credit = await issueCreditNote({
            DL, external, utils, order: orderFixture(),
            refundItems, amount: 20, refundTxnId: 'r1'
        })

        assert.equal(credit.status, 'issued')
        assert.equal(credit.kind, 'credit')
        assert.equal(credit.linkedDocNumber, '30012')
        assert.equal(credit.idempotencyKey, 'credit:o1:r1')

        const payload = external.calls[1].payload
        assert.equal(payload.type, 330)
        assert.equal(payload.transaction_id, 'credit:o1:r1')
        assert.equal(payload.parent, 'uuid-1')
        assert.equal('price_total' in payload, false)
        assert.equal('payment' in payload, false)
        assert.equal(payload.show_items_including_vat, 1)
        assert.deepEqual(payload.item.map(i => i.vat_type), ['NON', 'INC'])
        assert.deepEqual(payload.item.map(i => i.price), ['15.00', '5.00'])
        assert.match(payload.comment, /30012/)

        assert.ok(events.some(e => e.eventType === 'credit_issued'))
    })

    it('does not issue a credit note before an invoice exists', async () => {
        const DL = makeFakeDL({ settings: ENABLED_SETTING })
        const external = fakeExternal(OK_RESPONSE)
        const result = await issueCreditNote({
            DL, external, utils, order: orderFixture(),
            refundItems: [{ productId: '1', name: 'Tomatoes', amount: 10 }],
            amount: 10, refundTxnId: 'r1'
        })
        assert.deepEqual(result, { skipped: 'no_invoice' })
        assert.equal(external.calls.length, 0)
    })

    it('requires line attribution for a mixed basket', async () => {
        const { DL, external } = await issueAndGetInvoice()
        const record = await issueCreditNote({
            DL, external, utils, order: orderFixture(),
            refundItems: [], amount: 10, refundTxnId: 'r1'
        })
        assert.equal(record.status, 'failed')
        assert.match(record.error, /line attribution/)
        assert.equal(external.calls.length, 1)
    })

    it('keeps the invoice issued when a credit note fails', async () => {
        const DL = makeFakeDL({ settings: ENABLED_SETTING })
        DL.PaymentTransaction.docs.push({ id: 'txn1', orderId: 'o1', kind: 'capture', status: 'success', amount: 155 })
        DL.Order.docs.push({ id: 'o1', number: 12345 })
        const external = fakeExternal(OK_RESPONSE)
        await issueInvoice({ DL, external, utils, order: orderFixture(), captured: 155 })
        external.ezcount.createDoc = async () => ({ ok: false, error: 'provider down', raw: {} })

        const failed = await issueCreditNote({
            DL, external, utils, order: orderFixture(),
            refundItems: [{ productId: '1', barcode: 'T1', name: 'Tomatoes', amount: 15 }],
            amount: 15, refundTxnId: 'r1'
        })

        assert.equal(failed.status, 'failed')
        const order = DL.Order.docs[0]
        // The tax invoice is still a valid document — only its offset is missing.
        assert.equal(order.invoice.status, 'issued')
        assert.ok(!order.invoice.error)
        assert.equal(order.invoice.creditError, 'provider down')
        assert.ok(events.some(e => e.eventType === 'credit_failed'))
        assert.ok(!events.some(e => e.eventType === 'invoice_failed'))
    })

    it('is idempotent per refund transaction', async () => {
        const { DL, external } = await issueAndGetInvoice()
        const args = {
            DL, external, utils, order: orderFixture(),
            refundItems: [{ productId: '1', name: 'Tomatoes', amount: 15 }],
            amount: 15, refundTxnId: 'r1'
        }
        await issueCreditNote(args)
        await issueCreditNote(args)
        assert.equal(external.calls.length, 2) // invoice + one credit
        assert.equal(DL.Invoice.docs.filter(d => d.kind === 'credit').length, 1)
    })
})

describe('retrying an existing record', () => {
    // Found live: a record that failed under an older payload kept no `request`,
    // and after the successful retry it stayed empty — the issued document had
    // no audit trail. Retries must refresh the snapshot they were sent with.
    it('refreshes the stored payload on an invoice retry', async () => {
        const DL = makeFakeDL({ settings: ENABLED_SETTING })
        DL.PaymentTransaction.docs.push({ id: 'txn1', orderId: 'o1', kind: 'capture', status: 'success', amount: 155 })
        DL.Order.docs.push({ id: 'o1', number: 12345 })
        const failed = await DL.Invoice.create({
            domainId: 'd1', orderId: 'o1', orderNumber: 12345, userId: 'u1',
            kind: 'invoice', provider: 'ezcount', status: 'failed', amount: 155,
            idempotencyKey: 'invoice:o1'
        })

        const record = await issueInvoice({
            DL, external: fakeExternal(OK_RESPONSE), utils,
            order: orderFixture(), captured: 155, force: true
        })

        assert.equal(record.status, 'issued')
        const stored = await DL.Invoice.readOne({ id: failed.id })
        assert.equal(stored.request.transaction_id, 'invoice:o1')
        assert.equal(stored.request.price_total, 155)
        assert.equal(stored.request.show_items_including_vat, 1)
        assert.deepEqual(stored.request.item.map(i => i.vat_type), ['NON', 'INC', 'INC', 'NON', 'INC', 'INC'])
        assert.equal(stored.items.length, 6)
        // The snapshot records the coupon rows that were sent.
        assert.deepEqual(
            stored.items.filter(i => i.productId === '__discount').map(i => i.gross),
            [-10, -5]
        )
        assert.equal(stored.amount, 155)
    })

    it('refreshes the stored payload and link on a credit retry', async () => {
        const DL = makeFakeDL({ settings: ENABLED_SETTING })
        DL.PaymentTransaction.docs.push({ id: 'txn1', orderId: 'o1', kind: 'capture', status: 'success', amount: 155 })
        DL.Order.docs.push({ id: 'o1', number: 12345 })
        const external = fakeExternal(OK_RESPONSE)
        await issueInvoice({ DL, external, utils, order: orderFixture(), captured: 155 })

        const failed = await DL.Invoice.create({
            domainId: 'd1', orderId: 'o1', orderNumber: 12345, userId: 'u1',
            kind: 'credit', provider: 'ezcount', status: 'failed', amount: 15,
            idempotencyKey: 'credit:o1:r1'
        })

        const credit = await issueCreditNote({
            DL, external, utils, order: orderFixture(),
            refundItems: [{ productId: '1', name: 'Tomatoes', amount: 15 }],
            amount: 15, refundTxnId: 'r1', force: true
        })

        assert.equal(credit.status, 'issued')
        const stored = await DL.Invoice.readOne({ id: failed.id })
        assert.equal(stored.request.parent, 'uuid-1')
        assert.equal(stored.request.transaction_id, 'credit:o1:r1')
        assert.equal(stored.linkedInvoiceId, DL.Invoice.docs[0].id)
        assert.equal(stored.items.length, 1)
    })
})
