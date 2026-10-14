import { round2, round3, SALE_KINDS, AGORA } from './utils.js'

export function distributeAgoraLeftover(distributions, targetSum, actualSum) {
    const leftOverSum = round2(targetSum - actualSum)
    if (leftOverSum === 0) return
    const isPositive = leftOverSum > 0
    let agorotAmount = Math.floor(round2(Math.abs(leftOverSum) / AGORA))
    if (agorotAmount <= 0) return
    for (let i = 0; agorotAmount > 0 && i < distributions.length; i++) {
        const dist = distributions[i]
        const availableAmount = Math.min(dist.saleAmount, agorotAmount)
        if (availableAmount > 0) {
            agorotAmount -= availableAmount
            const noPriceChangeAmount = dist.saleAmount - availableAmount
            const newPrice = round2(dist.salePricePerUnit + (isPositive ? AGORA : -AGORA))
            // Guard against negative price
            if (newPrice < 0) continue
            distributions.splice(i, 1, {
                ...dist,
                saleAmount: availableAmount,
                salePricePerUnit: newPrice,
                sum: round2(availableAmount * newPrice)
            })
            if (noPriceChangeAmount > 0) {
                distributions.splice(i + 1, 0, {
                    ...dist,
                    saleAmount: noPriceChangeAmount,
                    sum: round2(noPriceChangeAmount * dist.salePricePerUnit)
                })
                i++
            }
        }
    }
}

function getSalePricePerUnit(sale, orderPrice) {
    if (sale.percent) {
        const percentDiscount = Math.max(0, 100.0 - sale.percent) * 0.01
        return round2(orderPrice * percentDiscount)
    }
    return sale.price >= 0.0 ? round2(sale.price / sale.amount) : 0.0
}

function updateCartBarcodes(products, sale, requiredSaleAmount, isReceiveSaleProduct = false, getPricePerUnit = null) {
    let saleProductSum = 0.0
    let totalOrderPrice = 0.0
    const distributions = []

    for (const p of products) {
        if (requiredSaleAmount <= 0) break
        if (p.availableAmount > 0) {
            const saleAmount = Math.min(requiredSaleAmount, p.availableAmount)
            requiredSaleAmount -= saleAmount

            const productPrice = p.orderPrice * saleAmount
            const salePricePerUnit = getPricePerUnit ? getPricePerUnit(p.orderPrice) : getSalePricePerUnit(sale, p.orderPrice)

            distributions.push({
                product: p,
                saleId: sale.saleId,
                saleAmount,
                productPrice,
                salePricePerUnit,
                saleKind: sale.kind,
                isReceiveSaleProduct,
                isGiveSaleProduct: !isReceiveSaleProduct,
                sum: round2(saleAmount * salePricePerUnit)
            })

            saleProductSum += salePricePerUnit * saleAmount
            totalOrderPrice += productPrice

            p.totalAvailableAmount = round3(Math.max(p.totalAvailableAmount - saleAmount, 0))
            p.availableAmount = round3(Math.max(p.availableAmount - saleAmount, 0))
            // Keep the ordered-remaining counter (sale-threshold basis) in sync.
            if (p.orderAvailable != null) p.orderAvailable = round3(Math.max(p.orderAvailable - saleAmount, 0))
        }
    }

    return {
        requiredSaleAmount,
        totalOrderPrice: round2(totalOrderPrice),
        distributions,
        productSum: round2(saleProductSum)
    }
}

function handleSaleReceivePrice(products, receiveProducts, sale) {
    let requiredSaleSum = sale.price
    const distributions = []
    const restoredProducts = []

    for (const p of products) {
        if (requiredSaleSum <= 0) break
        const saleAmount = Math.min(p.totalAvailableAmount, Math.ceil(requiredSaleSum / p.orderPrice))
        if (saleAmount > 0) {
            const cartProductPrice = p.orderPrice * saleAmount
            const productPrice = Math.min(requiredSaleSum, cartProductPrice)
            requiredSaleSum = Math.max(0, requiredSaleSum - productPrice)

            distributions.push({
                product: p,
                saleId: sale.saleId,
                saleAmount,
                productPrice,
                salePricePerUnit: p.orderPrice,
                saleKind: sale.kind,
                isReceiveSaleProduct: false,
                isGiveSaleProduct: true,
                sum: round2(saleAmount * p.orderPrice)
            })

            p.totalAvailableAmount = round3(Math.max(p.totalAvailableAmount - saleAmount, 0))
            restoredProducts.push({ p, saleAmount })
        }
    }

    const receiveResult = updateCartBarcodes(
        receiveProducts,
        sale,
        sale.receive.amount,
        true,
        (orderPrice) => getSalePricePerUnit(sale.receive, orderPrice)
    )

    if (!receiveResult.totalOrderPrice || sale.price > receiveResult.totalOrderPrice) {
        // Rollback
        for (const { p, saleAmount } of restoredProducts) {
            p.totalAvailableAmount = round3(p.totalAvailableAmount + saleAmount)
        }
        for (const dist of receiveResult.distributions) {
            dist.product.totalAvailableAmount = round3(dist.product.totalAvailableAmount + dist.saleAmount)
            dist.product.availableAmount = round3(dist.product.availableAmount + dist.saleAmount)
        }
        return { distributions: [], receiveDistributions: [], success: false }
    }

    return {
        distributions,
        receiveDistributions: receiveResult.distributions,
        success: true
    }
}

export function applySaleToProducts({ products, receiveProducts, sale }) {
    if (sale.kind === SALE_KINDS.RECEIVE_PRICE) {
        const res = handleSaleReceivePrice(products, receiveProducts, sale)
        if (!res.success) return { success: false, distributions: [] }
        return { success: true, distributions: [...res.distributions, ...res.receiveDistributions] }
    }

    if (sale.kind === SALE_KINDS.RECEIVE_AMOUNT) {
        const giveResult = updateCartBarcodes(products, sale, sale.amount, false, (orderPrice) => orderPrice)
        const receiveResult = updateCartBarcodes(receiveProducts, sale, sale.receive.amount, true, (orderPrice) => getSalePricePerUnit(sale.receive, orderPrice))
        return { success: true, distributions: [...giveResult.distributions, ...receiveResult.distributions] }
    }

    const res = updateCartBarcodes(products, sale, sale.amount)
    if (res.requiredSaleAmount === 0 && sale.price != null && sale.kind !== SALE_KINDS.PERCENT) {
        distributeAgoraLeftover(res.distributions, sale.price, res.productSum)
    }
    return { success: true, distributions: res.distributions }
}
