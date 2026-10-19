import { applySales } from './applySales.js'
import { round2, round3, SALE_KINDS, safeGet } from './utils.js'
import { calcShipping } from '../shipping.js'

function getSaleKind(kind, amount) {
    if (kind === SALE_KINDS.PRICE && amount > 1) {
        return SALE_KINDS.AMOUNT
    }
    return kind
}

function transformSales(saleIds, salesMap) {
    if (!saleIds || !Array.isArray(saleIds)) return []
    return saleIds.map(id => {
        const sale = salesMap[id]
        if (!sale) return null
        return {
            saleId: sale.id,
            kind: getSaleKind(sale.kind, sale.amount),
            amount: sale.amount,
            price: sale.price,
            percent: sale.percent,
            receive: sale.receive || {},
            barcodes: sale.barcodes || [],
            limit: sale.limit,
            start: new Date(sale.start),
            end: new Date(sale.end),
            name: sale.name,
            displayName: sale.displayName,
            code: sale.code
        }
    }).filter(Boolean)
}

function normalizeProduct(cartProduct, salesMap) {
    const unitType = cartProduct.unit?.type
    const inWeight = unitType === 'weight'

    let amount = cartProduct.amount
    const optionAmount = cartProduct.unit?.option?.amount
    const units = cartProduct.unit?.units
    if (optionAmount && units && inWeight) {
        amount = round3(units * optionAmount)
    }

    const orderPrice = (cartProduct.orderPrice >= 0) ? cartProduct.orderPrice : cartProduct.price
    const finalAmount = cartProduct.finalAmount !== undefined ? cartProduct.finalAmount : amount

    // Ensure amount is handled exactly
    amount = round3(amount)
    const availableAmount = round3(finalAmount)

    return {
        ...cartProduct,
        id: cartProduct.id,
        name: cartProduct.name,
        barcode: cartProduct.barcode,
        amount,
        finalAmount: cartProduct.finalAmount,
        availableAmount,
        totalAvailableAmount: availableAmount,
        // Ordered qty remaining — the sale-threshold basis. At checkout it
        // equals the packed qty; at pick time finalAmount can differ and the
        // threshold is met by what the customer ordered (or supplied,
        // whichever is higher — see isSaleEligible), while consumption stays
        // limited to what was actually packed.
        orderAvailable: amount,
        price: cartProduct.price,
        orderPrice,
        unit: cartProduct.unit || {},
        unitType,
        sales: transformSales(cartProduct.saleIds, salesMap),
        pricesDistribution: [],
        missing: cartProduct.missing ?? false,
        replacedBy: cartProduct.replacedBy || null
    }
}

function computeTotals(processedProducts, { shippingConfig, deliveryMethod } = {}) {
    let sumBeforeDiscounts = 0
    let sumAfterSales = 0
    const cart = []

    for (const p of processedProducts) {
        if (p.replacedBy || p.missing) {
            cart.push({ ...p, finalAmount: 0 })
            continue
        }

        sumBeforeDiscounts += p.amount * p.orderPrice
        for (const dist of p.pricesDistribution) {
            sumAfterSales += dist.sum
        }
        cart.push(p)
    }

    sumBeforeDiscounts = round2(sumBeforeDiscounts)
    const sum = round2(sumAfterSales)
    const sumBeforeCoupon = sum // Ignoring coupons logic for now
    const salesDiscount = round2(sumBeforeDiscounts - sumBeforeCoupon)
    const productsSave = round2(sumBeforeDiscounts - sum)

    // Shipping based on sum (pre-coupon) per spec: if sum >= freeFrom => free
    const shipping = calcShipping({ sum, deliveryMethod, shippingConfig })
    const sumWithShipping = round2(sum + shipping)
    const sumNoCouponWithShipping = round2(sumBeforeDiscounts + shipping)

    return {
        sumBeforeDiscounts,
        sumBeforeCoupon,
        sum,
        salesDiscount,
        productsSave,
        shipping,
        sumWithShipping,
        sumNoCouponWithShipping,
        cart
    }
}

export function calcOrderSum({ cart, sales, shippingConfig, deliveryMethod }) {
    const products = cart.map(p => normalizeProduct(p, sales))

    const uniqueSales = Object.values(products.reduce((acc, p) => {
        for (const s of p.sales) acc[s.saleId] = s
        return acc
    }, {}))

    const { processedProducts, saleDetails } = applySales({ products, sales: uniqueSales })
    const totals = computeTotals(processedProducts, { shippingConfig, deliveryMethod })

    return {
        processedCart: totals.cart,
        totals,
        cartSaleDetails: saleDetails
    }
}

export default calcOrderSum
