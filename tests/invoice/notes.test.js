import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildInvoiceNotes } from '../../common/functions/invoice/notes.js'
import hebrewTexts from '../../common/texts/hebrew.json' with { type: 'json' }

const replacementCart = () => ([
    {
        barcode: 'P1', name: 'Potatoes', amount: 2, missing: true,
        missingReason: 'replaced', replacedBy: 'S1',
        unit: { baseUnit: 'kg' }
    },
    {
        barcode: 'S1', name: 'Prepared salad', amount: 2,
        replacement: { originalBarcode: 'P1' }, unit: { baseUnit: 'unit' }
    },
    {
        barcode: 'T1', name: 'Tomatoes', amount: 1, missing: true,
        missingReason: 'missing', unit: { baseUnit: 'kg' }
    }
])

describe('buildInvoiceNotes', () => {
    it('describes replacements, missing items and the coupon', () => {
        const notes = buildInvoiceNotes({
            cart: replacementCart(),
            coupons: [{ name: 'SAVE10', discount: 15 }],
            orderNumber: 12345
        })
        assert.equal(notes, [
            'הוחלף: Potatoes 2 ק"ג ← Prepared salad 2 יח\'',
            'לא סופק: Tomatoes 1 ק"ג',
            'קופון SAVE10: הנחה 15.00 ₪'
        ].join('\n'))
    })

    it('never leaks raw missingReason values or picker wording', () => {
        const notes = buildInvoiceNotes({ cart: replacementCart(), orderNumber: 1 })
        assert.equal(/missing|replaced/i.test(notes), false)
    })

    it('omits the replaced wording when the replacement line is gone', () => {
        const cart = [{
            barcode: 'P1', name: 'Potatoes', amount: 2, missing: true,
            missingReason: 'replaced', unit: { baseUnit: 'kg' }
        }]
        const notes = buildInvoiceNotes({ cart, orderNumber: 1 })
        assert.equal(notes, 'לא סופק: Potatoes 2 ק"ג')
    })

    it('recognises a replacement even when only the cart link is set', () => {
        const cart = [
            { barcode: 'A', name: 'Original', amount: 2, missing: true, replacedBy: 'B', unit: { baseUnit: 'unit' } },
            { barcode: 'B', name: 'Replacement', amount: 2, finalAmount: 2, replacement: { originalBarcode: 'A' }, unit: { baseUnit: 'unit' } }
        ]
        const notes = buildInvoiceNotes({ cart, orderNumber: 1 })
        assert.equal(notes, "הוחלף: Original 2 יח' ← Replacement 2 יח'")
    })

    it('uses the replacement line quantity, not the original one', () => {
        const cart = [
            { barcode: 'A', name: 'Original', amount: 3, missing: true, missingReason: 'replaced', unit: { baseUnit: 'unit' } },
            { barcode: 'B', name: 'Replacement', amount: 1, finalAmount: 1, replacement: { originalBarcode: 'A' }, unit: { baseUnit: 'unit' } }
        ]
        const notes = buildInvoiceNotes({ cart, orderNumber: 1 })
        assert.equal(notes, 'הוחלף: Original 3 יח\' ← Replacement 1 יח\'')
    })

    it('keeps each entry on one line and strips control characters', () => {
        const cart = [{
            barcode: 'X', name: 'Bad\nName\tWith\u0007Controls', amount: 1,
            missing: true, missingReason: 'missing', unit: { baseUnit: 'unit' }
        }]
        const notes = buildInvoiceNotes({ cart, orderNumber: 1 })
        assert.equal(notes.includes('\n'), false)
        assert.equal(notes, 'לא סופק: Bad Name With Controls 1 יח\'')
    })

    it('caps the list at five entries and points at the order', () => {
        const cart = Array.from({ length: 8 }, (_, i) => ({
            barcode: `B${i}`, name: `Item ${i}`, amount: 1, missing: true,
            missingReason: 'missing', unit: { baseUnit: 'unit' }
        }))
        const notes = buildInvoiceNotes({ cart, orderNumber: 777 })
        const lines = notes.split('\n')
        assert.equal(lines.length, 6)
        assert.equal(lines[5], 'פרטים מלאים בהזמנה 777')
        assert.equal(lines[4], 'לא סופק: Item 4 1 יח\'')
    })

    it('respects the include toggles', () => {
        const notes = buildInvoiceNotes({
            cart: replacementCart(),
            coupons: [{ name: 'SAVE10', discount: 15 }],
            orderNumber: 1,
            include: { missing: false }
        })
        assert.equal(notes, [
            'הוחלף: Potatoes 2 ק"ג ← Prepared salad 2 יח\'',
            'קופון SAVE10: הנחה 15.00 ₪'
        ].join('\n'))
    })

    it('returns an empty string when there is nothing to report', () => {
        assert.equal(buildInvoiceNotes({ cart: [], coupons: [], orderNumber: 1 }), '')
    })

    it('takes its wording from hebrew.json', () => {
        const texts = hebrewTexts.texts
        const original = texts.invoice_note_replaced
        texts.invoice_note_replaced = 'הוחלף: [from] <- [to]'
        try {
            const notes = buildInvoiceNotes({ cart: replacementCart(), orderNumber: 1 })
            assert.equal(notes.split('\n')[0], 'הוחלף: Potatoes 2 ק"ג <- Prepared salad 2 יח\'')
        } finally {
            texts.invoice_note_replaced = original
        }
    })

    it('caps the total length and still points at the order', () => {
        const cart = [
            { barcode: 'A', name: 'A'.repeat(120), amount: 1, missing: true, missingReason: 'missing', unit: { baseUnit: 'unit' } },
            { barcode: 'B', name: 'B'.repeat(120), amount: 1, missing: true, missingReason: 'missing', unit: { baseUnit: 'unit' } }
        ]
        const notes = buildInvoiceNotes({ cart, orderNumber: 1, maxLength: 100 })
        assert.ok(notes.length <= 100)
        assert.ok(notes.endsWith('פרטים מלאים בהזמנה 1'))
    })
})
