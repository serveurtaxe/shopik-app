import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getLineSummary, getOrderSummary } from '../../common/functions/orderSummary.js'

// The order screen must add up from the stored order alone: a sale that no
// longer exists in the catalog is still on the line's priceDistribution, and a
// line that was not supplied never contributes money even though its checkout
// totalSum is still on the document.

// The order from the bug report (10000084): 4 energy drinks under "4 ב-11"
// plus 5 regular ones. Unit prices alone (4×3.9 + 5×62.9 = 330.10) do not
// explain the 325.50 products total; the 4.60 sale does.
const SAMPLE_ORDER = {
    id: 'sample',
    number: 10000084,
    status: 'paid',
    sum: 325.5,
    sumNoCoupon: 330.1,
    finalSum: 325.5,
    finalSumWithShipping: 328.49,
    shipping: 2.99,
    finalShipping: 2.99,
    cart: [
        {
            id: 'p1', barcode: 'A1', name: 'משקה אנרגיה', price: 3.9, amount: 4,
            totalSum: 11, regularSum: 0, saleSum: 11, saleIds: ['123496252'],
            priceDistribution: [{
                type: 'sale', totalSum: 11, amount: 4,
                saleName: 'משקה אנרגיה בלו 250מ״ל 4 ב-11', salePrice: 2.75,
                saleId: '123496252', saleKind: 'amount', saleAmount: 4
            }]
        },
        {
            id: 'p2', barcode: 'A2', name: 'עלית הארק', price: 62.9, amount: 5,
            totalSum: 314.5, regularSum: 314.5, saleSum: 0, saleIds: [],
            priceDistribution: [{ type: 'regular', totalSum: 314.5, amount: 5, saleName: '', salePrice: 62.9 }]
        }
    ]
}

function couponOrder(overrides = {}) {
    return {
        id: 'coupon', number: 10000082, status: 'packed', paid: true,
        sum: 280, finalSum: 230, finalSumWithShipping: 232.99,
        shipping: 2.99, finalShipping: 2.99,
        coupons: [{ code: 'SAVE50', discount: 50, appliedDiscount: 50 }],
        cart: [
            {
                id: 'c1', barcode: 'C1', name: 'sale line', price: 10, amount: 4,
                totalSum: 30,
                priceDistribution: [{ type: 'sale', totalSum: 30, amount: 4, saleName: '4 ב-30', salePrice: 7.5 }]
            },
            {
                id: 'c2', barcode: 'C2', name: 'regular line', price: 50, amount: 5,
                totalSum: 250,
                priceDistribution: [{ type: 'regular', totalSum: 250, amount: 5, saleName: '', salePrice: 50 }]
            }
        ],
        ...overrides
    }
}

describe('getLineSummary', () => {
    it('reads the sale from the line and keeps the charged total', () => {
        const line = getLineSummary(SAMPLE_ORDER.cart[0])
        assert.equal(line.units, 4)
        assert.equal(line.regular, 15.6)
        assert.equal(line.charged, 11)
        assert.equal(line.saved, 4.6)
        assert.equal(line.supplied, true)
        assert.deepEqual(line.sales.map(sale => sale.name), ['4 ב-11'])
        // The whole line is on the sale, so its unit price is the bundle's own.
        assert.equal(line.sales[0].perUnit, 2.75)
    })

    it('uses the supplied amount after picking and the ordered amount before it', () => {
        const line = {
            price: 10, amount: 3, finalAmount: 2, totalSum: 20,
            priceDistribution: [{ type: 'regular', totalSum: 20, amount: 2, salePrice: 10 }]
        }
        const finalized = getLineSummary(line)
        assert.equal(finalized.units, 2)
        assert.equal(finalized.regular, 20)
        assert.equal(finalized.charged, 20)

        const open = getLineSummary(line, { finalized: false })
        assert.equal(open.units, 2)
        assert.equal(open.charged, 20)
    })

    it('never charges a line that was not supplied', () => {
        const line = getLineSummary({
            price: 10, amount: 2, missing: true, totalSum: 20,
            priceDistribution: [{ type: 'regular', totalSum: 20, amount: 2, salePrice: 10 }]
        })
        assert.equal(line.notSupplied, true)
        assert.equal(line.units, 0)
        assert.equal(line.charged, 0)
        assert.equal(line.saved, 0)
    })

    it('leaves an unpriced replacement line out of the money', () => {
        const line = getLineSummary({ price: 6.9, amount: 6, status: 'admin_add', finalAmount: 6 })
        assert.equal(line.priced, false)
        assert.equal(line.charged, 0)
    })
})

