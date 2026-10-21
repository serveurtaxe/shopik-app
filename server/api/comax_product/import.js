export default async function importComaxProducts(payload, { DL, external }) {
    const lastImportProduct = await DL.ComaxProduct.Model.findOne({}, { _id: 0, lastImportedAt: 1 })
        .sort({ lastImportedAt: -1 })
        .lean()
    const lastImportedAt = new Date()
    const comaxProducts = await external.comax.getProducts({
        lastUpdatedFromDate: lastImportProduct?.lastImportedAt ?? ''
    })

    if (comaxProducts.length === 0) {
        return { message: 'No products to import', count: 0 }
    }

    // Batched writes: the catalog (10-50k docs) must never be held as enriched
    // copies + one giant bulkOps array at once — that OOMed 512MB containers.
    // Stamp lastImportedAt in place (no spread-copy) and release each batch
    // before building the next. Tune via COMAX_IMPORT_BATCH (default 1000,
    // same as COMAX_SYNC_BATCH in sync.js). Heap headroom via NODE_OPTIONS
    // (e.g. NODE_OPTIONS=--max-old-space-size=2048) in the deploy environment
    // — it must be set before node starts, so it cannot come from .env.
    const BATCH = Number(process.env.COMAX_IMPORT_BATCH || 1000)
    const total = comaxProducts.length
    let count = 0

    for (let i = 0; i < total; i += BATCH) {
        const batch = comaxProducts.slice(i, i + BATCH)
        for (const p of batch) p.lastImportedAt = lastImportedAt

        await DL.ComaxProduct.bulkWrite({
            docs: batch,
            getUpsert: p => p.price > 0 && !p.archived,
            getFilter: p => ({ barcode: p.barcode }),
        }).catch(e => {
            console.error(`[Comax Import] batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(total / BATCH)} failed:`, e?.message || e)
        })

        count += batch.length
        const m = process.memoryUsage()
        console.log(`[Comax Import] batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(total / BATCH)}: ${count}/${total} (heap ${Math.round(m.heapUsed / 1048576)}MB)`)
    }

    console.log(`[Comax Import] Inserted/updated ${count} products`)

    return {
        message: 'Import complete',
        count,
    }
}

importComaxProducts.config = {
    permissions: ['comax_product:update']
}
