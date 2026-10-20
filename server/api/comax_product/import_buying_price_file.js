import fs from 'node:fs/promises'
import { parseBuyingPriceCsv } from '#server/external/comax/buyingPriceCsv.js'

export default async function importComaxBuyingPriceFile(payload = {}, { DL }) {
    const file = payload.file
    if (!file) throw { status: 400, message: 'file is required' }

    // Only the configured delivery (buying) price list is applied; other lists
    // in the file are ignored so website prices never overwrite buying prices.
    const priceListId = process.env.COMAX_DELIVERY_PRICELIST_ID
    const dryRun = !!payload.dryRun

    const text = await fs.readFile(file, 'utf8')
    const { prices, conflicts, skipped } = parseBuyingPriceCsv(text, { priceListId })
    if (!prices.size) return { message: 'No buying prices found in file', parsed: 0, updated: 0 }

    const docs = [...prices].map(([barcode, buyingPrice]) => ({ barcode, buyingPrice }))
    const BATCH = Number(process.env.COMAX_IMPORT_BATCH || 1000)
    let updated = 0

    console.log(`[Comax Buying Price File] ${file}: ${docs.length} barcodes (${conflicts.length} conflicting duplicates, ${skipped} rows skipped)${dryRun ? ', dry-run' : ''}`)

    for (let i = 0; i < docs.length; i += BATCH) {
        const batch = docs.slice(i, i + BATCH)
        if (!dryRun) {
            // Update-only by barcode: overwrites existing buyingPrice, creates nothing.
            const res = await DL.ComaxProduct.bulkWrite({
                docs: batch,
                getUpsert: () => false,
                getFilter: d => ({ barcode: d.barcode }),
                getUpdate: d => ({ $set: { buyingPrice: d.buyingPrice } })
            })
            updated += res?.modifiedCount || 0
        }
        console.log(`[Comax Buying Price File] batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(docs.length / BATCH)}: ${Math.min(i + BATCH, docs.length)}/${docs.length} (updated ${updated})`)
    }

    console.log(`[Comax Buying Price File] Done: ${docs.length} barcodes, ${updated} products updated${dryRun ? ' (dry-run)' : ''}`)

    return {
        message: 'Buying price file import complete',
        parsed: docs.length,
        updated,
        conflicts: conflicts.length,
        skipped,
        dryRun
    }
}

importComaxBuyingPriceFile.config = {
    permissions: ['comax_product:update']
}
