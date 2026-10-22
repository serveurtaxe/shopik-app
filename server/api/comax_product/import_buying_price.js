import mem, { collectGarbage } from '#server/utils/mem.js'
import { BUYING_PRICES, resolveImportStart, completeRun } from './watermark.js'

export default async function importComaxBuyingPrices(payload, { DL, external }) {
    const priceListId = process.env.COMAX_DELIVERY_PRICELIST_ID
    // buildComaxParams falls back to COMAX_PRICELIST_ID when priceListId is
    // empty — that would overwrite buying prices with website prices.
    if (!priceListId)
        throw { status: 500, message: 'COMAX_DELIVERY_PRICELIST_ID is not configured' }

    const startedAt = new Date()
    const { from, source } = await resolveImportStart(DL, BUYING_PRICES, 'buyingPriceImportedAt')

    // Streamed like the product import: the buying-price delta can be the
    // whole catalog too, and buffering it as one string + parsed tree + mapped
    // array exhausted the container.
    const BATCH = Number(process.env.COMAX_IMPORT_BATCH || 1000)
    const STREAM_TIMEOUT_MS = Number(process.env.COMAX_STREAM_IDLE_TIMEOUT_MS || 600000)
    const GC_EVERY = Number(process.env.COMAX_IMPORT_GC_EVERY || 20)

    const stats = { blocks: 0, kept: 0, unparsed: 0 }
    let batch = []
    let count = 0
    let failed = 0
    let batchNo = 0

    // Update-only by barcode: the main import owns doc creation. Items whose
    // delivery price is 0/missing get buyingPrice cleared (→ archived at sync);
    // items absent from this delta keep their stored buyingPrice.
    const flush = async () => {
        if (!batch.length) return
        const docs = batch
        batch = []
        batchNo++
        try {
            await DL.ComaxProduct.bulkWrite({
                docs,
                getUpsert: () => false,
                getFilter: d => ({ barcode: d.barcode }),
                getUpdate: d => ({ $set: { buyingPrice: d.buyingPrice, buyingPriceImportedAt: d.buyingPriceImportedAt } })
            })
        } catch (e) {
            failed += docs.length
            console.error(`[Comax Buying Price Import] batch ${batchNo} failed:`, e?.message || e)
        }
        count += docs.length
        mem(`batch ${batchNo}: ${count} products`, 'ComaxBuyingPrice')
        if (GC_EVERY > 0 && batchNo % GC_EVERY === 0) collectGarbage()
    }

    console.log(`[Comax Buying Price Import] Streaming from ${from ? from.toISOString() : 'the start of the catalog'} (${source})`)
    mem('start', 'ComaxBuyingPrice')

    try {
        for await (const p of external.comax.streamProducts({
            priceListId,
            lastUpdatedFromDate: from ?? '',
            includeZeroPrice: true,
            timeoutMs: STREAM_TIMEOUT_MS,
            stats
        })) {
            batch.push({
                barcode: p.barcode,
                buyingPrice: p.price > 0 ? p.price : null,
                buyingPriceImportedAt: startedAt
            })
            if (batch.length >= BATCH) await flush()
        }
        await flush()
    } catch (e) {
        // The stream died half way — the watermark must NOT advance, or the
        // items that never got their buying price would be skipped forever.
        await flush()
        await completeRun(DL, BUYING_PRICES, {
            startedAt,
            processed: count - failed,
            failed,
            unparsed: stats.unparsed,
            error: e
        })
        throw e
    }

    if (stats.blocks === 0) {
        console.warn('[Comax Buying Price Import] No <ClsItems> blocks in the response — not advancing the watermark')
        await completeRun(DL, BUYING_PRICES, { startedAt, processed: 0, failed, unparsed: stats.unparsed, status: 'skipped' })
        return { message: 'No buying prices to import', count: 0 }
    }

    const advance = failed === 0 && stats.unparsed === 0
    await completeRun(DL, BUYING_PRICES, {
        startedAt,
        processed: count - failed,
        failed,
        unparsed: stats.unparsed,
        advance
    })

    if (!advance) {
        console.warn(`[Comax Buying Price Import] ${failed + stats.unparsed} product(s) not written — watermark not advanced, the next run re-fetches the same delta`)
        return { message: 'Buying price import partially failed', count }
    }

    if (count === 0) {
        console.log('[Comax Buying Price Import] No buying prices to import')
        return { message: 'No buying prices to import', count: 0 }
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
