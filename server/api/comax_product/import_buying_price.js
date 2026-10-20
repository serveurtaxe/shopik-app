export default async function importComaxBuyingPrices(payload, { DL, external }) {
    const priceListId = process.env.COMAX_DELIVERY_PRICELIST_ID
    // buildComaxParams falls back to COMAX_PRICELIST_ID when priceListId is
    // empty — that would overwrite buying prices with website prices.
    if (!priceListId)
        throw { status: 500, message: 'COMAX_DELIVERY_PRICELIST_ID is not configured' }

    const lastImport = await DL.ComaxProduct.Model.findOne({}, { _id: 0, buyingPriceImportedAt: 1 })
        .sort({ buyingPriceImportedAt: -1 })
        .lean()
    const importedAt = new Date()
    const comaxProducts = await external.comax.getProducts({
        priceListId,
        lastUpdatedFromDate: lastImport?.buyingPriceImportedAt ?? '',
        includeZeroPrice: true
    })

    if (comaxProducts.length === 0) {
        return { message: 'No buying prices to import', count: 0 }
    }

    const BATCH = Number(process.env.COMAX_IMPORT_BATCH || 1000)
    const total = comaxProducts.length
    let count = 0

    // Update-only by barcode: the main import owns doc creation. Items whose
    // delivery price is 0/missing get buyingPrice cleared (→ archived at sync);
    // items absent from this delta keep their stored buyingPrice.
    for (let i = 0; i < total; i += BATCH) {
        const batch = comaxProducts.slice(i, i + BATCH).map(p => ({
            barcode: p.barcode,
            buyingPrice: p.price > 0 ? p.price : null,
            buyingPriceImportedAt: importedAt
        }))

        await DL.ComaxProduct.bulkWrite({
            docs: batch,
            getUpsert: () => false,
            getFilter: d => ({ barcode: d.barcode }),
            getUpdate: d => ({ $set: { buyingPrice: d.buyingPrice, buyingPriceImportedAt: d.buyingPriceImportedAt } })
        })

        count += batch.length
        const m = process.memoryUsage()
        console.log(`[Comax Buying Price Import] batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(total / BATCH)}: ${count}/${total} (heap ${Math.round(m.heapUsed / 1048576)}MB)`)
    }

    console.log(`[Comax Buying Price Import] Updated ${count} products`)

    return {
        message: 'Buying price import complete',
        count,
    }
}

importComaxBuyingPrices.config = {
    permissions: ['comax_product:update']
}
