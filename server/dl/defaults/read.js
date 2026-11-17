import { CACHE_STRATEGIES } from '#common/constants.js'

// skip/limit pagination needs a unique sort key: MongoDB gives no stable order
// among ties, so pages of docs sharing the sort value overlap and repeat rows
// (e.g. every comax_product stamped with the same lastImportedAt). Only appended
// to an explicit sort — an unsorted full scan (limit: 0 sync/export) must stay
// unsorted to avoid a needless blocking sort.
export function withTiebreaker(Model, sort) {
    if (!sort || typeof sort !== 'object') return sort
    const keys = Object.keys(sort)
    if (!keys.length) return
    if (keys.includes('id') || keys.includes('_id')) return sort
    return { ...sort, [Model.schema.path('id') ? 'id' : '_id']: 1 }
}

export default (Model) => async function read(filter = {}, select = { _id: 0 }, options = {}) {
    const sort = withTiebreaker(Model, options.sort)

    if (Model.cacheStrategy === CACHE_STRATEGIES.HASHSET && Model.cache) {
        const cached = await Model.cache.read(filter, select, { ...options, sort })
        // null means Redis is unavailable — fall through to MongoDB
        if (cached !== null) return cached
    }

    const { search, skip = 0, limit = 30 } = options
    const processedFilter = Model.processFilter(filter, search)

    return Model.find(processedFilter)
        .select(select)
        .sort(sort)
        .skip(skip ? Number(skip) : undefined)
        .limit(limit ? Number(limit) : undefined)
        .lean()
}