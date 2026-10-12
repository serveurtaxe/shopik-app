import rewind from '@turf/rewind'
import intersect from '@turf/intersect'
import area from '@turf/area'

// Below this area (square METERS — @turf/area returns m²) an intersection is
// considered a boundary touch (shared edge / shared vertex) or float noise
// from split/union round-trips (e.g. a diagonal cut re-unioned leaves ~0.003 m²
// slivers on jagged city-border edges), which is allowed for seamless tiling.
// ≈ original intent of 1e-9 sq-degrees (~12 m²).
export const MIN_OVERLAP_AREA = 10

// Normalize polygon: close every ring + enforce Right-Hand Rule (CCW exterior,
// CW holes) for MongoDB. Uses turf rewind default direction (no reverse flag).
export function normalizePolygon(location) {
    const rings = location.coordinates.map(ring => {
        const first = ring[0]
        const last = ring[ring.length - 1]

        if (!first || !last || first[0] !== last[0] || first[1] !== last[1])
            return [...ring, [...first]]

        return [...ring]
    })

    return rewind({ type: 'Polygon', coordinates: rings })
}

// Validate polygon structure and coordinate ranges
export function validatePolygon(location) {
    if (!location || location.type !== 'Polygon')
        throw { status: 400, message: 'Invalid geometry type. Must be Polygon.' }

    const rings = location.coordinates
    if (!Array.isArray(rings) || !rings.length)
        throw { status: 400, message: 'Polygon coordinates missing.' }

    for (const ring of rings) {
        if (!Array.isArray(ring) || ring.length < 4)
            throw { status: 400, message: 'Polygon must have at least 3 unique vertices.' }

        const unique = new Set(ring.map(([lng, lat]) => `${lng},${lat}`))
        if (unique.size < 3)
            throw { status: 400, message: 'Polygon must have at least 3 unique vertices.' }

        for (const [lng, lat] of ring) {
            if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
                throw { status: 400, message: `Invalid coordinate pair: [${lng}, ${lat}]` }
            }
        }
    }
}

// Overlap check: MongoDB $geoIntersects filter + precise intersection area test.
// Uses @turf/intersect + @turf/area because @turf/boolean-overlap incorrectly
// returns true for polygons that only share a border (breaking seamless tiling).
// Uses the raw model directly to bypass DL processFilter (which strips non-filter
// fields) and to avoid the default read() limit of 30 docs.
export async function validateNoOverlap(DL, location, excludeId) {
    const query = {
        location: {
            $geoIntersects: { $geometry: location }
        }
    }

    if (excludeId)
        query.id = Array.isArray(excludeId) ? { $nin: excludeId } : { $ne: excludeId }

    const candidates = await DL.SupplyArea.Model.find(query).select('id name location').lean()

    for (const candidate of candidates) {
        if (polygonsOverlap(location, candidate.location)) {
            throw { status: 400, message: `Supply area overlaps with existing area: "${candidate.name}"` }
        }
    }
}

export function polygonsOverlap(geomA, geomB) {
    const intersection = intersect({
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', properties: {}, geometry: geomA },
            { type: 'Feature', properties: {}, geometry: geomB }
        ]
    })

    return !!intersection && area(intersection) > MIN_OVERLAP_AREA
}

// ---- Polygon split by cut line (planar math on [lng, lat] pairs) ----

function segIntersection(a, b, c, d) {
    const rx = b[0] - a[0]
    const ry = b[1] - a[1]
    const sx = d[0] - c[0]
    const sy = d[1] - c[1]
    const denom = rx * sy - ry * sx
    if (Math.abs(denom) < 1e-12) return null // parallel / collinear
    const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denom
    const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denom
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null
    return { x: a[0] + t * rx, y: a[1] + t * ry, t, u }
}

const ptKey = (x, y) => `${Math.round(x * 1e9)}_${Math.round(y * 1e9)}`

function pointOnSegment(pt, a, b) {
    const cross = (b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0])
    if (Math.abs(cross) > 1e-9) return false
    const dot = (pt[0] - a[0]) * (pt[0] - b[0]) + (pt[1] - a[1]) * (pt[1] - b[1])
    return dot <= 1e-9
}

// Strict point-in-ring: boundary counts as outside (tangents must not validate a cut)
function pointInRingStrict(pt, ring) {
    for (let i = 0; i < ring.length; i++) {
        if (pointOnSegment(pt, ring[i], ring[(i + 1) % ring.length])) return false
    }
    const [x, y] = pt
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
}

function shoelaceArea(ring) {
    let a = 0
    for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return Math.abs(a / 2)
}

