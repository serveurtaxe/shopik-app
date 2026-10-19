import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Guard for the bundled CBS statistical-areas reference overlay — the finer
// sub-city units drawn as a guide in the admin Supply-Areas map.
// Source: CBS (הלמ"ס) ArcGIS service; built by server/scripts/buildStatisticalAreas.js
// and rendered by admin/Pages/SupplyAreas/StatisticalAreasLayer.jsx.

const here = path.dirname(fileURLToPath(import.meta.url))
const staticDir = path.resolve(here, '..', '..', 'admin', 'public', 'static')
const file = fs.readdirSync(staticDir).find(f => /^statistical-areas\.v.*\.geojson$/.test(f))
assert.ok(file, 'statistical areas geojson found')

const gj = JSON.parse(fs.readFileSync(path.join(staticDir, file), 'utf8'))

describe('statistical areas overlay data', () => {
    it('is a non-empty FeatureCollection', () => {
        assert.equal(gj.type, 'FeatureCollection')
        assert.ok(Array.isArray(gj.features) && gj.features.length > 1000)
    })

    it('every feature is a single in-Israel polygon with a locality name + stat code', () => {
        for (const f of gj.features) {
            assert.equal(f.geometry?.type, 'Polygon', 'single-polygon geometry')
            assert.equal(typeof f.properties.name, 'string')
            assert.ok(f.properties.stat != null, 'has stat code')
            const [lng, lat] = f.geometry.coordinates[0][0]
            assert.ok(lng > 34 && lng < 36 && lat > 29 && lat < 34, `in Israel: ${lng},${lat}`)
        }
    })
})
