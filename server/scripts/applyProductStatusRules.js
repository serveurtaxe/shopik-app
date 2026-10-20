/**
 * One-off: apply catalog status rules from a sales-report barcode list.
 *
 *   no buying price OR no regular price  -> archived
 *   buying price + image + in report     -> active
 *   otherwise                            -> hidden
 *
 * `hasImage` matches the Comax sync rule (`images.product` non-empty). Report
 * membership is a barcode list, one entry per line (generate it from the Comax
 * .xlsb reports — Node cannot read xlsb). Only products whose status changes are
 * written; archived products without buying price stay archived.
 *
 * Writes a rollback JSON (barcode -> previous status) before touching the DB, so
 * a run is reversible even though pre-existing hidden/archived products can't be
 * told apart afterwards.
 *
 * Usage: node server/scripts/runApplyProductStatusRules.js --barcodes <file.txt>
 *          [--dry-run] [--limit N] [--rollback <path.json>]
 */
import { readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden', ARCHIVED: 'archived' }

// Comax/report barcodes lose a leading zero when stored as numbers.
export function normBarcode(s) {
    const t = String(s ?? '').trim()
    return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, '') : t
}

export function classifyProduct(product, barcodeSet, status = STATUS) {
    const hasBuy = Number(product?.buyingPrice) > 0
    const hasReg = (product?.prices || []).some(p => Number(p?.price) > 0)
    const hasImg = ((product?.images?.product) || []).length > 0
    const inReport = product?.barcode != null && barcodeSet.has(normBarcode(product.barcode))

    if (!hasBuy || !hasReg) return status.ARCHIVED
    if (hasImg && inReport) return status.ACTIVE
    return status.HIDDEN
}

export default async function applyProductStatusRules(
    { DL } = {},
    { barcodesFile, dryRun = false, limit = 0, rollbackFile } = {}
) {
    if (!DL?.Product?.Model) throw new Error('DL required')
    if (!barcodesFile) throw new Error('barcodesFile is required')

    const status = DL.Product.constants.STATUS
    const barcodeSet = new Set(
        readFileSync(barcodesFile, 'utf8')
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean)
            .map(normBarcode)
    )
    console.log(`[productStatus] report barcodes: ${barcodeSet.size}${dryRun ? ' (DRY RUN — no writes)' : ''}`)

    const products = await DL.Product.Model.find(
        {},
        { _id: 0, barcode: 1, status: 1, buyingPrice: 1, prices: 1, 'images.product': 1 }
    ).lean()

    const cap = Number(limit) || 0
    const transitions = {}
    const targets = {}
    const updates = []
    for (const p of products) {
        const target = classifyProduct(p, barcodeSet, status)
        const from = p.status || 'none'
        transitions[`${from}->${target}`] = (transitions[`${from}->${target}`] || 0) + 1
        targets[target] = (targets[target] || 0) + 1
        if (from === target) continue
        if (cap && updates.length >= cap) continue
        updates.push({ barcode: p.barcode, status: target, previousStatus: from })
    }

    console.log(`[productStatus] products: ${products.length}`)
    console.log(`[productStatus] targets: ${JSON.stringify(targets)}`)
    console.log(`[productStatus] transitions: ${JSON.stringify(transitions)}`)
    console.log(`[productStatus] toWrite: ${updates.length}`)

    if (dryRun) {
        console.log(`[productStatus] sample: ${JSON.stringify(updates.slice(0, 5))}`)
        console.log('[productStatus] DRY RUN — no writes')
        return { products: products.length, targets, transitions, updated: 0 }
    }

    if (updates.length) {
        const rb = rollbackFile || path.join(os.tmpdir(), `product-status-rollback-${Date.now()}.json`)
        writeFileSync(rb, JSON.stringify(updates.map(u => ({
            barcode: u.barcode, previousStatus: u.previousStatus, target: u.status
        })), null, 1))
        console.log(`[productStatus] rollback written: ${rb}`)

        const res = await DL.Product.bulkWrite({
            docs: updates,
            getFilter: d => ({ barcode: d.barcode }),
            getUpsert: () => false,
            getUpdate: d => ({ $set: { status: d.status } })
        })
        console.log(`[productStatus] done — modified ${res?.modifiedCount ?? 0}`)
    }
    return { products: products.length, targets, transitions, updated: updates.length }
}
