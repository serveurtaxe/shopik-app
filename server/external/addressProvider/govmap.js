/**
 * GovMap local DB provider — single collection gov_addresses (city/street/building)
 * Fast prefix search via DL.GovAddress, no external call.
 */
export async function searchGovmap({ DL, q, city, street, type = 'street', limit = 10 }) {
    if (!DL?.GovAddress) return []
    const query = (q || '').trim()
    if (!query && !city && !street) return []

    try {
        if (type === 'city') {
            // distinct cities with prefix
            const match = query ? { city: new RegExp(`^${escapeRegex(query)}`) } : {}
            const docs = await DL.GovAddress.Model.aggregate([
                { $match: match },
                { $group: { _id: '$city', city: { $first: '$city' } } },
                { $sort: { city: 1 } },
                { $limit: limit }
            ])
            return (docs || []).map(c => ({
                label: c.city, // check why?!
                city: c.city,
                source: 'govmap'
            }))
        }

        if (type === 'street') {
            if (!city) return []
            const filter = { city }
            if (query) filter.street = new RegExp(escapeRegex(query))
            const docs = await DL.GovAddress.Model.aggregate([
                { $match: filter },
                { $group: { _id: { city: '$city', street: '$street' }, city: { $first: '$city' }, street: { $first: '$street' } } },
                { $sort: { street: 1 } },
                { $limit: limit }
            ])
            return (docs || []).map(s => ({
                label: s.street,
                city: s.city,
                street: s.street,
                source: 'govmap'
            }))
        }

        // if (type === 'building') {
        //     if (!city || !street) return []
        //     const filter = { city, street }
        //     if (query) filter.building = new RegExp(`^${escapeRegex(query)}`)
        //     const docs = await DL.GovAddress.read(filter, { _id: 0, city: 1, street: 1, building: 1, location: 1 }, { limit, sort: { building: 1 } })
        //     return (docs || []).map(b => ({
        //         label: String(b.building),
        //         city: b.city,
        //         street: b.street,
        //         building: String(b.building),
        //         location: b.location,
        //         source: 'govmap'
        //     }))
        // }
    } catch (e) {
        console.warn('[govmap] search failed', e.message)
    }
    return []
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
