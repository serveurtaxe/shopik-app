import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildDocPayload, buildInvoiceItems, buildPaymentRow, vatTypeOf, DOC_TYPE, VAT_TYPE } from '../../common/functions/invoice/payload.js'
import { readVatSummary } from '../../common/functions/invoice/summary.js'

const lines = [
    { name: 'Tomatoes', gross: 45, vat: false, quantity: 2, unit: { baseUnit: 'kg' } },
    { name: 'Milk 3%', gross: 90, vat: true, quantity: 3, unit: { baseUnit: 'unit' } },
    { name: 'Shipping', gross: 20, vat: true, quantity: 1 }
]

describe('vatTypeOf', () => {
    it('maps exempt to NON and everything else to INC', () => {
        assert.equal(vatTypeOf(false), VAT_TYPE.EXEMPT)
        assert.equal(vatTypeOf(true), VAT_TYPE.TAXABLE)
        assert.equal(vatTypeOf(undefined), VAT_TYPE.TAXABLE)
    })
})

describe('buildInvoiceItems', () => {
    it('sends actual quantity with unit price as the price', () => {
        const items = buildInvoiceItems(lines)
        assert.deepEqual(items.map(i => i.amount), ['2', '3', '1'])
        assert.deepEqual(items.map(i => i.price), ['22.50', '30.00', '20.00'])
    })

    it('carries the VAT class per line', () => {
        const items = buildInvoiceItems(lines)
        assert.deepEqual(items.map(i => i.vat_type), ['NON', 'INC', 'INC'])
    })

    it('keeps clean description with weight unit if applicable', () => {
        const items = buildInvoiceItems(lines)
        assert.equal(items[0].details, 'Tomatoes (ק"ג)')
        assert.equal(items[1].details, 'Milk 3%')
    })

    it('keeps a negative coupon row and its VAT class', () => {
        const items = buildInvoiceItems([
            { name: 'Coffee', gross: 25, quantity: 2, price: 12.5, vat: true },
            { name: 'קופון first40', gross: -3, quantity: 1, price: -3, vat: false }
        ])
        assert.equal(items.length, 2)
        assert.equal(items[1].price, '-3.00')
        assert.equal(items[1].vat_type, 'NON')
    })

    it('drops zero-gross lines', () => {
        assert.equal(buildInvoiceItems([{ name: 'Zero', gross: 0 }]).length, 0)
    })
})

