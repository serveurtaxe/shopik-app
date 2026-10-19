import { Worker } from 'bullmq'
import { createHash } from 'crypto'
import processImage from '#server/services/image/process.js'
import { isMainImageComplete } from '#server/services/image/constants.js'
import { getConnection, getQueue } from '#server/queues/imageQueue.js'
import log from '#server/utils/log.js'

const QUEUE_NAME = 'image-processing'
const hashUrl = url => createHash('sha1').update(url).digest('hex')

export default async function startImageWorker({ DL }) {
    const connection = getConnection()

    try {
        await Promise.race([
            connection.ping(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Redis unreachable (timeout)')), 2000))
        ])
    } catch (e) {
        log.warn('[ImageWorker] Redis unavailable, worker not started:', e?.message || e)
        return null
    }

    const worker = new Worker(
        QUEUE_NAME,
        async job => {
            const { productId, sourceUrl } = job.data
            if (!productId || !sourceUrl)
                throw new Error(`Invalid job data: ${JSON.stringify(job.data)}`)

            // Race guard: a GS1 image may have landed between enqueue and
            // processing — never overwrite it (enqueue gate already filters,
            // this covers the window).
            const current = await DL.Product.readOne(
                { id: productId },
                { _id: 0, images: 1 }
            ).catch(() => null)
            const currentMain = (current?.images?.product || []).find(img => img?.main)
            if (currentMain?.sourceUrl?.startsWith('gs1://')) {
                log.warn(`[ImageWorker] Skipped ${productId} — GS1 image present`)
                return { skipped: 'gs1-present' }
            }
            // Race guard: a scraped image may have landed between enqueue and
            // processing — a Comax picUrl job must never overwrite it
            // (priority GS1 > scrape > Comax). Scrape/GS1 jobs still proceed.
            if (currentMain?.sourceUrl?.startsWith('scrape://') &&
                !sourceUrl.startsWith('scrape://') && !sourceUrl.startsWith('gs1://')) {
                log.warn(`[ImageWorker] Skipped ${productId} — scraped image present`)
                return { skipped: 'scrape-present' }
            }

            // Unchanged source with a complete previous write → skip the
            // expensive download/resize/upload (covers duplicate enqueues,
            // retries, and enqueue→process races).
            if (isMainImageComplete(currentMain, sourceUrl)) {
                log.info(`[ImageWorker] Skipped ${productId} — source unchanged`)
                return { skipped: 'unchanged' }
            }

            const start = performance.now()
            const sizes = await processImage({ productId, sourceUrl })
            console.log(`Resize took ${performance.now() - start}ms`)

            await DL.Product.update(
                { id: productId },
                {
                    'images.product': [
                        { main: true, sourceUrl, hash: hashUrl(sourceUrl), sizes }
                    ]
                }
            )

            log.success(`[ImageWorker] Done: ${productId}`)
        },
        {
            connection: getConnection(),
            concurrency: 4
        }
    )

    worker.on('error', err => {
        log.warn('[ImageWorker] Redis notice:', err?.message || err)
    })

    worker.on('failed', (job, err) => {
        log.error(`[ImageWorker] Failed ${job?.id} (${job?.data?.productId}):`, err?.message || err)
    })

    worker.on('completed', async job => {
        try {
            const counts = await getQueue().getJobCounts('waiting', 'active', 'delayed', 'failed')
            log.info(`[ImageWorker] Completed ${job?.data?.productId} — remaining: ${counts.waiting + counts.delayed} queued, ${counts.active} active, ${counts.failed} failed`)
        } catch (e) {
            log.warn('[ImageWorker] Queue count skipped:', e?.message || e)
        }
    })

    return worker
}