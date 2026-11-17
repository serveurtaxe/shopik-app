import { CACHE_STRATEGIES } from '#common/constants.js'
import handleSelect from '#server/dl/handleSelect.js'
import log from '#server/utils/log.js'

export default Model => async function update(filter = {}, update, options = {}) {
    const { select, returnDocs = false } = options

    const { cacheStrategy } = Model
    let ids
    if (returnDocs || cacheStrategy) {
        ids = filter?.id ?
            (filter.id?.$in ?? [filter.id]) :
            await Model.distinct('id', filter)
        if (ids.length === 0) {
            return returnDocs ? [] : {
                acknowledged: true,
                matchedCount: 0,
                modifiedCount: 0
            }
        }
    }

    const res = await Model.updateMany(filter, { $set: update })

    const updateCache = cacheStrategy && res.modifiedCount > 0
    if (!returnDocs && !updateCache)
        return res

    const docs = await Model.find({ id: { $in: ids } }, { _id: 0 }).lean()

    if (updateCache) {
        try {
            if (cacheStrategy === CACHE_STRATEGIES.HASHSET)
                await Model.cache.add(docs)
            else
                await Model.cache.del(docs.map(d => d.id))
        } catch (error) {
            log.error('Cache error:', error)
        }
    }

    if (returnDocs)
        return handleSelect(docs, select)

    return res
}
