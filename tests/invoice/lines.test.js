import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    couponTotalOf,
    collectInvoiceItems,
    allocateCoupon,
    computeUnitPrice,
    buildRoundingLine,
    buildShippingLine,
    buildInvoiceLines,
    invoiceTotal,
    assertTotalsMatch,
    buildCreditLines
} from '../../common/functions/invoice/lines.js'

const mixedCart = () => ([
    { id: '1', barcode: 'T1', name: 'Tomatoes', finalAmount: 2, totalSum: 50, vat: false, unit: { baseUnit: 'kg' } },
    { id: '2', barcode: 'M1', name: 'Milk', finalAmount: 3, totalSum: 100, vat: true, unit: { baseUnit: 'unit' } },
    { id: '3', barcode: 'X1', name: 'Missing', missing: true, finalAmount: 0, totalSum: 0, vat: true }
])

describe('couponTotalOf', () => {
    it('sums the applied discount of every coupon', () => {
        assert.equal(couponTotalOf([{ discount: 10 }, { discount: 5.5 }]), 15.5)
    })

    it('handles missing coupons', () => {
        assert.equal(couponTotalOf(undefined), 0)
        assert.equal(couponTotalOf([]), 0)
    })
})

describe('collectInvoiceItems', () => {
    it('drops missing and zero-gross lines', () => {
        const items = collectInvoiceItems(mixedCart())
        assert.deepEqual(items.map(i => i.name), ['Tomatoes', 'Milk'])
    })

    it('keeps the VAT class snapshot (undefined is taxable for legacy data)', () => {
        const items = collectInvoiceItems([
            { id: 'a', name: 'Exempt', totalSum: 10, finalAmount: 1, vat: false },
            { id: 'b', name: 'Legacy', totalSum: 10, finalAmount: 1 }
        ])
        assert.equal(items[0].vat, false)
        assert.equal(items[1].vat, true)
    })

    it('uses finalAmount (packed quantity), not the ordered amount', () => {
        const [item] = collectInvoiceItems([
            { id: 'a', name: 'Weighted', amount: 5, finalAmount: 2.35, totalSum: 23.5 }
        ])
        assert.equal(item.quantity, 2.35)
        assert.equal(item.gross, 23.5)
    })
})

describe('allocateCoupon', () => {
    it('splits the discount proportionally while keeping the original gross', () => {
        const items = allocateCoupon({ items: collectInvoiceItems(mixedCart()), couponTotal: 15 })
        assert.deepEqual(items.map(i => i.gross), [50, 100])
        assert.deepEqual(items.map(i => i.discount), [5, 10])
        assert.deepEqual(items.map(i => i.netGross), [45, 90])
    })

    it('gives the rounding remainder to the largest line', () => {
        const items = allocateCoupon({
            items: [
                { id: 'a', name: 'A', gross: 33.33, vat: true },
                { id: 'b', name: 'B', gross: 33.33, vat: true },
                { id: 'c', name: 'C', gross: 33.33, vat: true }
            ],
            couponTotal: 10
        })
        const discounts = items.map(i => i.discount)
        assert.equal(Math.round(discounts.reduce((a, b) => a + b, 0) * 100) / 100, 10)
        assert.deepEqual(discounts, [3.34, 3.33, 3.33])
    })

    it('never allocates a discount to an excluded (missing) line', () => {
        const items = allocateCoupon({ items: collectInvoiceItems(mixedCart()), couponTotal: 15 })
        assert.equal(items.some(i => i.name === 'Missing'), false)
    })

    it('clamps the coupon to the included total and ignores zero lines', () => {
        const items = allocateCoupon({
            items: [{ id: 'a', name: 'A', gross: 10, vat: true }],
            couponTotal: 99
        })
        assert.equal(items[0].gross, 10)
        assert.equal(items[0].discount, 10)
        assert.equal(items[0].netGross, 0)
    })
})