describe('buildDocPayload', () => {
    const order = { number: 12345, name: 'Order Name', phone: '0501234567', email: 'order@example.com' }
    const customer = { name: { first: 'Dana', last: 'Levi' }, email: 'dana@example.com', taxId: '514123456' }

    it('builds a 320 tax invoice receipt payload', () => {
        const payload = buildDocPayload({ order, lines, customer, idTransaction: 'invoice:o1' })
        assert.equal(payload.type, DOC_TYPE.INVOICE)
        assert.equal(payload.type, 320)
        assert.equal(payload.customer_name, 'Dana Levi')
        assert.equal(payload.customer_email, 'dana@example.com')
        assert.equal(payload.customer_phone, '0501234567')
        assert.equal(payload.customer_crn, '514123456')
        assert.equal(payload.dont_send_email, 'false')
        assert.equal(payload.lang, 'he')
        assert.equal(payload.transaction_id, 'invoice:o1')
        assert.equal(payload.item.length, 3)
    })

    it('uses the credit type and records the original document in the note', () => {
        const payload = buildDocPayload({
            order, lines, customer, docType: DOC_TYPE.CREDIT,
            notes: 'זיכוי לחשבונית 30012'
        })
        assert.equal(payload.type, 330)
        assert.equal(payload.comment, 'זיכוי לחשבונית 30012')
    })

    it('shows the item prices the customer actually paid, VAT included', () => {
        const invoice = buildDocPayload({ order, lines, customer })
        assert.equal(invoice.show_items_including_vat, 1)

        // The credit note mirrors the invoice presentation.
        const credit = buildDocPayload({ order, lines, customer, docType: DOC_TYPE.CREDIT })
        assert.equal(credit.show_items_including_vat, 1)
    })

    it('sends the captured total as price_total on a 320 (mandatory field)', () => {
        const payload = buildDocPayload({
            order, customer,
            lines: [
                { name: 'Coffee', gross: 25, quantity: 2, price: 12.5, vat: true },
                { name: 'קופון first40', gross: -3, quantity: 1, price: -3, vat: true },
                { name: 'Shipping', gross: 20, quantity: 1, price: 20, vat: true }
            ]
        })
        // 2 * 12.50 - 3.00 + 20.00
        assert.equal(payload.price_total, 42)
    })

    it('does not send price_total on a credit note', () => {
        const payload = buildDocPayload({ order, lines, customer, docType: DOC_TYPE.CREDIT })
        assert.equal('price_total' in payload, false)
    })

    it('asks EZcount to auto-balance cent rounding differences on a 320 only', () => {
        const invoice = buildDocPayload({ order, lines, customer })
        assert.equal(invoice.auto_balance, 'true')

        const credit = buildDocPayload({ order, lines, customer, docType: DOC_TYPE.CREDIT })
        assert.equal('auto_balance' in credit, false)
    })

    it('carries the payment row on a 320 and never on a credit note', () => {
        const payment = [buildPaymentRow({ amount: 155, settings: { paymentType: 9, paymentName: 'כרטיס אשראי' } })]
        const invoice = buildDocPayload({ order, lines, customer, payment })
        assert.equal(invoice.payment.length, 1)
        assert.equal(invoice.payment[0].payment_sum, 155)

        const credit = buildDocPayload({ order, lines, customer, docType: DOC_TYPE.CREDIT, payment })
        assert.equal('payment' in credit, false)
    })

    it('never sends card data or settlement fields', () => {
        const payload = buildDocPayload({ order, lines, customer })
        const keys = Object.keys(payload)
        assert.equal(keys.some(k => /card|token|terminal|cvv|^cc_/i.test(k)), false)
        assert.equal(keys.includes('item'), true)
    })

    it('does not ask EZcount to send when there is no email', () => {
        const payload = buildDocPayload({ order: { number: 1 }, lines })
        assert.equal(payload.dont_send_email, 'true')
        assert.equal(payload.customer_email, undefined)
    })

    it('omits the comment when there are no notes', () => {
        const payload = buildDocPayload({ order, lines, customer, notes: '' })
        assert.equal('comment' in payload, false)
    })

    it('applies the configured language and email flag', () => {
        const payload = buildDocPayload({
            order, lines, customer,
            settings: { language: 'en' }, sendEmail: false
        })
        assert.equal(payload.lang, 'en')
        assert.equal(payload.dont_send_email, 'true')
    })
})

describe('buildPaymentRow', () => {
    it('defaults to the neutral "other" payment type', () => {
        const row = buildPaymentRow({ amount: 155, date: new Date(2026, 9, 28) })
        assert.equal(row.payment_type, 9)
        assert.equal(row.payment_sum, 155)
        assert.equal(row.date, '28/10/2026')
        assert.equal(row.other_payment_type_name, 'כרטיס אשראי')
        assert.equal('cc_number' in row, false)
    })

    it('uses the configured type and name', () => {
        const row = buildPaymentRow({ amount: 20.005, settings: { paymentType: 9, paymentName: 'Hyp' }, date: new Date(2026, 0, 5) })
        assert.equal(row.payment_sum, 20.01)
        assert.equal(row.other_payment_type_name, 'Hyp')
        assert.equal(row.date, '05/01/2026')
    })
})

describe('readVatSummary', () => {
    it('copies the provider numbers without recomputing them', () => {
        assert.deepEqual(readVatSummary({ total: 155, vat: 16.78, net: 138.22 }), {
            total: 155, vat: 16.78, net: 138.22
        })
    })

    it('returns partial data as-is', () => {
        assert.deepEqual(readVatSummary({ data: { total_amount: '155.00' } }), {
            total: 155, vat: undefined, net: undefined
        })
    })

    it('returns null when the provider sent no breakdown', () => {
        assert.equal(readVatSummary({ success: true, doc_number: '30012' }), null)
    })
})
