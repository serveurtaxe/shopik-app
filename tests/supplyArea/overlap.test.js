import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import intersect from '@turf/intersect'
import area from '@turf/area'
import union from '@turf/union'
import { normalizePolygon, polygonsOverlap, splitPolygonByLine } from '#server/external/supplyArea.js'

// Regression test: split → union round-trip must not create a false overlap
// with a touching neighbor. Root cause was MIN_OVERLAP_AREA=1e-9 compared
// against @turf/area square METERS (≈ zero), so mm² float slivers left by
// turf/union on jagged city-border edges tripped the overlap gate.

const here = path.dirname(fileURLToPath(import.meta.url))
const staticDir = path.resolve(here, '..', '..', 'admin', 'public', 'static')
const bordersFile = fs.readdirSync(staticDir).find(f => /^city-borders\.v.*\.geojson$/.test(f))
assert.ok(bordersFile, 'city borders geojson found')

function largestPolygonPart(geometry) {
    if (geometry.type === 'Polygon') return geometry
    let best = null
    let bestA = -1
    for (const poly of geometry.coordinates) {
        const ring = poly[0]
        let a = 0
        for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
        a = Math.abs(a / 2)
        if (a > bestA) { bestA = a; best = poly }
    }
    return { type: 'Polygon', coordinates: best }
}

const feat = g => ({ type: 'Feature', properties: {}, geometry: g })
const interArea = (x, y) => {
    const i = intersect({ type: 'FeatureCollection', features: [feat(x), feat(y)] })
    return i ? area(i) : 0
}
const ringBBox = ring => {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
    for (const [x, y] of ring) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y }
    return [x0, y0, x1, y1]
}

const gj = JSON.parse(fs.readFileSync(path.join(staticDir, bordersFile), 'utf8'))
const polys = gj.features.map(f => normalizePolygon(largestPolygonPart(f.geometry)))

function findTouchingPair() {
    for (let i = 0; i < polys.length; i++) {
        const bi = ringBBox(polys[i].coordinates[0])
        for (let j = i + 1; j < polys.length; j++) {
            const bj = ringBBox(polys[j].coordinates[0])
            if (bj[0] > bi[2] || bj[2] < bi[0] || bj[1] > bi[3] || bj[3] < bi[1]) continue
            if (interArea(polys[i], polys[j]) === 0) return [polys[i], polys[j]]
        }
    }
    return null
}

describe('supply area overlap tolerance', () => {
    it('finds a touching (zero-overlap) neighbor pair in city borders', () => {
        const pair = findTouchingPair()
        assert.ok(pair, 'touching pair exists')
        assert.equal(polygonsOverlap(pair[0], pair[1]), false)
    })

    it('split → union round-trip does not overlap the touching neighbor', () => {
        const pair = findTouchingPair()
        assert.ok(pair, 'touching pair exists')
        const [origA, B] = pair
        const bb = ringBBox(origA.coordinates[0])
        const padX = (bb[2] - bb[0]) * 0.3 + 0.005
        // Diagonal cut: leaves a ~0.003 m² float sliver after union on real data
        const line = { type: 'LineString', coordinates: [[bb[0] - padX, bb[1] - 0.002], [bb[2] + padX, bb[3] + 0.002]] }
        const [gA, gB] = splitPolygonByLine(origA, line)
        const merged = union({ type: 'FeatureCollection', features: [feat(normalizePolygon(gA)), feat(normalizePolygon(gB))] })
        assert.equal(merged?.geometry?.type, 'Polygon')
        const norm = normalizePolygon(merged.geometry)
        assert.equal(polygonsOverlap(norm, B), false)
    })

    it('still detects a real overlap', () => {
        const pair = findTouchingPair()
        assert.ok(pair, 'touching pair exists')
        const [origA, B] = pair
        // Shift ~190m east into the neighbor: must be flagged
        const shifted = { type: 'Polygon', coordinates: [origA.coordinates[0].map(([x, y]) => [x + 0.002, y])] }
        assert.ok(interArea(shifted, B) > 10, 'sanity: test overlap is significant')
        assert.equal(polygonsOverlap(shifted, B), true)
    })
})
