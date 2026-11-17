import { CACHE_STRATEGIES } from '#common/constants.js'

// A hashset readOne is only safe when the exact findOne semantics survive it:
// direct whitelisted schema keys with primitive values whose JS type matches
// the declared schema type. Anything else (operator objects, $or, Dates,
// dotted paths, type mismatch) falls through to MongoDB, where findOne
// semantics are guaranteed. cache.read's exact mode skips processFilter's
// string→prefix-regex rewrite and caps the scan to small hashes.
function cacheSafeFilter(Model, filter) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return false
    for (const [key, value] of Object.entries(filter)) {
        if (!Model.filterFields?.has(key)) return false
        const instance = { string: 'String', boolean: 'Boolean', number: 'Number' }[typeof value]
        if (!instance) return false
        if (Model.schema?.path(key)?.instance !== instance) return false
    }
    return true
}

export default (Model) => async function readOne(filter = {}, select = {}) {
    if (Model.cacheStrategy === CACHE_STRATEGIES.HASHSET && Model.cache && cacheSafeFilter(Model, filter)) {
        const cached = await Model.cache.read(filter, select, { limit: 1, exact: true })
        if (cached !== null) return cached[0] ?? null
    }

    // warn about no index for filter :O
    // _id stripped on the MongoDB path too: hashset docs never carried one,
    // so hit and miss answers must have the same shape (same as readById).
    return Model.findOne(filter, { ...select, _id: 0 }).lean()
}
