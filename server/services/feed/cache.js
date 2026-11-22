import log from '#server/utils/log.js'
import { redisGet, redisSet } from '#server/utils/redisSafe.js'
import { acquireLock } from '#server/utils/cronLock.js'
import { generateFeeds, makeGenerationId } from './build.js'
import { emptyUrlset } from './render.js'
import { readFeedSignatureCached, seedFeedSignatureCache } from './signature.js'

// Cache layout:
//   feed:meta:v1:<domainId>              -> JSON pointer (generation + signature)
//   feed:file:v1:<domainId>:<gen>:<name> -> XML
//
// Files are written before the meta pointer is swapped, so a reader always sees
// one complete generation. Old generations keep their TTL and are never
// partially visible; in-flight readers holding the previous meta still work.
//
// Redis is an accelerator, not a dependency (same rule as utils/redisSafe.js).
// Meta and files fall back to a small in-process store while Redis is down, so
// a catalog that was just built can still be served through an outage.

export const FEED_FILE_TTL_SEC = (() => {
    const value = Number(process.env.FEED_FILE_TTL_SEC)
    return Number.isFinite(value) && value > 0 ? value : 24 * 60 * 60
})()

const META_PREFIX = 'feed:meta:v1:'
const FILE_PREFIX = 'feed:file:v1:'
// Generation is seconds, not minutes, even for a large catalog (≈7.4k products
// in ~2s). A short TTL means a process that dies mid-build blocks requests with
// 503 only briefly instead of for half an hour.
const LOCK_TTL_SEC = 5 * 60

const MEMORY_CACHE_MAX_BYTES = (() => {
    const value = Number(process.env.FEED_MEMORY_CACHE_MB)
    return (Number.isFinite(value) && value > 0 ? value : 64) * 1024 * 1024
})()

const memory = new Map()
let memoryBytes = 0

const metaKey = domainId => `${META_PREFIX}${domainId}`
const fileKey = (domainId, gen, name) => `${FILE_PREFIX}${domainId}:${gen}:${name}`

function memoryGet(key) {
    const entry = memory.get(key)
    if (!entry) return null
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
        memory.delete(key)
        memoryBytes -= entry.bytes
        return null
    }
    return entry.value
}

function memorySet(key, value, ttlSec = 0) {
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > MEMORY_CACHE_MAX_BYTES) return false

    const previous = memory.get(key)
    if (previous) {
        memory.delete(key)
        memoryBytes -= previous.bytes
    }
    while (memoryBytes + bytes > MEMORY_CACHE_MAX_BYTES && memory.size) {
        const [oldKey, oldEntry] = memory.entries().next().value
        memory.delete(oldKey)
        memoryBytes -= oldEntry.bytes
    }
    memory.set(key, {
        value,
        bytes,
        expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : 0
    })
    memoryBytes += bytes
    return true
}

export function clearFeedMemoryCache() {
    memory.clear()
    memoryBytes = 0
}

async function readMeta(redis, domainId) {
    const key = metaKey(domainId)
    const raw = await redisGet(redis, key)
    const source = raw || memoryGet(key)
    if (!source) return null
    try {
        return JSON.parse(source)
    } catch {
        return null
    }
}

async function writeMeta(redis, domainId, meta) {
    const raw = JSON.stringify(meta)
    // Meta is tiny and is the only thing that must survive a Redis outage to
    // keep the last generation addressable in this process.
    memorySet(metaKey(domainId), raw)
    await redisSet(redis, metaKey(domainId), raw)
}

async function readFile(redis, domainId, gen, name) {
    const key = fileKey(domainId, gen, name)
    const value = await redisGet(redis, key)
    return value != null ? value : memoryGet(key)
}

async function writeFile(redis, domainId, gen, name, xml) {
    const key = fileKey(domainId, gen, name)
    const result = await redisSet(redis, key, xml, 'EX', FEED_FILE_TTL_SEC)
    if (result !== 'OK') memorySet(key, xml, FEED_FILE_TTL_SEC)
}

const inFlight = new Map() // domainId -> Promise<meta|null>

export function isFeedGenerating(domainId) {
    return inFlight.has(domainId)
}

