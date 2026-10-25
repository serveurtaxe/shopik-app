import { calcOrderSum } from './index.js'
import { round2 } from './utils.js'
import { isCouponEligible } from '../coupon.js'

export const CART_PRODUCT_STATUS = {
    ADMIN_ADD: 'admin_add',
    CLIENT_ADD: 'client_add'
}

export function buildCartProduct({ product, amount, unitKey, domainId, existingStatus }) {
    // Single price source: the server resolves the domain price into a flat
    // `price` before the product reaches this code (public endpoints via
    // withDomainPrice, cart items at order build time). The `prices` array
    // never leaves the server for storefront traffic.
    // The `domainId` lookup below is a server-side fallback for DB products
    // that still carry the full array; it is never fed by client input
    // (the router overwrites client-supplied domainId). No entry for the
    // domain means the product is not sold there at all — never fall back
    // to another domain's price.
    const domainPrice = domainId ? product.prices?.find(p => p.domainId === domainId)?.price : undefined
    const price = product.price ?? domainPrice
    if (price == null)
        throw { status: 400, message: 'product not available in this domain' }

    let option, units
    const unit = product?.unit
    if (unitKey) {
        option = unit?.options.find(o => o.key === unitKey) || null
        if (!option)
            throw { status: 400, message: 'Unit option does not exist' }
        units = amount
    }

    const calculatedAmount = option?.amount ? round2((units || 1) * option.amount) : amount

    return {
        id: product.id,
        name: product.name,
        barcode: product.barcode,
        amount: calculatedAmount,
        // finalAmount: calculatedAmount,
        price,
        totalPrice: round2(calculatedAmount * price),
        status: existingStatus || CART_PRODUCT_STATUS.CLIENT_ADD,
        saleIds: product.saleIds || [],
        priceDistribution: [],
        missing: false,
        unit: {
            type: unit?.type || 'item',
            baseUnit: unit?.baseUnit || 'unit',
            minAmount: unit?.minAmount || 1,
            step: unit?.step || 1,
            units,
            option
        },
        images: product.images ? {
            product: (product.images.product || []).map(img => ({
                main: !!img.main,
                sourceUrl: img.sourceUrl,
                hash: img.hash,
                sizes: img.sizes ? { xl: img.sizes.xl, l: img.sizes.l, m: img.sizes.m, s: img.sizes.s } : undefined
            })),
            threeSixty: product.images.threeSixty || []
        } : undefined,
        label: product.label,
        producer: product.producer,
        netContentText: product.netContentText,
        category: product.category,
        storageType: product.storageType,
        picking: product.picking ? {
            recommendations: product.picking.recommendations,
            minShelflife: product.picking.minShelflife,
            allowBarcodeTypeIn: product.picking.allowBarcodeTypeIn
        } : undefined,
        updatedAt: new Date()
    }
}

export function applyCalcToCart({ cart, calcResult, activeSalesOnly = false }) {
    for (let i = 0; i < cart.length; i++) {
        const calcProduct = calcResult.processedCart[i]
        if (!calcProduct) continue

        const cartItem = cart[i]

        cartItem.priceDistribution = (calcProduct.pricesDistribution || []).map(dist => ({
            type: dist.saleId ? 'sale' : 'regular',
            totalSum: round2(dist.sum ?? dist.totalSum ?? 0),
            amount: dist.amount,
            saleName: dist.saleName || dist.saleDescription || '',
            salePrice: dist.pricePerUnit ?? dist.salePrice ?? 0,
            saleLimit: dist.saleLimit,
            saleId: dist.saleId,
            saleKind: dist.saleKind,
            saleAmount: dist.saleAmount
        }))

        // Sort priceDistribution so higher unit prices are placed FIRST for refund priority
        cartItem.priceDistribution.sort((a, b) => (b.salePrice || 0) - (a.salePrice || 0))

        let totalSum = 0
        let regularSum = 0
        let saleSum = 0
        const activeSaleIds = new Set()

        for (const dist of cartItem.priceDistribution) {
            totalSum += dist.totalSum
            if (dist.type === 'sale') {
                saleSum += dist.totalSum
                if (dist.saleId) activeSaleIds.add(dist.saleId)
            } else {
                regularSum += dist.totalSum
            }
        }

        cartItem.totalSum = round2(totalSum)
        cartItem.regularSum = round2(regularSum)
        cartItem.saleSum = round2(saleSum)
        if (activeSalesOnly)
            cartItem.saleIds = Array.from(activeSaleIds)
        cartItem.updatedAt = new Date()
    }

    return cart
}

