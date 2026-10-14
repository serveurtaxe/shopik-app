import { constants as productConstants } from '#server/dl/schemas/product.js'
import { buildCartProduct, CART_PRODUCT_STATUS } from '#common/functions/calcOrder/cart.js'
import enrichCart from '#server/utils/data/enrichCart.js'
import getPickLimits from '#server/utils/data/getPickLimits.js'
import { getPickRange, isPickInRange } from '#common/functions/pickLimits.js'

export default async function pick_item(payload, { DL, _admin, utils }) {
    const { id, barcode, scannedBarcode, action, finalAmount, missingReason, replacement } = payload
    if (!id || !barcode || !action) throw { status: 400, message: 'id, barcode, action required' }

    // Verify the physically scanned barcode matches the expected product.
    // Client sends barcode = expected item barcode, scannedBarcode = what was actually scanned.
    if (action === 'scan' && scannedBarcode != null && String(scannedBarcode).trim() !== '') {
        const expected = String(barcode).trim()
        const scanned = String(scannedBarcode).trim()
        if (scanned !== expected) {
            // allow alternate scannable barcodes of the same product
            let allowed = [expected]
            try {
                const prod = await DL.Product.Model.findOne(
                    { $or: [{ barcode: expected }, { scannableBarcodes: expected }, { id: expected }] },
                    { _id: 0, barcode: 1, scannableBarcodes: 1 }
                ).lean()
                if (prod) allowed = [String(prod.barcode || '').trim(), ...((prod.scannableBarcodes || []).map(String).map(s => s.trim()))].filter(Boolean)
            } catch { }
            if (!allowed.includes(scanned)) {
                throw { status: 400, message: `barcode mismatch: scanned ${scanned} does not match expected ${expected}` }
            }
        }
    }

    const order = await DL.Order.readById(id)
    if (!order) throw { status: 404, message: 'order not found' }
    if (order.status !== 'picking') throw { status: 400, message: 'order not in picking' }
    if (order.picker?.adminId !== _admin.id) throw { status: 403, message: 'not your order' }

    const idx = order.cart.findIndex(c => c.barcode === barcode)
    if (idx === -1) throw { status: 404, message: 'item not found' }

    const item = order.cart[idx]
    const isWeighted = item.unit?.type === productConstants.UNIT.WEIGHT || item.unit?.type === 'weight'

    // Pick deviation limits (per-domain setting, hardcoded fallback) — the
    // client validates for UX, this is the enforced source of truth.
    const pickLimits = await getPickLimits(DL, order.domainId)
    const assertInRange = (supplied, weighted, label) => {
        if (!isPickInRange(supplied, item.amount, weighted, pickLimits)) {
            const range = getPickRange(item.amount, weighted, pickLimits)
            throw {
                status: 400,
                message: `${label} out of allowed range (ordered ${item.amount}, allowed ${range?.min ?? '?'}–${range?.max ?? '?'})`,
                code: 'PICK_RANGE_EXCEEDED',
            }
        }
    }

    const fullAdmin = await DL.Admin.readById(_admin.id)
    const adminName = `${_admin.name?.first ?? ''} ${_admin.name?.last ?? ''}`.trim()

    let update = {}
    let arrayFilters = [{ 'elem.barcode': barcode }]

    if (action === 'scan') {
        if (isWeighted) throw { status: 400, message: 'weighted items use weight action' }
        const amt = Number(finalAmount ?? item.amount)
        if (isNaN(amt) || amt <= 0) throw { status: 400, message: 'valid finalAmount required' }
        assertInRange(amt, false, 'picked quantity')
        update = {
            $set: {
                'cart.$[elem].finalAmount': amt,
                'cart.$[elem].missing': false
            },
            $push: {
                'cart.$[elem].admins': { adminId: _admin.id, date: new Date(), amount: amt, status: 'scanned' }
            }
        }
    } else if (action === 'weight') {
        // weighted items have no scannable barcode — picker enters weighed amount
        const amt = Number(finalAmount)
        if (isNaN(amt) || amt < 0) throw { status: 400, message: 'valid finalAmount required' }
        assertInRange(amt, true, 'picked weight')
        update = {
            $set: {
                'cart.$[elem].finalAmount': amt,
                'cart.$[elem].missing': false
            },
            $push: {
                'cart.$[elem].admins': { adminId: _admin.id, date: new Date(), amount: amt, status: 'weighted' }
            }
        }
    } else if (action === 'missing') {
        update = {
            $set: {
                'cart.$[elem].missing': true,
                'cart.$[elem].missingReason': missingReason || 'missing',
                'cart.$[elem].finalAmount': 0
            },
            $push: {
                'cart.$[elem].admins': { adminId: _admin.id, date: new Date(), missing: true, status: 'missing' }
            }
        }
    } else if (action === 'replace') {
        // replacement: mark original as replaced AND ensure the replacer line exists in cart
        const repBarcode = String(replacement?.replacementBarcode ?? '').trim()
        if (!repBarcode) throw { status: 400, message: 'replacementBarcode required' }
        if (repBarcode === String(barcode).trim()) throw { status: 400, message: 'replacement cannot be the same product' }
        const repAmountRaw = replacement?.amount ?? item.amount
        const repAmount = Number(repAmountRaw)
        if (isNaN(repAmount) || repAmount <= 0) throw { status: 400, message: 'valid replacement amount required' }

        // validate replacer product exists and is orderable
        let repProduct = null
        try {
            repProduct = await DL.Product.readOne({ barcode: repBarcode })
        } catch { repProduct = null }
        if (!repProduct) {
            try {
                repProduct = await DL.Product.Model.findOne({ scannableBarcodes: repBarcode }).lean()
            } catch { repProduct = null }
        }
        if (!repProduct) throw { status: 404, message: 'replacement product not found' }
        if (repProduct.status === DL.Product.constants.STATUS.ARCHIVED) throw { status: 400, message: 'replacement product not available' }

        // Replacement amount must stay within the same deviation limits,
        // judged by the *replacement* product's unit type vs the original ordered amount.
        const repIsWeighted = repProduct.unit?.type === productConstants.UNIT.WEIGHT || repProduct.unit?.type === 'weight'
        if (!isPickInRange(repAmount, item.amount, repIsWeighted, pickLimits)) {
            const range = getPickRange(item.amount, repIsWeighted, pickLimits)
            throw {
                status: 400,
                message: `replacement amount out of allowed range (ordered ${item.amount}, allowed ${range?.min ?? '?'}–${range?.max ?? '?'})`,
                code: 'PICK_RANGE_EXCEEDED',
            }
        }

        const repBarcodeCanon = String(repProduct.barcode || repBarcode).trim()
        const adminEntry = { adminId: _admin.id, date: new Date(), amount: repAmount, status: 'replaced' }

        // If replacement item already exists in cart, link + set picked amount on it
        const repIdx = order.cart.findIndex(c => c.barcode === repBarcodeCanon)
        if (repIdx !== -1) {
            await DL.Order.Model.updateOne(
                { id },
                {
                    $set: {
                        [`cart.${repIdx}.replacement.originalBarcode`]: barcode,
                        [`cart.${repIdx}.finalAmount`]: repAmount,
                        [`cart.${repIdx}.missing`]: false
                    },
                    $push: { [`cart.${repIdx}.admins`]: adminEntry }
                }
            )
        } else {
            // create replacer line from product snapshot
            const cartProduct = buildCartProduct({
                product: repProduct,
                amount: repAmount,
                domainId: order.domainId,
                existingStatus: CART_PRODUCT_STATUS.ADMIN_ADD
            })
            cartProduct.status = CART_PRODUCT_STATUS.ADMIN_ADD
            cartProduct.finalAmount = repAmount
            cartProduct.missing = false
            cartProduct.replacement = { originalBarcode: barcode }
            cartProduct.admins = [adminEntry]
            await DL.Order.Model.updateOne({ id }, { $push: { cart: cartProduct } })
        }

        update = {
            $set: {
                'cart.$[elem].missing': true,
                'cart.$[elem].missingReason': 'replaced',
                'cart.$[elem].finalAmount': 0,
                'cart.$[elem].replacement.replacementBarcode': repBarcodeCanon
            },
            $push: {
                'cart.$[elem].admins': { adminId: _admin.id, date: new Date(), status: 'replaced' },
                'cart.$[elem].replacement.suggestions': {
                    barcode: repBarcodeCanon,
                    amount: repAmount,
                    approval: { admin: { adminId: _admin.id, name: adminName } }
                }
            }
        }
    } else {
        throw { status: 400, message: 'unknown action' }
    }

    const updated = await DL.Order.Model.findOneAndUpdate(
        { id },
        update,
        { returnDocument: 'after', arrayFilters }
    ).lean()
    try {
        await enrichCart(updated, DL)
    } catch { }

    // audit to pick_history
    try {
        await DL.PickHistory.create({
            orderId: id,
            storeId: order.storeId,
            adminId: _admin.id,
            adminName,
            barcode,
            productName: item.name,
            storageType: item.storageType,
            categoryId: item.category?.id,
            categoryPathIds: item.category?.pathIds,
            action,
            amount: item.amount,
            finalAmount: action === 'missing' ? 0 : (Number(finalAmount ?? item.amount)),
            replacedBarcode: action === 'replace' ? barcode : undefined,
            replacementBarcode: action === 'replace' ? replacement?.replacementBarcode : undefined,
            replacementReason: missingReason,
            pickedAt: new Date(),
            windowDate: order.window?.date,
            totalItems: order.cart.length
        })
    } catch { }

    return updated
}

pick_item.config = {
    permissions: ['order:pick'],
    preventMultiple: p => ':' + (p.id || '')
}
