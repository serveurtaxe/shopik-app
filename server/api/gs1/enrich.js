import { runEnrich, runImages } from '#server/services/gs1/enrich.js'
import { initBulkFlusher } from '#server/services/gs1/bulk.js'

// POST /api/gs1/enrich {onlyInStock?, images?, forceImages?, imageLimit?, barcode?}
// Phase 2 (texts) and optionally phase 3 launch. forceImages reprocesses images
// even when the main fingerprint matches (backfills alternates onto
// pre-alternates mains; single-still products are still skipped). imageLimit caps
// raw docs taken per call (0 = all) — repeat until queued=0 to stay inside
// Cloud Run request timeouts on large backfills. barcode scopes both phases to
// one product (a single-product probe: GS1 answers for our account from anywhere
// the credentials work, so this also runs from a dev machine). onlyInStock:false
// is what a catalog backfill needs — those rows have a Comax row and no in-stock
// Product, so the stock gate would skip every one of them.
export default async function gs1Enrich(payload, { DL, external }) {
    initBulkFlusher(DL)
    const onlyInStock = payload?.onlyInStock ?? true
    const barcode = payload?.barcode || ''
    const runId = `enrich:${Date.now()}`
    const texts = await runEnrich({
        DL,
        external,
        runId,
        onlyInStock,
        barcode,
        force: payload?.forceTexts ?? false
    })
    let images = null
    if (payload?.images) {
        images = await runImages({
            DL, external, runId, barcode,
            force: payload?.forceImages ?? false,
            limit: payload?.imageLimit ?? 0
        })
    }
    return { runId, texts, images }
}

gs1Enrich.config = {
    required: [],
    permissions: ['product:update'],
    auth: 'required',
    preventMultiple: true
}
