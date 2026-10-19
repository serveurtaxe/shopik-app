import { normalizePolygon, validatePolygon, validateNoOverlap, splitPolygonByLine } from '#server/external/supplyArea.js'

function nextSplitName(name) {
    const base = (name || '').trim()
    if (!base) return ''
    const m = base.match(/^(.*)\s\((\d+)\)$/)
    if (m) return `${m[1]} (${parseInt(m[2], 10) + 1})`
    return `${base} (2)`
}

export default async function split(payload, { DL }) {
    const { id, line } = payload
    if (!id) throw { status: 400, message: 'Missing id' }
    if (!line) throw { status: 400, message: 'Missing cut line' }

    const area = await DL.SupplyArea.readById(id)
    if (!area) throw { status: 404, message: 'Supply area not found' }

    const [geomA, geomB] = splitPolygonByLine(area.location, line)
    const locA = normalizePolygon(geomA)
    const locB = normalizePolygon(geomB)
    validatePolygon(locA)
    validatePolygon(locB)
    // Both parts tile the original footprint: exclude the original (still stored
    // whole at check time) from both checks. The parts share only the cut edge
    // (zero intersection area) — allowed by tolerance.
    await validateNoOverlap(DL, locA, id)
    await validateNoOverlap(DL, locB, id)

    const updated = await DL.SupplyArea.updateOne({ id }, { location: locA })
    const storeIds = (area.stores || []).map(s => s?.storeId ?? s).filter(Boolean)
    const created = await DL.SupplyArea.create({
        name: nextSplitName(area.name),
        location: locB,
        stores: storeIds.map(storeId => ({ storeId }))
    })

    return { original: updated, created }
}

split.config = {
    required: ['id', 'line'],
    permissions: ['supply_area:update', 'supply_area:create'],
    preventMultiple: true
}
