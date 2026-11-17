import { Worker } from 'bullmq'
import { FETCH_QUEUE, getConnection } from '#server/queues/gs1Queues.js'
import { buildFingerprint, hashFingerprint } from '#server/services/gs1/images.js'
import { bufferRaw, bufferProgress, initBulkFlusher } from '#server/services/gs1/bulk.js'
import { gtinOf } from '#server/services/gs1/gtin.js'
import log from '#server/utils/log.js'

// "Not in our GS1 account" is an ANSWER, not a failure: GS1 visibility is
// per-customer, so most of our catalog codes are simply absent there. Record it
// as a dated skipped doc (no raw) so the catalog report can distinguish "we
// never checked" from "we checked and GS1 does not carry it for us", and return
// it instead of throwing — a thrown 4xx is retried five times with a two-minute
// exponential backoff, which for a catalog-wide sweep is hours of dead traffic.
// Non-GTIN codes get no doc: a Comax item id is not a barcode and storing one
// under `barcode` would pollute a barcode-keyed collection.
function recordNoGs1Record(productCode, runId) {
    bufferProgress(runId, { processed: 1 })
    const gtin = gtinOf(productCode)
    if (gtin)
        bufferRaw({ barcode: gtin, status: 'skipped', skipReason: 'no-gs1-record', syncedAt: new Date() })
    return { skipped: 'no-gs1-record', gtin: gtin || null }
}

// Phase 1 (network-only): dump GS1 JSON into gs1_products. No gates, no zips,
// no product writes — enrich and images run later, purely from the collection.
async function handleFetchJob(job, { DL, external }) {
    const { productCode, runId, force = false } = job.data
    if (!productCode) throw new Error('Missing productCode')

    const item = await external.gs1.getProduct(productCode)
    if (!item) return recordNoGs1Record(productCode, runId)

    const { rawDoc, gtin, modificationTime, mediaAssets } = external.gs1.mapGs1ToProduct(item)
    const fingerprint = hashFingerprint(buildFingerprint(gtin, mediaAssets, modificationTime))

    // Freshness against our own dump: skip re-store when nothing changed.
    if (!force) {
        const stored = await DL.Gs1Product.readOne(
            { barcode: gtin },
            { _id: 0, modificationTime: 1, fingerprint: 1 }
        ).catch(() => null)
        if (stored?.modificationTime && modificationTime
            && new Date(modificationTime) <= new Date(stored.modificationTime)
            && stored.fingerprint === fingerprint) {
            bufferProgress(runId, { processed: 1 })
            return { skipped: 'up-to-date' }
        }
    }

    bufferRaw({ ...rawDoc, fingerprint, status: 'fetched' })
    bufferProgress(runId, { processed: 1 })
    return { fetched: true, gtin }
}

export default async function startGs1FetchWorker({ DL, external, sizing }) {
    initBulkFlusher(DL)
    // No boot-time Redis gate: BullMQ retries its own connection for ever, so a
    // worker started while Redis was down consumes as soon as Redis returns.
    const worker = new Worker(
        FETCH_QUEUE,
        async job => {
            try {
                return await handleFetchJob(job, { DL, external })
            } catch (e) {
                // Not in our GS1 account → terminal, recorded, no retry.
                if (e?.notFound) return recordNoGs1Record(job?.data?.productCode, job?.data?.runId)
                // 429/5xx → BullMQ backoff retry; fatal errors count as failed.
                if (e?.rateLimited || e?.transient) throw e
                if (/GS1 (401|HTTP 4)/.test(e?.message || '')) throw e
                log.error(`[GS1Fetch] Failed ${job?.data?.productCode}:`, e?.message || e)
                bufferProgress(job?.data?.runId, { processed: 1, failed: 1 })
                return { failed: true }
            }
        },
        { connection: getConnection(), concurrency: sizing?.fetchConcurrency || 2 }
    )

    worker.on('error', err => log.warn('[GS1Fetch] Redis notice:', err?.message || err))
    worker.on('failed', (job, err) => log.error(`[GS1Fetch] Failed ${job?.data?.productCode}:`, err?.message || err))
    return worker
}
