import log from '#server/utils/log.js'
import seedCache from './seed.js'

/**
 * Hashset caches are rebuilt on demand, not only at boot.
 *
 * Seeding used to happen once, while the process started. After Redis restarts
 * (a recreated Redis VM, an OOM, a flush) every hash is empty, and an empty hash
 * is indistinguishable from an empty collection: `read` served `[]` for
 * categories / stores / settings / gov_addresses and nobody fell back to
 * MongoDB. Seeding also only ran while Redis happened to be reachable at boot.
 *
 * A hashset is therefore "suspect" until something has actually built it in this
 * process:
 *   • boot seeding marks each hash it wrote (or verified) as trusted,
 *   • losing Redis while cache writes were skipped marks every hash suspect —
 *     MongoDB kept the truth while the cache was missing its invalidations,
 *   • a read that finds a suspect hash — or an empty hash nothing has verified
 *     against MongoDB — answers from MongoDB and rebuilds the hash in the
 *     background.
 */
const MIN_RESEED_INTERVAL_MS = Number(process.env.CACHE_RESEED_MIN_MS || 30_000)

let suspectEpoch = 0
// cacheName -> { trustedEpoch, verifiedEpoch, lastAttempt, inFlight }
const state = new Map()

const entryOf = Model => {
    const name = Model.cacheName
    let entry = state.get(name)
    if (!entry) {
        // -1: a hash is not "verified" just because nothing has invalidated it.
        entry = { trustedEpoch: 0, verifiedEpoch: -1, lastAttempt: 0, inFlight: null }
        state.set(name, entry)
    }
    return entry
}

/** Every hashset cache must be rebuilt before it can be trusted again. */
export function markCachesSuspect(reason) {
    suspectEpoch++
    log.warn(`[Cache] Hashes are stale (${reason}) — reads use MongoDB until each hash is rebuilt`)
}

export function isCacheSuspect(Model) {
    return entryOf(Model).trustedEpoch < suspectEpoch
}

/** Mark this model's hash as known-good (boot seed / successful rebuild). */
export function trustCache(Model) {
    const entry = entryOf(Model)
    entry.trustedEpoch = suspectEpoch
    entry.verifiedEpoch = suspectEpoch
}

/**
 * Has something in this process reconciled this hash with MongoDB?
 *
 * It is what lets an *empty* hash answer `[]` for a collection that really is
 * empty (a fresh store's geocode_cache), instead of every read falling back to
 * MongoDB and every 30s re-seeding nothing.
 */
export function hasVerifiedCache(Model) {
    return entryOf(Model).verifiedEpoch >= suspectEpoch
}

/**
 * Rebuild one hashset from MongoDB without making the requesting call wait.
 * Deduped per cache and rate-limited so a flap does not re-seed a 150k-document
 * collection repeatedly.
 */
export default function reseedInBackground(Model) {
    // Nothing to write into while Redis cannot answer. The caller is already
    // falling back to MongoDB, and streaming a 150k-document collection into a
    // hash that would discard every write is pure cost during an outage.
    if (Model.cache?.ready?.() !== true) return null

    const entry = entryOf(Model)
    if (entry.inFlight) return entry.inFlight

    const since = Date.now() - entry.lastAttempt
    if (since < MIN_RESEED_INTERVAL_MS) return null

    entry.lastAttempt = Date.now()
    entry.inFlight = (async () => {
        try {
            // clear: drop whatever the hash still holds before streaming the
            // collection back in — the hash may be half-updated, not just empty.
            const seeded = await seedCache(null, Model, { clear: true })
            // Only trust it when the writes actually reached Redis: `add` is a
            // no-op while Redis is down, and trusting a hash that was never
            // built is exactly the bug this module exists to fix.
            if (Model.cache?.ready?.() === true) {
                trustCache(Model)
                log.info(`[Cache] Rebuilt ${Model.modelName}: ${seeded} docs`)
            } else
                log.warn(`[Cache] Rebuild of ${Model.modelName} incomplete (Redis unavailable) — will retry`)
        } catch (error) {
            log.warn(`[Cache] Rebuild failed for ${Model.modelName}:`, error?.message || error)
        } finally {
            entry.inFlight = null
        }
    })()

    return entry.inFlight
}
