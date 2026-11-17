import log from '#server/utils/log.js'
import { MENU_CACHE_KEY } from '#common/constants.js'

/**
 * Ad-hoc Redis commands (auth cache, page cache, invalidations, queue writes) are
 * an accelerator, never a dependency.
 *
 * `DL.redis` is a live client even while Redis is unreachable, and with
 * `enableOfflineQueue: false` every command on it rejects — so an unguarded
 * `DL.redis.get(...)` turned every authenticated request into a 500 during a
 * Redis outage, and `DL.redis.set(...)` after a successful login 500'd a login
 * that had already been written to MongoDB. Going through here makes a down
 * Redis mean "cache miss" (read) or "nothing to invalidate" (write): every
 * helper here answers the shape a miss would answer, and never throws.
 */
export const isRedisReady = redis => redis?.status === 'ready'

const skipped = (what, error) => log.warn(`Redis ${what} skipped:`, error?.message || error)

/** @returns cached value, or null on miss / Redis unavailable */
export async function redisGet(redis, key) {
    if (!isRedisReady(redis)) return null
    try {
        return await redis.get(key)
    } catch (error) {
        skipped('get', error)
        return null
    }
}

/** @returns 'OK' when written, null when Redis unavailable */
export async function redisSet(redis, key, value, ...args) {
    if (!isRedisReady(redis)) return null
    try {
        return await redis.set(key, value, ...args)
    } catch (error) {
        skipped('set', error)
        return null
    }
}

/** @returns number of keys removed (0 when Redis unavailable) */
export async function redisDel(redis, ...keys) {
    const flat = keys.flat().filter(Boolean)
    if (!flat.length || !isRedisReady(redis)) return 0
    try {
        return await redis.del(...flat)
    } catch (error) {
        skipped('del', error)
        return 0
    }
}

// BullMQ clients keep `enableOfflineQueue: true` (a worker must survive a flap),
// which means an `add` issued while Redis is down waits instead of failing.
// Cron and admin routes must not wait for it: bound the wait, report the batch
// as skipped. The state that decides what needs queueing lives in MongoDB, so
// the next run re-enqueues whatever was dropped.
export const QUEUE_TIMEOUT_MS = (() => {
    const value = Number(process.env.REDIS_QUEUE_TIMEOUT_MS)
    return Number.isFinite(value) && value > 0 ? value : 5000
})()

/**
 * @param {{ connection: import('ioredis'), label: string, jobs: Array, add: () => Promise<any> }} options
 * @returns {Promise<{ enqueued: number, skipped: number }>}
 */
export async function enqueueWithFallback({ connection, label, jobs, add }) {
    if (!jobs?.length) return { enqueued: 0, skipped: 0 }

    if (!isRedisReady(connection)) {
        log.warn(`[${label}] Redis unavailable — ${jobs.length} job(s) not queued, the next run will re-enqueue them`)
        return { enqueued: 0, skipped: jobs.length }
    }

    let timer
    try {
        await Promise.race([
            add(),
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`queue write timed out after ${QUEUE_TIMEOUT_MS}ms`)),
                    QUEUE_TIMEOUT_MS
                )
            })
        ])
        return { enqueued: jobs.length, skipped: 0 }
    } catch (error) {
        skipped(`${label} enqueue`, error)
        // A command queued in ioredis may still be flushed if Redis returns, and
        // every job here is jobId-deduped, so a later re-enqueue cannot double it.
        return { enqueued: 0, skipped: jobs.length }
    } finally {
        clearTimeout(timer)
    }
}

/** Delete every key matching a pattern. 0 when Redis cannot answer. */
export async function scanDel(redis, pattern) {
    if (!isRedisReady(redis)) return 0
    let cursor = '0'
    let deleted = 0
    try {
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500)
            cursor = next
            if (keys?.length) deleted += await redis.del(keys)
        } while (cursor !== '0')
    } catch (error) {
        skipped(`scan ${pattern}`, error)
    }
    return deleted
}

/**
 * Ad-hoc caches whose invalidation was skipped while Redis was down.
 *
 * Model hashsets are handled by the suspect-epoch (they have no TTL at all);
 * these keys do have TTLs, so the staleness they can keep is bounded — but 24h
 * of a stale `admin_auth` payload is stale *authorisation*, and a stale
 * `user_auth` payload can keep a session that MongoDB already revoked alive.
 * Dropping them once, when Redis comes back, is cheaper than reasoning about
 * which writes were missed.
 *
 * `otp_send:*` / `rl:*` are deliberately absent: resetting rate counters mid
 * outage would weaken the SMS-flood guards instead of delaying them.
 */
export const STALE_AFTER_OUTAGE = [
    'user_auth:*',
    'admin_auth:*',
    'user_store:*',
    MENU_CACHE_KEY,
    `${MENU_CACHE_KEY}:*`,
    'display:*'
]

export async function purgeStaleCaches(redis, patterns = STALE_AFTER_OUTAGE) {
    if (!isRedisReady(redis)) return 0

    let removed = 0
    for (const pattern of patterns)
        removed += await scanDel(redis, pattern)

    if (removed) log.warn(`[Redis] Dropped ${removed} cache key(s) left stale by the outage`)
    return removed
}
