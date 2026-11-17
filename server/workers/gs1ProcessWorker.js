import { Worker } from 'bullmq'
import { PROCESS_QUEUE, getConnection } from '#server/queues/gs1Queues.js'
import { processStagedZip, deleteStaged } from '#server/services/gs1/images.js'
import { bufferProduct, bufferRaw, bufferProgress, flush, initBulkFlusher } from '#server/services/gs1/bulk.js'
import { isUploadMain } from '#server/services/image/sourcePriority.js'
import log from '#server/utils/log.js'

// CPU-bound: unzip + sharp + GCS upload for one product.
// Writes go through the bulk flusher — no per-job updateOne calls.
async function handleProcessJob(job, { DL }) {
    const { productId, gtin, stagingPath, fingerprint, runId, mediaAssets = [], reuse = {} } = job.data
    if (!productId || !stagingPath) throw new Error('Missing productId/stagingPath')

    try {
        const product = await DL.Product.readOne(
            { id: productId },
            { _id: 0, id: 1, barcode: 1, images: 1, status: 1 }
        )
        if (!product) return { skipped: 'no-product' }

        // An admin upload outranks supplier media: don't unzip, don't render,
        // don't write — retire the staged zip and mark the raw done.
        const currentMain = (product.images?.product || []).find(img => img?.main)
        if (isUploadMain(currentMain?.sourceUrl)) {
            bufferRaw({ barcode: product.barcode || gtin, imagesDone: true })
            log.info(`[GS1Process] Skipped ${productId} (${gtin}) — uploaded image present`)
            return { skipped: 'upload-present' }
        }

        const { images } = await processStagedZip({
            productId, gtin, path: stagingPath, mediaAssets, fingerprint, reuse
        })

        const update = { 'images.product': images, gs1SyncedAt: new Date() }
        // Mirror the Comax image-gating rule: first image flips imageless HIDDEN → ACTIVE.
        // (status itself stays Comax-owned — only this first-image flip is applied.)
        if ((product.images?.product || []).length === 0 && product.status === 'hidden')
            update.status = 'active'

        bufferProduct(product.barcode || gtin, update)
        bufferRaw({ barcode: product.barcode || gtin, imagesDone: true })
        log.success(`[GS1Process] Done: ${productId} (${gtin})`)
        return { done: true }
    } finally {
        await deleteStaged(stagingPath)
        bufferProgress(runId, { processed: 1 })
        await flush()
    }
}

export default async function startGs1ProcessWorker({ DL, sizing }) {
    initBulkFlusher(DL)
    // No boot-time Redis gate: BullMQ retries its own connection for ever, so a
    // worker started while Redis was down consumes as soon as Redis returns.
    const worker = new Worker(
        PROCESS_QUEUE,
        async job => handleProcessJob(job, { DL }),
        { connection: getConnection(), concurrency: sizing?.cpuConcurrency || 2 }
    )

    worker.on('error', err => log.warn('[GS1Process] Redis notice:', err?.message || err))
    worker.on('failed', (job, err) => log.error(`[GS1Process] Failed ${job?.data?.gtin}:`, err?.message || err))
    return worker
}
