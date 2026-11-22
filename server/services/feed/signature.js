import { createHash } from 'node:crypto'
import { redisGet, redisSet } from '#server/utils/redisSafe.js'

// A cheap fingerprint of everything the sitemap and the Google feed depend on.
//
// Counting as well as taking max(updatedAt) is deliberate: deleting a product
// (or moving it out of a domain) lowers the count without bumping any document
// that remains, so max(updatedAt) alone would miss it. Every real edit bumps
// updatedAt, so a changed signature means "regenerate"; an equal signature means
// "serve the files we already have" with zero catalog reads.
//
// Sales and categories are part of the fingerprint because the feed's sale
// price comes from Sale documents (a price edit need not touch the product) and
// category paths feed the pages sitemap (a rename edits Category, not Product).
// Carousels contribute their *visible ids*, so a schedule window opening or
// closing changes the pages sitemap even though no document was written.
//
// Two layers keep the cost of this check low:
//   - in-process: a value + expiry per domain, refreshed at most once per TTL;
//   - shared: the computed value is also published to Redis, so N instances
//     behind a load balancer pay for one computation per TTL instead of N.
// Concurrent callers in the same process share one in-flight computation.

export const SIGNATURE_TTL_MS = (() => {
    const value = Number(process.env.FEED_SIGNATURE_TTL_MS)
    return Number.isFinite(value) && value >= 0 ? value : 5 * 60_000
})()

const CACHE_MAX = 500
const SHARED_PREFIX = 'feed:sig:v1:'
const cache = new Map() // domainId -> { value, expiresAt }
const inFlight = new Map() // domainId -> Promise<string>

export function isScheduled(block, now = new Date()) {
    const start = block?.schedule?.start
    const end = block?.schedule?.end
    if (start && new Date(start) > now) return false
    if (end && new Date(end) < now) return false
    return true
}

export async function readVisibleCarousels(DL, domainId, now = new Date()) {
    const blocks = await DL.DisplayBlock.Model.find(
        { domainId, active: true, kind: DL.DisplayBlock.constants?.KIND?.PRODUCT_CAROUSEL || 'product_carousel' },
        { _id: 0, id: 1, schedule: 1 }
    ).lean()
    return (blocks || []).filter(block => isScheduled(block, now))
}

const millis = doc => {
    const value = doc?.updatedAt ? new Date(doc.updatedAt).getTime() : 0
    return Number.isFinite(value) ? value : 0
}

const latest = (Model, filter) =>
    Model.findOne(filter, { _id: 0, updatedAt: 1 }).sort({ updatedAt: -1 }).lean()

// Category is a Redis hashset (CACHE_STRATEGIES.HASHSET), so this read is
// answered by Redis while the hash is warm and only falls back to Mongo when it
// is not. That removes two Mongo queries per signature cycle without changing
// the freshness guarantee: a rename still bumps Category.updatedAt.
async function readCategoryFingerprint(DL) {
    const categories = await DL.Category.read(
        { active: true },
        { _id: 0, updatedAt: 1 },
        { limit: 0 }
    )
    let latest = 0
    for (const category of categories || []) {
        const value = millis(category)
        if (value > latest) latest = value
    }
    return { count: (categories || []).length, latest }
}

export async function readFeedSignatureDetails(DL, domainId, { now = new Date() } = {}) {
    const active = DL.Product.constants?.STATUS?.ACTIVE || 'active'
    const productFilter = { status: active, 'prices.domainId': domainId }
    const saleFilter = { status: DL.Sale.constants?.STATUS?.ACTIVE || 'active' }

    const [
        productCount,
        productLatest,
        saleCount,
        saleLatest,
        categories,
        carousels
    ] = await Promise.all([
        DL.Product.Model.countDocuments(productFilter),
        latest(DL.Product.Model, productFilter),
        DL.Sale.Model.countDocuments(saleFilter),
        latest(DL.Sale.Model, saleFilter),
        readCategoryFingerprint(DL),
        readVisibleCarousels(DL, domainId, now)
    ])

    const carouselHash = createHash('sha1')
        .update((carousels || []).map(block => String(block.id)).sort().join(','))
        .digest('hex')
        .slice(0, 16)

    const signature = [
        productCount,
        millis(productLatest),
        saleCount,
        millis(saleLatest),
        categories.count,
        categories.latest,
        carouselHash
    ].join(':')

    return { signature, carousels: carousels || [] }
}

export async function readFeedSignature(DL, domainId, options) {
    const { signature } = await readFeedSignatureDetails(DL, domainId, options)
    return signature
}

export async function readFeedSignatureCached(DL, domainId, { ttlMs = SIGNATURE_TTL_MS, now = Date.now() } = {}) {
    if (ttlMs > 0) {
        const hit = cache.get(domainId)
        if (hit && hit.expiresAt > now) return hit.value
    }

    // A burst (index + pages + several chunks) must not fan out into one
    // 6-query signature computation per request. Later callers join the first.
    const running = inFlight.get(domainId)
    if (running) return running

    const promise = resolveSignature(DL, domainId, ttlMs, now)
    inFlight.set(domainId, promise)
    try {
        return await promise
    } finally {
        if (inFlight.get(domainId) === promise) inFlight.delete(domainId)
    }
}

async function resolveSignature(DL, domainId, ttlMs, now) {
    if (ttlMs > 0) {
        const shared = await readSharedSignature(DL, domainId)
        if (shared != null) {
            remember(domainId, shared, ttlMs, now)
            return shared
        }
    }

    const value = await readFeedSignature(DL, domainId)
    if (ttlMs > 0) {
        remember(domainId, value, ttlMs, now)
        await writeSharedSignature(DL, domainId, value, ttlMs)
    }
    return value
}

async function readSharedSignature(DL, domainId) {
    const raw = await redisGet(DL?.redis, `${SHARED_PREFIX}${domainId}`)
    return raw == null || raw === '' ? null : String(raw)
}

async function writeSharedSignature(DL, domainId, value, ttlMs) {
    if (!domainId || value == null || !(ttlMs > 0)) return
    await redisSet(
        DL?.redis,
        `${SHARED_PREFIX}${domainId}`,
        String(value),
        'PX',
        Math.max(1, Math.round(ttlMs))
    )
}

// After a generation, seed the cache with the signature that generation stored
// in its meta. Without this the caller's older cached value would immediately
// look "changed" and start a second full scan. The shared copy is updated too,
// so another instance picks up the new generation without recomputing.
export async function seedFeedSignatureCache(DL, domainId, value, { ttlMs = SIGNATURE_TTL_MS, now = Date.now() } = {}) {
    if (!domainId || value == null) return
    if (ttlMs > 0) remember(domainId, value, ttlMs, now)
    await writeSharedSignature(DL, domainId, value, ttlMs)
}

export function clearFeedSignatureCache(domainId) {
    if (domainId == null) {
        cache.clear()
        inFlight.clear()
    } else {
        cache.delete(domainId)
    }
}

function remember(domainId, value, ttlMs, now) {
    if (cache.size >= CACHE_MAX && !cache.has(domainId)) {
        for (const [key, entry] of cache) {
            if (entry.expiresAt <= now) cache.delete(key)
        }
        while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
    }
    cache.set(domainId, { value, expiresAt: now + Math.max(0, ttlMs) })
}
