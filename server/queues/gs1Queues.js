import { Queue } from 'bullmq'
import Redis from 'ioredis'
import { enqueueWithFallback } from '#server/utils/redisSafe.js'
import { REDIS_CONNECT_TIMEOUT_MS, redisBackoffMs } from '#server/utils/redisBackoff.js'

export const FETCH_QUEUE = 'gs1-fetch'
export const PROCESS_QUEUE = 'gs1-process'

let connection
let fetchQueue
let processQueue

export function getConnection() {
    if (!connection) {
        connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
            connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
            maxRetriesPerRequest: null,
            enableOfflineQueue: true,
            lazyConnect: true,
            retryStrategy: redisBackoffMs
        })
        // Same reason as in imageQueue: open it now so a worker that started
        // while Redis was down picks it up when Redis returns.
        if (connection.status === 'init' || connection.status === 'end')
            connection.connect().catch(() => { })
    }
    return connection
}

// Rate limiter caps GS1 egress; raised empirically once 429/503 behavior is known.
// BullMQ limiter = max N jobs per `duration` window on the fetch queue.
export function getFetchQueue() {
    if (!fetchQueue) {
        fetchQueue = new Queue(FETCH_QUEUE, {
            connection: getConnection(),
            limiter: {
                max: Number(process.env.GS1_FETCH_MAX_PER_MIN || 60),
                duration: 60 * 1000
            }
        })
    }
    return fetchQueue
}

export function getProcessQueue() {
    if (!processQueue)
        processQueue = new Queue(PROCESS_QUEUE, { connection: getConnection() })
    return processQueue
}

const attempts = 5
const backoff = { type: 'exponential', delay: 2 * 60 * 1000 }

// BullMQ builds the whole command payload for addBulk at once; a bootstrap
// run can be ~9k jobs, so send them in bounded batches.
const enqueueChunkSize = () => {
    const value = Number(process.env.GS1_ENQUEUE_CHUNK || 500)
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 500
}

export async function addBulkInChunks(queue, jobs) {
    const size = enqueueChunkSize()
    for (let i = 0; i < jobs.length; i += size)
        await queue.addBulk(jobs.slice(i, i + size))
}

// jobId dedupes re-enqueues of the same product code across overlapping runs.
// Fail-soft: a down Redis reports the batch as skipped instead of failing the
// run — the sync state in MongoDB still says these codes need looking up, so the
// next run queues them again.
export async function enqueueFetchJobs(jobs) {
    if (!jobs?.length) return { enqueued: 0, skipped: 0 }
    const queued = jobs.map(job => ({
        name: 'fetch-product',
        data: job,
        opts: {
            jobId: `gs1-${job.productCode}`,
            attempts,
            backoff,
            removeOnComplete: true,
            removeOnFail: false
        }
    }))

    return enqueueWithFallback({
        connection: getConnection(),
        label: 'GS1FetchQueue',
        jobs: queued,
        add: () => addBulkInChunks(getFetchQueue(), queued)
    })
}

export async function enqueueProcessJobs(jobs) {
    if (!jobs?.length) return { enqueued: 0, skipped: 0 }
    const queued = jobs.map(job => ({
        name: 'process-images',
        data: job,
        opts: {
            jobId: `gs1img-${job.productId}`,
            attempts,
            backoff,
            removeOnComplete: true,
            removeOnFail: false
        }
    }))

    return enqueueWithFallback({
        connection: getConnection(),
        label: 'GS1ProcessQueue',
        jobs: queued,
        add: () => addBulkInChunks(getProcessQueue(), queued)
    })
}

export default { getConnection, getFetchQueue, getProcessQueue, enqueueFetchJobs, enqueueProcessJobs }
