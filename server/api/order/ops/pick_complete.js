import { calcOrderSum } from '#common/functions/calcOrder/index.js'
import { applyCalcToCart } from '#common/functions/calcOrder/cart.js'
import { findReplacement, isReplacedLine } from '#common/functions/cartReplacements.js'
import { withSortedCart } from '#server/utils/data/sortCartByCategory.js'
import { round2, round3 } from '#common/functions/calcOrder/utils.js'
import log from '#server/utils/log.js'

export default async function pick_complete(payload, { DL, _admin, utils }) {
    const { id } = payload
    if (!id) throw { status: 400, message: 'id required' }

    const order = await DL.Order.readById(id)
    if (!order) throw { status: 404, message: 'order not found' }
    if (order.status !== 'picking') throw { status: 400, message: 'order not in picking' }
    if (order.picker?.adminId !== _admin.id) throw { status: 403, message: 'not your order' }

    const unhandled = order.cart.filter(c => c.finalAmount == null && !c.missing)
    if (unhandled.length)
        throw { status: 400, message: `unhandled items: ${unhandled.map(u => u.barcode).join(', ')}` }

    // pricing recalc — reuse engine so missing/replaced originals get finalAmount 0
    const cartClone = JSON.parse(JSON.stringify(order.cart))
    for (const item of cartClone) {
        // `replacedBy` only stands when the pair is whole. A replaced original with no
        // replacement line in this cart was never supplied — it is a stock-out, and
        // writing `replacedBy` for it would leave the order holding half a pair.
        if (!item.missing || !isReplacedLine(item)) continue
        const replacer = findReplacement(cartClone, item)
        if (!replacer) { delete item.replacedBy; continue }
        item.replacedBy = replacer.barcode
    }

    // Snapshot checkout distributions BEFORE the recalc overwrites them.
    // Needed for pro-rata sale scaling on partially supplied lines below.
    const checkoutSnap = cartClone.map(l => ({
        dists: Array.isArray(l.priceDistribution) ? l.priceDistribution.map(d => ({ ...d })) : [],
        total: Number(l.totalSum) || 0,
        amount: Number(l.amount) || 0
    }))

    const allSaleIds = [...new Set(cartClone.flatMap(c => c.saleIds || []))]
    let salesMap = {}
    if (allSaleIds.length) {
        // `read` pages at 30 docs unless told otherwise, so an order with more
        // distinct sale ids than that lost the tail of the list here. The engine
        // treats a sale it never received as "no sale" and prices the line at the
        // regular rate — a silent overcharge (order 100336: 3 of 33 sales, +68.50).
        const sales = await DL.Sale.read(
            { id: { $in: allSaleIds } },
            DL.Sale.defaultSelect,
            { limit: 0 }
        )
        salesMap = Object.fromEntries((sales || []).map(s => [s.id, s]))

        const unresolved = allSaleIds.filter(saleId => !salesMap[saleId])
        if (unresolved.length)
            log.warn(`pick_complete: ${unresolved.length} unresolved sale id(s) for order ${id}: ${unresolved.join(', ')}`)
    }

    let calcResult
    try {
        calcResult = calcOrderSum({ cart: cartClone, sales: salesMap })
    } catch (e) {
        throw { status: 500, message: 'pricing failed: ' + (e.message || e) }
    }

    const withPricing = applyCalcToCart ? (() => {
        try { return applyCalcToCart({ cart: cartClone, calcResult }) } catch { return cartClone }
    })() : cartClone

    for (let i = 0; i < withPricing.length; i++) {
        if (withPricing[i].priceDistribution) {
            cartClone[i].priceDistribution = withPricing[i].priceDistribution
            cartClone[i].totalSum = withPricing[i].totalSum
            cartClone[i].regularSum = withPricing[i].regularSum
            cartClone[i].saleSum = withPricing[i].saleSum
        }
    }

    // Pro-rata sale benefit for partially supplied lines.
    // The engine grants bundle sales (e.g. 3-for-15) only when the PACKED qty
    // meets the threshold. When the store under-supplies, the customer keeps
    // the checkout unit prices: scale checkout distributions by packed/ordered.
    // Lines without a checkout sale keep the engine result (packed qty at
    // regular price, per the applySales leftover fix).
    for (let i = 0; i < cartClone.length; i++) {
        const line = cartClone[i]
        if (line.missing || line.replacedBy) continue
        const packed = Number(line.finalAmount ?? line.amount ?? 0)
        const ordered = Number(checkoutSnap[i]?.amount ?? line.amount ?? 0)
        if (!(packed > 0) || !(ordered > 0) || packed >= ordered) continue
        const co = checkoutSnap[i]
        if (!co?.dists?.some(d => d.type === 'sale')) continue
        const factor = packed / ordered
        const scaled = co.dists.map(d => ({
            ...d,
            amount: round3((Number(d.amount) || 0) * factor),
            totalSum: round2((Number(d.totalSum) || 0) * factor)
        }))
        // Absorb rounding drift on the largest leg so legs sum to the target.
        const target = round2(co.total * factor)
        const got = round2(scaled.reduce((s, d) => s + (Number(d.totalSum) || 0), 0))
        const drift = round2(target - got)
        if (drift !== 0 && scaled.length) {
            let bi = 0
            for (let k = 1; k < scaled.length; k++)
                if ((Number(scaled[k].totalSum) || 0) > (Number(scaled[bi].totalSum) || 0)) bi = k
            scaled[bi] = { ...scaled[bi], totalSum: round2((Number(scaled[bi].totalSum) || 0) + drift) }
        }
        line.priceDistribution = scaled
        line.totalSum = round2(scaled.reduce((s, d) => s + (Number(d.totalSum) || 0), 0))
        line.regularSum = round2(scaled.filter(d => d.type !== 'sale').reduce((s, d) => s + (Number(d.totalSum) || 0), 0))
        line.saleSum = round2(scaled.filter(d => d.type === 'sale').reduce((s, d) => s + (Number(d.totalSum) || 0), 0))
    }

    // map engine totals back to order — recomputed from the final cart so the
    // pro-rata scaling above is reflected (calcResult.totals predates it)
    const sum = round2(cartClone.reduce(
        (s, l) => s + ((l.replacedBy || l.missing) ? 0 : (Number(l.totalSum) || 0)), 0))
    const finalSum = sum

    // coupon re-apply: keep coupons as-is, clamp finalSum = max(sum - discount, 0)
    let finalSumAdjusted = finalSum
    if (order.coupons?.length) {
        const discount = order.coupons.reduce((acc, c) => acc + (Number(c.discount) || 0), 0)
        finalSumAdjusted = Math.max(Number(finalSum) - discount, 0)
    }

    const updated = await DL.Order.updateOne(
        { id, status: 'picking' },
        {
            $set: {
                cart: cartClone,
                status: 'picked',
                pickEnd: new Date(),
                sum,
                finalSum: finalSumAdjusted,
                finalSumNoCoupon: sum
            }
        }
    )

    if (!updated) throw { status: 409, message: 'status changed' }

    try {
        await DL.Owner.updateOne({ orderId: id, adminId: _admin.id, type: 'picking', status: 'active' }, { status: 'done', end: new Date() })
    } catch {}
    try {
        await DL.PickHistory.create({
            orderId: id, storeId: order.storeId, adminId: _admin.id,
            adminName: `${_admin.name?.first ?? ''} ${_admin.name?.last ?? ''}`.trim(),
            action: 'complete', barcode: 'ORDER', pickedAt: new Date(), windowDate: order.window?.date, totalItems: order.cart.length, pickStart: order.pickStart, pickEnd: new Date()
        })
    } catch {}

    try {
        const { record, adminActor } = utils.data.timeline
        await record({
            DL, order,
            eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_STATUS_UPDATE,
            actor: adminActor(_admin),
            changes: { oldData: { status: 'picking' }, newData: { status: 'picked' } },
            context: { step: 'pick_complete', cartSize: order.cart.length },
            metadata: { source: 'order/ops/pick_complete' }
        })
    } catch {}

    return withSortedCart(updated)
}

pick_complete.config = {
    permissions: ['order:pick']
}
