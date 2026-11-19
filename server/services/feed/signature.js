import { createHash } from 'node:crypto'

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

export const SIGNATURE_TTL_MS = (() => {
    const value = Number(process.env.FEED_SIGNATURE_TTL_MS)
    return Number.isFinite(value) && value >= 0 ? value : 60_000
})()

const CACHE_MAX = 500
const cache = new Map() // domainId -> { value, expiresAt }

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

export async function readFeedSignatureDetails(DL, domainId, { now = new Date() } = {}) {
    const active = DL.Product.constants?.STATUS?.ACTIVE || 'active'
    const productFilter = { status: active, 'prices.domainId': domainId }
    const saleFilter = { status: DL.Sale.constants?.STATUS?.ACTIVE || 'active' }
    const categoryFilter = { active: true }

    const [
        productCount,
        productLatest,
        saleCount,
        saleLatest,
        categoryCount,
        categoryLatest,
        carousels
    ] = await Promise.all([
        DL.Product.Model.countDocuments(productFilter),
        latest(DL.Product.Model, productFilter),
        DL.Sale.Model.countDocuments(saleFilter),
        latest(DL.Sale.Model, saleFilter),
        DL.Category.Model.countDocuments(categoryFilter),
        latest(DL.Category.Model, categoryFilter),
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
        categoryCount,
        millis(categoryLatest),
        carouselHash
    ].join(':')

    return { signature, carousels: carousels || [] }
}

export async function readFeedSignature(DL, domainId, options) {
    const { signature } = await readFeedSignatureDetails(DL, domainId, options)
    return signature
}

export async function readFeedSignatureCached(DL, domainId, { ttlMs = SIGNATURE_TTL_MS, now = Date.now() } = {}) {
    const hit = cache.get(domainId)
    if (hit && hit.expiresAt > now) return hit.value

    const value = await readFeedSignature(DL, domainId)
    remember(domainId, value, ttlMs, now)
    return value
}

// After a generation, seed the cache with the signature that generation stored
// in its meta. Without this the caller's older cached value would immediately
// look "changed" and start a second full scan.
export function seedFeedSignatureCache(domainId, value, { ttlMs = SIGNATURE_TTL_MS, now = Date.now() } = {}) {
    if (!domainId || value == null) return
    remember(domainId, value, ttlMs, now)
}

export function clearFeedSignatureCache(domainId) {
    if (domainId == null) cache.clear()
    else cache.delete(domainId)
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
