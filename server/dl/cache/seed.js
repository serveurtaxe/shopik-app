import { CACHE_STRATEGIES } from '#common/constants.js'

const DEFAULT_CHUNK_SIZE = 5000

function resolveChunkSize(size) {
    const value = Number(size ?? process.env.CACHE_SEED_CHUNK_SIZE)
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_CHUNK_SIZE
}

/**
 * Rebuild a hashset-backed model cache from MongoDB one chunk at a time.
 *
 * The obvious version — `find().lean()` then `cache.add(docs)` — holds the
 * whole collection plus one JSON string per doc in memory before the first
 * HSET is even sent. `gov_addresses` (150k tiny docs) peaks at ~400MB RSS
 * that way, which OOMs a 512MB container. Streaming a cursor and writing
 * `CACHE_SEED_CHUNK_SIZE` docs per HSET keeps the peak flat.
 *
 * @returns {Promise<number>} number of docs seeded
 */
export default async function seedCache(redis, Model, { size, clear = false } = {}) {
    if (Model?.cacheStrategy !== CACHE_STRATEGIES.HASHSET || !Model.cache?.add) return 0

    const chunkSize = resolveChunkSize(size)
    // Callers that only have the model (the reseed path) still get a full
    // rebuild: the cache object knows how to drop its own hash.
    if (clear) {
        if (redis) await redis.del(Model.cacheName)
        else await Model.cache.clear?.()
    }

    let buf = []
    let seeded = 0
    const cursor = Model.find({}, { _id: 0 }).lean().cursor({ batchSize: chunkSize })

    for await (const doc of cursor) {
        buf.push(doc)
        if (buf.length >= chunkSize) {
            await Model.cache.add(buf)
            seeded += buf.length
            buf = []
        }
    }
    if (buf.length) {
        await Model.cache.add(buf)
        seeded += buf.length
    }

    return seeded
}