describe('computeUnitPrice', () => {
    it('computes exact unit price when divisible', () => {
        assert.equal(computeUnitPrice(50, 2), 25)
        assert.equal(computeUnitPrice(45, 1), 45)
    })

    it('rounds unit price when it does not overshoot line gross', () => {
        // 10 / 3 = 3.3333... -> 3.33 -> 3 * 3.33 = 9.99 <= 10
        assert.equal(computeUnitPrice(10, 3), 3.33)
    })

    it('floors unit price when round2 would overshoot line gross', () => {
        // 20 / 3 = 6.6666... -> round2 would be 6.67 -> 3 * 6.67 = 20.01 > 20 -> floors to 6.66
        assert.equal(computeUnitPrice(20, 3), 6.66)
    })

    it('computes unit price for fractional weights', () => {
        // 1.345 kg at 8.90 = 11.9705 -> gross 11.97. 11.97 / 1.345 = 8.8996... -> 8.90
        assert.equal(computeUnitPrice(11.97, 1.345), 8.90)
    })

    it('handles zero or non-positive quantities safely', () => {
        assert.equal(computeUnitPrice(10, 0), 10)
        assert.equal(computeUnitPrice(10, -1), 10)
    })
})

describe('buildRoundingLine', () => {
    it('creates a positive rounding adjustment line when drift > 0', () => {
        assert.deepEqual(buildRoundingLine(0.02), {
            productId: '__rounding',
            barcode: null,
            name: 'הפרשי עיגול',
            quantity: 1,
            gross: 0.02,
            price: 0.02,
            vat: true,
            discount: 0
        })
    })

    it('returns null when drift is zero or negative', () => {
        assert.equal(buildRoundingLine(0), null)
        assert.equal(buildRoundingLine(-0.01), null)
        assert.equal(buildRoundingLine(undefined), null)
    })
})

describe('buildShippingLine', () => {
    it('is a separate taxable line', () => {
        assert.deepEqual(buildShippingLine(20, { name: 'משלוח' }), {
            productId: '__shipping', barcode: null, name: 'משלוח',
            quantity: 1, gross: 20, price: 20, vat: true, discount: 0
        })
    })

    it('is null when shipping is zero', () => {
        assert.equal(buildShippingLine(0), null)
        assert.equal(buildShippingLine(undefined), null)
    })
})

