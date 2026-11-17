import handleSelect from '#server/dl/handleSelect.js'
import reseedInBackground, { hasVerifiedCache, isCacheSuspect } from '#server/dl/cache/reseed.js'
import { CACHE_STRATEGIES } from '#common/constants.js'
import safeJsonParse from '#common/functions/safeJsonParse.js'
import get from '#common/functions/get.js'

const SCAN_COUNT = 1000

// Cap for exact-mode (readOne) hash scans: big hashes like gov_addresses
// (150k docs) are not worth paging through for a single indexed findOne.
const EXACT_MATCH_SCAN_MAX_DOCS = 20_000

export default function (redis, Model) {
    function searchValue(doc, search) {
        if (!doc || typeof doc !== 'object') return false
        for (const field of Model.filterFields) {
            let actual = get(doc, field)

            if (typeof actual === 'string' && actual.toLowerCase().includes(search))
                return true
        }
        return false
    }

    function matchesFilter(doc, filter) {
        for (const [path, expected] of Object.entries(filter)) {
            if (!Model.filterFields.has(path) && path !== '$or') continue // Whitelist enforcement
            if (path === '$or') {
                if (!expected.some(f => matchesFilter(doc, f))) return false
                continue
            }

            const actual = get(doc, path)

            if (Array.isArray(actual)) {
                if (expected instanceof RegExp) {
                    if (!actual.some(v => v != null && expected.test(String(v)))) return false
                } else if (!actual.includes(expected)) return false
                continue
            }

            if (expected instanceof RegExp) {
                if (actual == null || !expected.test(String(actual))) return false
            } else if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
                // operator object: $in, $gte, $lte, $gt, $lt
                if (Array.isArray(expected.$in)) {
                    if (!expected.$in.includes(actual)) return false
                }
                if (expected.$gte != null) {
                    if (actual == null || actual < expected.$gte) return false
                }
                if (expected.$gt != null) {
                    if (actual == null || actual <= expected.$gt) return false
                }
                if (expected.$lte != null) {
                    if (actual == null || actual > expected.$lte) return false
                }
                if (expected.$lt != null) {
                    if (actual == null || actual >= expected.$lt) return false
                }
                // if no recognized op, fall through to equality check (already handled $in/range)
                if (!('$in' in expected) && !('$gte' in expected) && !('$gt' in expected) && !('$lte' in expected) && !('$lt' in expected)) {
                    if (actual !== expected) return false
                }
            } else if (actual !== expected) return false
        }
        return true
    }

    return async function read(filter = {}, select = { _id: 0 }, options = {}) {
        if (Model.cacheStrategy != CACHE_STRATEGIES.HASHSET) return null

        // If Redis is not connected, signal caller to fall back to MongoDB
        if (!redis || redis.status !== 'ready') return null

        // A hash nothing has built in this process must not be read at all:
        // an empty hash and an empty collection look identical from here.
        if (isCacheSuspect(Model)) {
            reseedInBackground(Model)
            return null
        }

        const { search, sort } = options
        const skip = Number(options.skip) || 0
        const limit = options.limit == null ? 30 : Number(options.limit)

        // exact mode (readOne): the caller pre-validated the raw filter
        // (whitelisted keys, type-aligned primitive values), so equality must
        // stay equality — processFilter's string→prefix-regex rewrite is list
        // semantics, not findOne semantics. A full hash scan only pays for
        // single-doc answers on small hashes; bigger ones answer "cannot
        // answer" and the caller uses MongoDB.
        if (options.exact && await redis.hlen(Model.cacheName) > EXACT_MATCH_SCAN_MAX_DOCS)
            return null
        const processedFilter = options.exact ? filter : Model.processFilter(filter)
        const shouldFilter = Object.keys(processedFilter).length > 0
        const searchTerm = search?.length ? search.toLowerCase() : null
        // Without a sort the order is already arbitrary (hash order), so stop
        // as soon as we have enough rows. With a sort we must see every match.
        const target = sort || !limit || limit <= 0 ? Infinity : skip + limit

        // HSCAN in pages instead of HVALS: HVALS materialises every value at
        // once (150k gov_addresses → ~400MB RSS), HSCAN keeps one page live.
        const matched = []
        let cursor = '0'
        let pages = 0
        let unseededHash = false
        try {
            do {
                const [next, page] = await redis.hscan(Model.cacheName, cursor, 'COUNT', SCAN_COUNT)
                cursor = next
                // An empty *first* page means the key is missing. Unless this
                // process has already reconciled the hash with MongoDB (boot
                // verify / seed / a rebuild), "empty" cannot be told apart from
                // "never built": answer from MongoDB and rebuild in the background.
                if (!pages++ && !page.length && !hasVerifiedCache(Model)) {
                    unseededHash = true
                    cursor = '0'
                    break
                }
                // page = [field1, value1, field2, value2, ...]
                for (let i = 0; i < page.length; i += 2) {
                    const doc = safeJsonParse(page[i + 1])
                    if (!doc) continue
                    if (shouldFilter && !matchesFilter(doc, processedFilter)) continue
                    if (searchTerm && !searchValue(doc, searchTerm)) continue
                    matched.push(doc)
                    if (matched.length >= target) { cursor = '0'; break }
                }
            } while (cursor !== '0')
        } catch {
            // Redis broke mid-scan: the answer is incomplete either way, so
            // let the caller use MongoDB and rebuild the hash afterwards.
            reseedInBackground(Model)
            return null
        }

        if (unseededHash) {
            reseedInBackground(Model)
            return null
        }

        let docs = matched

        if (sort) {
            const entries = Object.entries(sort)
            docs.sort((a, b) => {
                for (const [path, direction] of entries) {
                    const av = get(a, path)
                    const bv = get(b, path)
                    if (av === bv) continue
                    if (av == null) return -direction
                    if (bv == null) return direction
                    if (av < bv) return -direction
                    if (av > bv) return direction
                }
                return 0
            })
        }

        if (skip > 0 || limit > 0)
            docs = docs.slice(skip, limit > 0 ? skip + limit : undefined)

        return handleSelect(docs, select)
    }
}