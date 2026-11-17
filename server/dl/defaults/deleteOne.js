export default Model => async function deleteOne(filter = {}) {
    const cacheStrategy = Model.cacheStrategy

    let id = filter.id
    if (Array.isArray(id)) id = undefined

    if (cacheStrategy && !id) {
        id = (await Model.distinct('id', filter))[0]

        if (!id) {
            return {
                acknowledged: true,
                deletedCount: 0
            }
        }
    }

    const res = await Model.deleteOne(
        id ? { ...filter, id } : filter
    )

    if (cacheStrategy && res.deletedCount) {
        await Model.cache?.del(id)
    }

    return res
}