describe('buildInvoiceLines', () => {
    it('reconciles the served lines + shipping to the captured amount', () => {
        const order = {
            cart: mixedCart(),
            coupons: [{ discount: 15 }],
            finalShipping: 20
        }
        const lines = buildInvoiceLines({ order })
        // Mixed basket: one coupon row per VAT class.
        assert.deepEqual(lines.discountLines.map(l => l.gross), [-10, -5])
        assert.deepEqual(lines.discountLines.map(l => l.vat), [true, false])
        assert.equal(invoiceTotal(lines), 155)
        assert.equal(lines.coupon, 15)
        assert.equal(lines.shippingLine.gross, 20)
        assert.equal(assertTotalsMatch({ ...lines, captured: 155 }), 155)
    })

    it('shows the coupon as a negative row instead of touching item prices', () => {
        const order = {
            cart: [
                { id: 'a', name: 'Coffee', finalAmount: 2, totalSum: 25, vat: true },
                { id: 'b', name: 'Flour', finalAmount: 2, totalSum: 10, vat: false }
            ],
            coupons: [{ name: 'first40', discount: 4.2 }],
            finalShipping: 0
        }
        const lines = buildInvoiceLines({ order })
        // Shelf prices, exactly as the customer saw them.
        assert.deepEqual(lines.items.map(i => i.price), [12.5, 5])
        assert.deepEqual(lines.items.map(i => i.discount), [0, 0])
        // Mixed basket: the coupon splits into a taxable and an exempt row.
        assert.deepEqual(lines.discountLines.map(l => l.gross), [-3, -1.2])
        assert.deepEqual(lines.discountLines.map(l => l.name), ['קופון first40 (חייב)', 'קופון first40 (פטור)'])
        assert.equal(invoiceTotal(lines), 30.8)
        assert.equal(lines.roundingLine, null)
        assert.equal(assertTotalsMatch({ ...lines, captured: 30.8 }), 30.8)
    })

    it('uses one coupon row when every line is taxable', () => {
        const order = {
            cart: [
                { id: 'a', name: 'Coffee', finalAmount: 2, totalSum: 25, vat: true },
                { id: 'b', name: 'Flour', finalAmount: 2, totalSum: 10, vat: true }
            ],
            coupons: [{ name: 'first40', discount: 4.2 }],
            finalShipping: 0
        }
        const lines = buildInvoiceLines({ order })
        assert.deepEqual(lines.items.map(i => i.price), [12.5, 5])
        assert.deepEqual(lines.items.map(i => i.discount), [0, 0])
        assert.equal(lines.discountLines.length, 1)
        assert.equal(lines.discountLines[0].name, 'קופון first40')
        assert.equal(lines.discountLines[0].gross, -4.2)
        assert.equal(invoiceTotal(lines), 30.8)
        assert.equal(assertTotalsMatch({ ...lines, captured: 30.8 }), 30.8)
    })

    it('turns a fully-discounted basket into a zero-total coupon row', () => {
        const order = {
            cart: [{ id: 'a', name: 'Free', finalAmount: 1, totalSum: 10, vat: false }],
            coupons: [{ discount: 10 }],
            finalShipping: 0
        }
        const lines = buildInvoiceLines({ order })
        assert.equal(lines.items[0].price, 10)
        assert.equal(lines.discountLines[0].gross, -10)
        assert.equal(lines.discountLines[0].vat, false)
        assert.equal(invoiceTotal(lines), 0)
    })

    it('creates a rounding line when multi-pack promo creates agora drift', () => {
        const order = {
            cart: [
                { id: '1', barcode: 'Y1', name: 'Yogurt', finalAmount: 3, totalSum: 10, vat: true }
            ],
            coupons: [],
            finalShipping: 0
        }
        const lines = buildInvoiceLines({ order })
        assert.equal(lines.items[0].price, 3.33)
        assert.equal(lines.drift, 0.01)
        assert.ok(lines.roundingLine)
        assert.equal(lines.roundingLine.gross, 0.01)
        assert.equal(lines.total, 10)
        assert.equal(assertTotalsMatch({ ...lines, captured: 10 }), 10)
    })

    it('matches the charge when the coupon leaves an agorah remainder', () => {
        const order = {
            cart: [
                { id: 'a', name: 'A', finalAmount: 1, totalSum: 33.33, vat: true },
                { id: 'b', name: 'B', finalAmount: 1, totalSum: 33.33, vat: false },
                { id: 'c', name: 'C', finalAmount: 1, totalSum: 33.33, vat: true }
            ],
            coupons: [{ discount: 10 }],
            finalShipping: 0
        }
        const lines = buildInvoiceLines({ order })
        assert.equal(invoiceTotal(lines), 89.99)
    })

    it('does not reconcile when the captured amount was computed differently', () => {
        const order = { cart: mixedCart(), coupons: [], finalShipping: 20 }
        assert.throws(
            () => assertTotalsMatch({ ...buildInvoiceLines({ order }), captured: 999 }),
            /does not match captured/
        )
    })
})

describe('buildCreditLines', () => {
    it('looks the VAT class up from the order line and keeps shipping taxable', () => {
        const lines = buildCreditLines({
            refundItems: [
                { productId: '1', barcode: 'T1', name: 'Tomatoes', amount: 15 },
                { productId: '__shipping', name: 'shipping', amount: 5 }
            ],
            cart: mixedCart()
        })
        assert.equal(lines[0].vat, false)
        assert.equal(lines[1].vat, true)
        assert.equal(lines[0].gross, 15)
        assert.equal(lines[1].gross, 5)
    })

    it('turns a general refund into a taxable standalone credit line', () => {
        const lines = buildCreditLines({
            refundItems: [{ productId: '__general', name: 'general', amount: 25 }],
            cart: mixedCart()
        })
        assert.equal(lines.length, 1)
        assert.equal(lines[0].name, 'החזר כללי')
        assert.equal(lines[0].gross, 25)
        assert.equal(lines[0].vat, true)
    })
})
