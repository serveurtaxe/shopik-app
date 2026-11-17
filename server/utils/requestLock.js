import log from '#server/utils/log.js'
import { isRedisReady } from '#server/utils/redisSafe.js'

export const REQUEST_LOCK_TTL_SEC = 30

const LOCAL_SWEEP_AT = 500
// key -> { token, expiresAt }
const localLocks = new Map()

/**
 * Duplicate-submit guard for routes marked `preventMultiple`.
 *
 * Redis held these locks, and when Redis was down `DL.redis.set` rejected:
 * the handler threw and every such route answered 500 — while the `finally`
 * that released the lock rejected too. With no Redis there is still exactly one
 * container running this request (Cloud Run scales tenants to a single
 * instance), so an in-process lock covers what the Redis lock was covering.
 *
 * @returns {Promise<(() => Promise<void>)|null>} release function, or null when held
 */
export async function acquireRequestLock({ redis, key, token, ttlSec = REQUEST_LOCK_TTL_SEC }) {
    if (isRedisReady(redis)) {
        try {
            const acquired = await redis.set(key, token, 'NX', 'EX', ttlSec)
            if (!acquired) return null
            return async () => { await redis.del(key).catch(() => { }) }
        } catch (error) {
            log.warn('[Lock] Request lock fell back to this process:', error?.message || error)
        }
    }

    const now = Date.now()
    if (localLocks.size >= LOCAL_SWEEP_AT) {
        for (const [held, { expiresAt }] of localLocks)
            if (expiresAt <= now) localLocks.delete(held)
    }

    const held = localLocks.get(key)
    if (held && held.expiresAt > now) return null

    localLocks.set(key, { token, expiresAt: now + ttlSec * 1000 })
    return async () => {
        if (localLocks.get(key)?.token === token) localLocks.delete(key)
    }
}
