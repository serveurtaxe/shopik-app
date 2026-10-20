/**
 * One-off: add a store id to products that appear in a store's report.
 *
 * `storeIds` is which stores carry a product (stock/routing), so the id is
 * ADDED with $addToSet — existing assignments are never removed, and re-running
 * is a no-op. Every matching product is updated regardless of status; status is
 * owned by the separate status-rules pass.
 *
 * Report membership is a barcode list, one normalized barcode per line (generate
 * it from the Comax .xlsb report — Node cannot read xlsb).
 *
 * Usage: node server/scripts/runAssignStoreIdsFromReports.js --barcodes <file.txt>
 *          --store <id|name> [--dry-run] [--limit N] [--rollback <path.json>]
 */
import { readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { normBarcode } from './applyProductStatusRules.js'

export default async function assignStoreIdsFromReports(
    { DL } = {},
    { barcodesFile, store, dryRun = false, limit = 0, rollbackFile } = {}
) {
    if (!DL?.Product?.Model || !DL?.Store?.Model) throw new Error('DL required')
    if (!barcodesFile) throw new Error('barcodesFile is required')
    if (!store) throw new Error('store (id or name) is required')

    const storeDoc = await DL.Store.Model.findOne(
        { $or: [{ id: store }, { name: store }] },
        { _id: 0, id: 1, name: 1 }
    ).lean()
    if (!storeDoc?.id) throw new Error(`store not found: ${store}`)

    const barcodeSet = new Set(
        readFileSync(barcodesFile, 'utf8')
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean)
            .map(normBarcode)
    )
    console.log(`[storeIds] ${storeDoc.name} (${storeDoc.id}) — report barcodes: ${barcodeSet.size}${dryRun ? ' (DRY RUN — no writes)' : ''}`)

    const products = await DL.Product.Model.find(
        {}, { _id: 0, barcode: 1, storeIds: 1 }
    ).lean()

    const cap = Number(limit) || 0
    const updates = []
    let matched = 0
    let already = 0
    for (const p of products) {
        if (p.barcode == null || !barcodeSet.has(normBarcode(p.barcode))) continue
        matched++
        if ((p.storeIds || []).includes(storeDoc.id)) { already++; continue }
        if (cap && updates.length >= cap) continue
        updates.push({ barcode: p.barcode })
    }

    console.log(`[storeIds] matched products: ${matched}, already assigned: ${already}, toAdd: ${updates.length}`)
    if (dryRun) {
        console.log(`[storeIds] sample: ${JSON.stringify(updates.slice(0, 5))}`)
        console.log('[storeIds] DRY RUN — no writes')
        return { store: storeDoc.id, matched, already, added: 0 }
    }

    if (updates.length) {
        const rb = rollbackFile || path.join(os.tmpdir(), `store-ids-rollback-${Date.now()}.json`)
        writeFileSync(rb, JSON.stringify({
            storeId: storeDoc.id,
            barcodes: updates.map(u => u.barcode)
        }, null, 1))
        console.log(`[storeIds] rollback written: ${rb}`)

        const res = await DL.Product.bulkWrite({
            docs: updates,
            getFilter: d => ({ barcode: d.barcode }),
            getUpsert: () => false,
            getUpdate: () => ({ $addToSet: { storeIds: storeDoc.id } })
        })
        console.log(`[storeIds] done — modified ${res?.modifiedCount ?? 0}`)
    }
    return { store: storeDoc.id, matched, already, added: updates.length }
}