describe('getOrderSummary', () => {
    it('explains the sample order with the sale it already got', () => {
        const summary = getOrderSummary(SAMPLE_ORDER)
        assert.equal(summary.itemsCount, 2)
        assert.equal(summary.productsBeforeSales, 330.1)
        assert.equal(summary.saleSavings, 4.6)
        assert.equal(summary.productsAfterSales, 325.5)
        assert.equal(summary.shipping, 2.99)
        assert.equal(summary.charged, 328.49)
        assert.equal(summary.netAfterRefunds, 328.49)
    })

    it('subtracts the coupon after the sale, not before it', () => {
        const summary = getOrderSummary(couponOrder())
        assert.equal(summary.productsBeforeSales, 290)
        assert.equal(summary.saleSavings, 10)
        assert.equal(summary.productsAfterSales, 280)
        assert.equal(summary.couponTotal, 50)
        assert.equal(summary.afterDiscounts, 230)
        assert.equal(summary.charged, 232.99)
        assert.equal(summary.hasCoupons, true)
    })

    it('keeps the net after refunds as the last word', () => {
        const summary = getOrderSummary(couponOrder({ refundedTotal: 30, refundPending: 10 }))
        assert.equal(summary.hasRefunds, true)
        assert.equal(summary.charged, 232.99)
        assert.equal(summary.refundedTotal, 30)
        assert.equal(summary.netAfterRefunds, 202.99)
        assert.equal(summary.refundPending, 10)
    })

    it('counts a replacement pair once and drops the original money', () => {
        const summary = getOrderSummary({
            status: 'done', sum: 18, finalSum: 18, finalSumWithShipping: 18,
            shipping: 0, finalShipping: 0,
            cart: [
                {
                    barcode: 'A', name: 'original', price: 10, amount: 2, missing: true,
                    missingReason: 'replaced', replacedBy: 'B', totalSum: 20,
                    priceDistribution: [{ type: 'regular', totalSum: 20, amount: 2, salePrice: 10 }]
                },
                {
                    barcode: 'B', name: 'replacement', price: 9, amount: 2, finalAmount: 2,
                    totalSum: 18, replacement: { originalBarcode: 'A' },
                    priceDistribution: [{ type: 'regular', totalSum: 18, amount: 2, salePrice: 9 }]
                }
            ]
        })
        assert.equal(summary.itemsCount, 1)
        assert.equal(summary.productsBeforeSales, 18)
        assert.equal(summary.saleSavings, 0)
        assert.equal(summary.productsAfterSales, 18)
        assert.equal(summary.charged, 18)
    })

    it('keeps the checkout total while picking is still open', () => {
        const summary = getOrderSummary({
            status: 'picking', sum: 50, sumNoCoupon: 115.2, finalSum: 50,
            finalSumWithShipping: 52.99, shipping: 2.99, finalShipping: 2.99,
            cart: [
                {
                    price: 5.9, amount: 6, finalAmount: 0, missing: true, totalSum: 10,
                    priceDistribution: [{ type: 'sale', totalSum: 10, amount: 6, saleName: 'sale', salePrice: 1.6667 }]
                },
                {
                    price: 39.9, amount: 2, finalAmount: 0, missing: true, totalSum: 40,
                    priceDistribution: [{ type: 'sale', totalSum: 40, amount: 2, saleName: 'sale', salePrice: 20 }]
                },
                // the picker added a replacement, not priced until pick_complete
                { price: 6.9, amount: 6, status: 'admin_add', finalAmount: 6 }
            ]
        })
        assert.equal(summary.productsAfterSales, 50)
        assert.equal(summary.charged, 52.99)
        assert.equal(summary.itemsCount, 3)
    })

    it('falls back to the stored total when the cart carries no money', () => {
        const summary = getOrderSummary({
            status: 'done', sum: 0, finalSum: 0, finalSumWithShipping: 12.9,
            shipping: 0, finalShipping: 0, cart: []
        })
        assert.equal(summary.productsAfterSales, 0)
        assert.equal(summary.charged, 12.9)
    })
})