export function calcOrder({ order, product, amount, unitKey, sales, shippingConfig, user, activeSalesOnly = false }) {
    let cart = (order.cart || []).map(item => ({ ...item }))

    if (amount === 0) {
        cart = cart.filter(item => item.id !== product.id)
    } else {
        const existingIndex = cart.findIndex(item => item.id === product.id)
        const cartProduct = buildCartProduct({
            product,
            amount,
            unitKey,
            domainId: order.domainId,
            existingStatus: existingIndex >= 0 ? cart[existingIndex].status : undefined
        })

        if (existingIndex >= 0) {
            cart[existingIndex] = cartProduct
        } else {
            cart.unshift(cartProduct)
        }
    }
    const deliveryMethod = order.deliveryMethod || 'delivery'
    const calcResult = calcOrderSum({ cart, sales: sales || {}, shippingConfig, deliveryMethod })
    applyCalcToCart({ cart, calcResult, activeSalesOnly })

    const shipping = calcResult.totals.shipping
    const sumWithShipping = calcResult.totals.sumWithShipping

    // finalShipping based on sum (pre-coupon) per spec, so same as shipping for client
    // Keep sumWithShipping for client charging; finalSum for coupon-discounted total
    const finalSum = calcResult.totals.sum
    const sumNoCoupon = calcResult.totals.sumBeforeDiscounts

    // Preserve existing coupons: if order has coupons, finalSum should be reduced
    // Respect minSum via isCouponEligible and handle percent recalc
    let resolvedFinalSum = finalSum
    let resolvedFinalShipping = shipping
    let resolvedFinalSumWithShipping = sumWithShipping
    let resolvedCoupons = order.coupons ? [...order.coupons] : []
    if (order.coupons && order.coupons.length) {
        const oldSum = Number(order.sum || 0)
        let totalCouponDiscount = 0
        const updatedCoupons = []
        for (const c of order.coupons) {
            const pseudoCoupon = {
                whitelist: c.whitelist,
                blacklist: c.blacklist,
                dynamic: c.minSum != null || !!c.condition,
                minSum: c.minSum,
                maxSum: c.maxSum,
                condition: c.condition,
            }
            const eligible = isCouponEligible(pseudoCoupon, user, finalSum).eligible
            if (!eligible) {
                // keep coupon but mark inactive – no discount applied
                updatedCoupons.push({ ...c, isActive: false, appliedDiscount: 0 })
                continue
            }
            const storedDiscount = Number(c.discount || 0)
            // For percent coupons storedDiscount is absolute at old sum; derive rate from original coupon data if available
            let newDiscount = 0
            if (c.percent) {
                // Prefer originalDiscount/benefit if available, else derive rate from stored
                if (c.originalDiscount != null || c.benefit === 'percent') {
                    const rate = c.originalDiscount != null ? Number(c.originalDiscount) / 100 : (oldSum > 0 ? storedDiscount / oldSum : 0)
                    newDiscount = round2(finalSum * rate)
                } else {
                    const rate = oldSum > 0 ? storedDiscount / oldSum : 0
                    newDiscount = rate > 0 ? round2(finalSum * rate) : storedDiscount
                }
                if (c.maxSum != null && c.maxSum !== undefined) newDiscount = Math.min(newDiscount, Number(c.maxSum))
                newDiscount = Math.min(newDiscount, finalSum)
            } else {
                newDiscount = Math.min(storedDiscount, finalSum)
            }
            const updated = { ...c, isActive: true, appliedDiscount: newDiscount, discount: newDiscount }
            // Preserve original discount for future recalc if needed
            if (c.originalDiscount == null && c.percent) updated.originalDiscount = c.discount
            updatedCoupons.push(updated)
            totalCouponDiscount += newDiscount
        }
        resolvedFinalSum = Math.max(0, round2(finalSum - totalCouponDiscount))
        resolvedFinalShipping = shipping
        resolvedFinalSumWithShipping = round2(resolvedFinalSum + resolvedFinalShipping)
        resolvedCoupons = updatedCoupons
    }

    return {
        ...order,
        cart,
        sales: calcResult.cartSaleDetails || sales,
        coupons: resolvedCoupons,
        sum: calcResult.totals.sum,
        sumNoCoupon,
        finalSum: resolvedFinalSum,
        finalSumNoCoupon: sumNoCoupon,
        shipping,
        sumWithShipping,
        finalShipping: resolvedFinalShipping,
        finalSumWithShipping: resolvedFinalSumWithShipping,
        customerUpdatedAt: new Date()
    }
}

export default calcOrder