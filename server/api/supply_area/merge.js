import union from '@turf/union'
import { normalizePolygon, validatePolygon, validateNoOverlap } from '#server/external/supplyArea.js'

export default async function merge(payload, { DL }) {
    const { ids } = payload
    if (!Array.isArray(ids) || ids.length < 2) throw { status: 400, message: 'At least 2 area ids required' }

    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length < 2) throw { status: 400, message: 'At least 2 area ids required' }

    const areas = await DL.SupplyArea.Model.find({ id: { $in: uniqueIds } }).lean()
    if (areas.length !== uniqueIds.length) throw { status: 404, message: 'Supply area not found' }

    // First id in selection order survives (keeps its id + name + stores)
    const byId = new Map(areas.map(a => [a.id, a]))
    const ordered = uniqueIds.map(id => byId.get(id))
    const [survivor, ...rest] = ordered

    const merged = union({
        type: 'FeatureCollection',
        features: ordered.map(a => ({ type: 'Feature', properties: {}, geometry: a.location }))
    })
    if (!merged || merged.geometry?.type !== 'Polygon')
        throw { status: 400, message: 'Selected areas must form one contiguous shape' }

    const location = normalizePolygon(merged.geometry)
    validatePolygon(location)
    // Exclude all merged areas (still stored whole at check time); the union
    // shares only boundary edges with its parts (zero intersection area).
    await validateNoOverlap(DL, location, uniqueIds)

    const updated = await DL.SupplyArea.updateOne({ id: survivor.id }, { location })
    for (const area of rest) {
        await DL.SupplyArea.deleteOne({ id: area.id })
    }

    // Remove dangling references from area groups (survivor is NOT added)
    try {
        await DL.AreaGroup?.Model.updateMany({ areaIds: { $in: rest.map(a => a.id) } }, { $pull: { areaIds: { $in: rest.map(a => a.id) } } })
    } catch {}

    return { updated, deletedIds: rest.map(a => a.id) }
}

merge.config = {
    required: ['ids'],
    permissions: ['supply_area:update', 'supply_area:delete'],
    preventMultiple: true
}