// Split a single-ring Polygon by a multi-vertex LineString.
// Returns [partA, partB] Polygon geometries. Throws 400 when the line
// does not properly pass through (outside, single touch, endpoint inside).
export function splitPolygonByLine(polygon, line) {
    const coords = polygon?.coordinates
    const ring = coords?.[0]
    if (!Array.isArray(ring) || ring.length < 4)
        throw { status: 400, message: 'Invalid polygon for split.' }
    if (coords.length > 1)
        throw { status: 400, message: 'Splitting areas with holes is not supported.' }
    const pts = line?.coordinates
    if (line?.type !== 'LineString' || !Array.isArray(pts) || pts.length < 2)
        throw { status: 400, message: 'Cut line must have at least 2 points.' }
    for (const [lng, lat] of pts) {
        if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90)
            throw { status: 400, message: `Invalid coordinate pair: [${lng}, ${lat}]` }
    }

    const first = ring[0]
    const last = ring[ring.length - 1]
    const R = (first[0] === last[0] && first[1] === last[1]) ? ring.slice(0, -1) : [...ring]

    // All boundary crossings, deduped (vertex touches hit 2 edges) and ordered along the line
    const seen = new Set()
    const crossings = []
    for (let j = 0; j < pts.length - 1; j++) {
        for (let i = 0; i < R.length; i++) {
            const hit = segIntersection(pts[j], pts[j + 1], R[i], R[(i + 1) % R.length])
            if (!hit) continue
            const k = ptKey(hit.x, hit.y)
            if (seen.has(k)) continue
            seen.add(k)
            crossings.push({ x: hit.x, y: hit.y, lineSeg: j, tLine: hit.t, ringSeg: i, tRing: hit.u })
        }
    }
    crossings.sort((a, b) => a.lineSeg - b.lineSeg || a.tLine - b.tLine)

    // First consecutive crossing pair whose connecting line path runs inside = the cut
    let cut = null
    for (let k = 0; k < crossings.length - 1 && !cut; k++) {
        const a = crossings[k]
        const b = crossings[k + 1]
        if (ptKey(a.x, a.y) === ptKey(b.x, b.y)) continue
        const path = [[a.x, a.y]]
        if (a.lineSeg === b.lineSeg) {
            path.push([b.x, b.y])
        } else {
            path.push(pts[a.lineSeg + 1])
            for (let m = a.lineSeg + 2; m <= b.lineSeg; m++) path.push(pts[m])
            path.push([b.x, b.y])
        }
        let total = 0
        const lens = []
        for (let i = 0; i < path.length - 1; i++) {
            const l = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1])
            lens.push(l)
            total += l
        }
        if (total === 0) continue
        let target = total / 2
        let mid = path[path.length - 1]
        for (let i = 0; i < lens.length; i++) {
            if (target <= lens[i]) {
                const t = lens[i] === 0 ? 0 : target / lens[i]
                mid = [path[i][0] + t * (path[i + 1][0] - path[i][0]), path[i][1] + t * (path[i + 1][1] - path[i][1])]
                break
            }
            target -= lens[i]
        }
        if (pointInRingStrict(mid, R)) cut = { entry: a, exit: b, path }
    }
    if (!cut)
        throw { status: 400, message: 'Cut line does not go through the area.' }

    // Ring with crossing points inserted in edge order
    const aug = []
    for (let i = 0; i < R.length; i++) {
        aug.push(R[i])
        const hits = crossings
            .filter(c => c.ringSeg === i
                && ptKey(c.x, c.y) !== ptKey(R[i][0], R[i][1])
                && ptKey(c.x, c.y) !== ptKey(R[(i + 1) % R.length][0], R[(i + 1) % R.length][1]))
            .sort((p, q) => p.tRing - q.tRing)
        hits.forEach(c => aug.push([c.x, c.y]))
    }
    const idxOf = (c) => aug.findIndex(p => ptKey(p[0], p[1]) === ptKey(c.x, c.y))
    const iE = idxOf(cut.entry)
    const iX = idxOf(cut.exit)
    if (iE === -1 || iX === -1 || iE === iX)
        throw { status: 400, message: 'Cut line does not go through the area.' }

    const chain1 = []
    for (let i = iE; ; i = (i + 1) % aug.length) {
        chain1.push(aug[i])
        if (i === iX) break
    }
    const chain2 = []
    for (let i = iX; ; i = (i + 1) % aug.length) {
        chain2.push(aug[i])
        if (i === iE) break
    }
    const inner = cut.path.slice(1, -1)
    const ringA = [...chain1, ...[...inner].reverse(), [...chain1[0]]]
    const ringB = [...chain2, ...inner, [...chain2[0]]]

    for (const r of [ringA, ringB]) {
        if (new Set(r.map(([lng, lat]) => ptKey(lng, lat))).size < 3 || shoelaceArea(r) <= 1e-12)
            throw { status: 400, message: 'Cut produced an invalid shape.' }
    }

    return [
        { type: 'Polygon', coordinates: [ringA] },
        { type: 'Polygon', coordinates: [ringB] }
    ]
}

// Point-in-polygon lookup for address routing
export async function findByLocation(DL, point) {
    if (!point || point.type !== 'Point' || !Array.isArray(point.coordinates) || point.coordinates.length !== 2)
        return null

    const [lng, lat] = point.coordinates
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90)
        return null

    return await DL.SupplyArea.readOne({ location: { $geoIntersects: { $geometry: point } } })
}