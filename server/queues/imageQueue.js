import { Queue } from 'bullmq'
import Redis from 'ioredis'
import { enqueueWithFallback } from '#server/utils/redisSafe.js'
import { REDIS_CONNECT_TIMEOUT_MS, redisBackoffMs } from '#server/utils/redisBackoff.js'

const QUEUE_NAME = 'image-processing'

let queue
let connection

export function getConnection() {
    if (!connection) {
        connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
            connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
            maxRetriesPerRequest: null,
            enableOfflineQueue: true,
            lazyConnect: true,
            retryStrategy: redisBackoffMs
        })
        // lazyConnect keeps importing this module side-effect free; opening the
        // connection here (instead of only when a job is added) is what lets a
        // worker whose Redis came back later start consuming without a redeploy.
        if (connection.status === 'init' || connection.status === 'end')
            connection.connect().catch(() => { })
    }
    return connection
}

export function getQueue() {
    if (!queue)
        queue = new Queue(QUEUE_NAME, { connection: getConnection() })
    return queue
}

/**
 * @returns {Promise<{ enqueued: number, skipped: number }>} never rejects: a
 * down Redis means the jobs are not queued, not a failed import. Products whose
 * image still needs work stay pending in MongoDB, so the next run re-enqueues
 * them (and `jobId` dedupes anything this call managed to push late).
 */
export async function enqueueImageJobs(jobs) {
    if (!jobs?.length) return { enqueued: 0, skipped: 0 }

    return enqueueWithFallback({
        connection: getConnection(),
        label: 'ImageQueue',
        jobs,
        add: () => getQueue().addBulk(
            jobs.map(job => ({
                name: 'process-image',
                data: {
                    productId: job.productId,
                    sourceUrl: job.sourceUrl
                },
                opts: {
                    jobId: `p-${job.productId}`,
                    attempts: 5,
                    backoff: { type: 'exponential', delay: 2 * 60 * 1000 },
                    removeOnComplete: true,
                    removeOnFail: false
                }
            }))
        )
    })
}
