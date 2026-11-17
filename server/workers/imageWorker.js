import { Worker } from 'bullmq'
import { createHash } from 'crypto'
import processImage from '#server/services/image/process.js'
import { isMainImageComplete } from '#server/services/image/constants.js'
import { outranks, sourceLabel } from '#server/services/image/sourcePriority.js'
import { getConnection, getQueue } from '#server/queues/imageQueue.js'
import log from '#server/utils/log.js'

const QUEUE_NAME = 'image-processing'
const hashUrl = url => createHash('sha1').update(url).digest('hex')

export default async function startImageWorker({ DL }) {
    // No boot-time Redis gate. A ping gate meant a container that started while
    // Redis was down never had a worker — the jobs sat in the queue until a
    // redeploy. BullMQ owns the connection (infinite retry curve, offline
    // queue), so starting the worker now is safe: it begins consuming the
    // moment Redis answers.
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
            // Race guard: a higher-ranked main may have landed between enqueue
            // and processing. Every job on this queue is a Comax picUrl (the
            // upload tool and the scraper both write inline), so one rank check
            // covers upload / gs1 / scrape.
            if (outranks(currentMain?.sourceUrl, sourceUrl)) {
                const owner = sourceLabel(currentMain.sourceUrl)
                log.warn(`[ImageWorker] Skipped ${productId} — ${owner} image present`)
                return { skipped: `${owner}-present` }
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