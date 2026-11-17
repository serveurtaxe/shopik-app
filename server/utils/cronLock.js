import log from '#server/utils/log.js'
import CronLock from '#server/dl/models/cronLock.js'

/**
 * Cron job lock, held in MongoDB.
 *
 * These used to be Redis `SET key token NX EX ttl`. With Redis down that
 * command either threw or returned null, and *every* cron job then logged
 * "another instance holds the lock" and skipped: the outage silently switched
 * off nightly sync, sales sync, invoice retries, holiday seeding. MongoDB is
 * the one thing this app cannot run without, so the lock belongs there.
 *
 * @param {string} key
 * @param {number} ttlSeconds how long a crashed holder may keep the lock
 * @param {{ Model?: import('mongoose').Model }} [options] injectable for tests
 * @returns {Promise<(() => Promise<void>)|null>} release function, or null when held
 */
export async function acquireLock(key, ttlSeconds, { Model = CronLock } = {}) {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000)
    const token = `${process.pid}-${now.toISOString()}`

    try {
        // Matches only when the lock is absent or expired. When a live lock is
        // held the upsert collides with the unique index on `key` (E11000),
        // which is what makes this one round trip atomic.
        const taken = await Model.findOneAndUpdate(
            { key, expiresAt: { $lt: now } },
            { $set: { token, expiresAt } },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        ).lean()

        if (!taken) return null
        return () => releaseLock(key, token, Model)
    } catch (error) {
        if (isDuplicateKey(error)) return null
        // An unreadable lock must not let two processes run the same job.
        log.error(`[Lock] Could not acquire "${key}":`, error?.message || error)
        return null
    }
}

const isDuplicateKey = error =>
    error?.code === 11000 ||
    error?.codeName === 'DuplicateKeyError' ||
    error?.writeErrors?.[0]?.code === 11000 ||
    error?.cause?.code === 11000

async function releaseLock(key, token, Model) {
    try {
        await Model.deleteOne({ key, token })
    } catch (error) {
        // The TTL index clears it otherwise; the job already finished.
        log.warn(`[Lock] Could not release "${key}":`, error?.message || error)
    }
}

export default acquireLock