async function runGeneration(DL, domain, lockFn) {
    const running = inFlight.get(domain.domainId)
    if (running) return running

    const promise = buildOnce(DL, domain, lockFn)
    inFlight.set(domain.domainId, promise)
    try {
        return await promise
    } finally {
        if (inFlight.get(domain.domainId) === promise) inFlight.delete(domain.domainId)
    }
}

async function buildOnce(DL, domain, lockFn) {
    let release
    try {
        release = await lockFn(`feed:build:${domain.domainId}`, LOCK_TTL_SEC)
        if (!release) return null
    } catch (error) {
        log.warn('[Feed] Could not acquire build lock:', error?.message || error)
        return null
    }

    try {
        const gen = makeGenerationId()
        const meta = await generateFeeds({
            DL,
            domain,
            gen,
            writeFile: (name, xml) => writeFile(DL.redis, domain.domainId, gen, name, xml)
        })
        await writeMeta(DL.redis, domain.domainId, meta)
        // The generation fingerprinted the catalog itself; adopt that value so
        // the caller's older cached signature does not immediately trigger a
        // second scan. Publishing it to Redis also updates the other instances.
        await seedFeedSignatureCache(DL, domain.domainId, meta.signature)
        log.info(`[Feed] Generated ${domain.domainId}: ${meta.products} products, ${meta.chunks} sitemap chunks, ${meta.items} feed items`)
        return meta
    } catch (error) {
        // Never break the request: the previous generation (if any) is still
        // addressable and will keep being served.
        log.error('[Feed] Generation failed:', error?.message || error)
        return null
    } finally {
        try {
            await release?.()
        } catch { }
    }
}

// Cache keys drop the `.xml` suffix (routes normalize it away), so the chunk
// number must be parsed from the key form.
const PRODUCT_CHUNK = /^sitemap-products-([1-9]\d*)$/

function emptyChunk(meta, file) {
    return { xml: emptyUrlset(), etag: `"${meta.gen}-${file}-empty"` }
}

/**
 * Resolve one sitemap/feed file for a request.
 *
 * @returns {Promise<{xml: string, etag: string}|null>} null when there is no
 * generation to serve (cold build failed). An out-of-range product chunk is a
 * valid, empty urlset with 200 so a crawler following a slightly older index
 * never sees a 404.
 */
export async function getFeedFile({ DL, domain, file, lockFn = acquireLock }) {
    const domainId = domain?.domainId
    if (!domainId) return null

    const chunkMatch = PRODUCT_CHUNK.exec(file)
    const chunkNumber = chunkMatch ? Number(chunkMatch[1]) : null

    let meta = await readMeta(DL.redis, domainId)
    if (!meta) {
        meta = await runGeneration(DL, domain, lockFn)
        if (!meta) meta = await readMeta(DL.redis, domainId)
    }
    if (!meta) return null

    if (chunkNumber && chunkNumber > (meta.chunks || 0)) return emptyChunk(meta, file)

    // Freshness gate. A local hit costs one Redis GET for the meta (above) and
    // no catalog reads at all; a miss costs one shared Redis signature read,
    // and only if that is missing too does anything touch Mongo.
    let signature
    try {
        signature = await readFeedSignatureCached(DL, domainId)
    } catch {
        signature = meta.signature
    }
    if (signature !== meta.signature) {
        // Stale-while-revalidate: answer with the generation we have and refresh
        // in the background. Only a cold start waits for a build.
        runGeneration(DL, domain, lockFn).catch(() => { })
    }

    let xml = await readFile(DL.redis, domainId, meta.gen, file)
    if (xml == null) {
        // Meta survived but its file did not (Redis restart / eviction). Build
        // once more rather than 404 a URL the index still advertises.
        const rebuilt = await runGeneration(DL, domain, lockFn)
        if (rebuilt) {
            if (chunkNumber && chunkNumber > (rebuilt.chunks || 0)) return emptyChunk(rebuilt, file)
            xml = await readFile(DL.redis, domainId, rebuilt.gen, file)
            if (xml != null) meta = rebuilt
        }
    }
    if (xml == null) return null

    return { xml, etag: `"${meta.gen}-${file}"` }
}
