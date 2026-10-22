import mem, { collectGarbage } from '#server/utils/mem.js'
import { PRODUCTS, resolveImportStart, completeRun } from './watermark.js'

export default async function importComaxProducts(payload, { DL, external }) {
    const startedAt = new Date()
    const { from, source } = await resolveImportStart(DL, PRODUCTS, 'lastImportedAt')

    // Batched writes over a STREAMED catalog. The response is never held in
    // memory as a whole: a mass price update makes the Comax delta the
    // entire catalog (hundreds of MB) and buffering it as one string + one
    // parsed tree + one mapped array exhausted the container. One item is
    // parsed at a time and released as soon as it lands in a batch.
    // Tune via COMAX_IMPORT_BATCH (default 1000, same as COMAX_SYNC_BATCH in
    // sync.js). The stream timeout is an IDLE timeout (reset on every chunk)
    // — a slow but healthy multi-minute download must not be killed half way.
    const BATCH = Number(process.env.COMAX_IMPORT_BATCH || 1000)
    const STREAM_TIMEOUT_MS = Number(process.env.COMAX_STREAM_IDLE_TIMEOUT_MS || 600000)
    // The stream churns through one short-lived object graph per product.
    // V8 collects when it feels like it, which lets the RSS overshoot the
    // container limit on a very large catalog. When the process runs with
    // --expose-gc, collect on a fixed schedule to keep the RSS flat.
    const GC_EVERY = Number(process.env.COMAX_IMPORT_GC_EVERY || 20)

    const stats = { blocks: 0, kept: 0, unparsed: 0 }
    let batch = []
    let count = 0
    let failed = 0
    let batchNo = 0

    const flush = async () => {
        if (!batch.length) return
        const docs = batch
        batch = []
        batchNo++
        try {
            await DL.ComaxProduct.bulkWrite({
                docs,
                getUpsert: p => p.price > 0 && !p.archived,
                getFilter: p => ({ barcode: p.barcode }),
            })
        } catch (e) {
            failed += docs.length
            console.error(`[Comax Import] batch ${batchNo} failed:`, e?.message || e)
        }
        count += docs.length
        mem(`batch ${batchNo}: ${count} products`, 'ComaxImport')
        if (GC_EVERY > 0 && batchNo % GC_EVERY === 0) collectGarbage()
    }

    console.log(`[Comax Import] Streaming from ${from ? from.toISOString() : 'the start of the catalog'} (${source})`)
    mem('start', 'ComaxImport')

    try {
        for await (const p of external.comax.streamProducts({
            lastUpdatedFromDate: from ?? '',
            timeoutMs: STREAM_TIMEOUT_MS,
            stats
        })) {
            p.lastImportedAt = startedAt
            batch.push(p)
            if (batch.length >= BATCH) await flush()
        }
        await flush()
    } catch (e) {
        // The stream died half way. The products already written stay, but the
        // watermark must NOT advance — the next run re-fetches the same delta.
        await flush()
        await completeRun(DL, PRODUCTS, {
            startedAt,
            processed: count - failed,
            failed,
            unparsed: stats.unparsed,
            error: e
        })
        throw e
    }

    if (stats.blocks === 0) {
        // Not a single <ClsItems> block in the response — the format may have
        // changed, or Comax answered with an error document. Either way it is
        // not a trustworthy "nothing changed" answer, so the watermark stays
        // put and the next run asks for the same window again.
        console.warn('[Comax Import] No <ClsItems> blocks in the response — not advancing the watermark')
        await completeRun(DL, PRODUCTS, { startedAt, processed: 0, failed, unparsed: stats.unparsed, status: 'skipped' })
        return { message: 'No products to import', count: 0 }
    }

    // Only a fully written delta may move the watermark forward — otherwise
    // the products that never made it into the DB would be skipped forever.
    const advance = failed === 0 && stats.unparsed === 0
    await completeRun(DL, PRODUCTS, {
        startedAt,
        processed: count - failed,
        failed,
        unparsed: stats.unparsed,
        advance
    })

    if (!advance) {
        console.warn(`[Comax Import] ${failed + stats.unparsed} product(s) not written — watermark not advanced, the next run re-fetches the same delta`)
        return { message: 'Import partially failed', count }
    }

    if (count === 0) {
        console.log('[Comax Import] No products to import')
        return { message: 'No products to import', count: 0 }
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
