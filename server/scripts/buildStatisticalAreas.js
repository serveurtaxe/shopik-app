// One-off: build the admin "statistical areas" reference overlay GeoJSON from
// the CBS (הלמ"ס) ArcGIS feature service. The service geometry is identical to
// the CBS statistical_areas_2022 FileGDB, but the service reprojects to WGS84
// for us (f=geojson always emits WGS84), so no local FGDB/GDAL tooling is needed.
//
// Usage:
//   node server/scripts/buildStatisticalAreas.js <rawOutPath>
// then run the topology-preserving simplify/precision pass with mapshaper, e.g.:
//   npx --yes mapshaper <rawOutPath> -simplify 6% keep-shapes \
//     -o precision=0.00001 format=geojson <simplifiedPath>
// and finally normalize ring winding (RFC 7946) into the bundled file, e.g.:
//   node --input-type=module -e "import fs from 'node:fs';import rewind from '@turf/rewind';const fc=JSON.parse(fs.readFileSync('<simplifiedPath>','utf8'));fc.features=fc.features.map(f=>({type:'Feature',properties:f.properties,geometry:rewind(f).geometry}));fs.writeFileSync('<finalPath>',JSON.stringify(fc))"
import fs from 'node:fs'
import path from 'node:path'

const SERVICE =
    'https://services.arcgis.com/b6zSqPB0TQc3mBgU/arcgis/rest/services/age_pyramis_test/FeatureServer/0/query'
const OUT_FIELDS = 'SEMEL_YISHUV,STAT22,YISHUV_STAT22,SHEM_YISHUV,SHEM_YISHUV_ENGLISH'
const PAGE = 2000

const outPath = process.argv[2]
if (!outPath) {
    console.error('usage: node server/scripts/buildStatisticalAreas.js <rawOutPath>')
    process.exit(1)
}

async function query(offset) {
    const params = new URLSearchParams({
        where: '1=1',
        outFields: OUT_FIELDS,
        returnGeometry: 'true',
        f: 'geojson',
        resultOffset: String(offset),
        resultRecordCount: String(PAGE),
        orderByFields: 'OBJECTID',
    })
    const res = await fetch(`${SERVICE}?${params}`)
    if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}`)
    return res.json()
}

const features = []
for (let offset = 0; ; offset += PAGE) {
    const page = await query(offset)
    const feats = page.features || []
    features.push(...feats)
    process.stdout.write(`\rfetched ${features.length}`)
    if (feats.length < PAGE) break
}
process.stdout.write('\n')

const norm = f => ({
    type: 'Feature',
    properties: {
        name: f.properties?.SHEM_YISHUV || '',
        name_en: f.properties?.SHEM_YISHUV_ENGLISH || '',
        stat: f.properties?.STAT22 ?? null,
        setl: f.properties?.SEMEL_YISHUV ?? null,
    },
    geometry: f.geometry,
})

// Split MultiPolygons into one single-polygon feature per part — the map treats
// every feature as an independent, clickable unit (and the server stores single
// Polygons only), so a detached exclave must be its own feature, not a lost part.
const explode = f => f.geometry.type !== 'MultiPolygon'
    ? [f]
    : f.geometry.coordinates.map(coordinates => ({ ...f, geometry: { type: 'Polygon', coordinates } }))

// Drop "שטח ללא שיפוט" (unassigned) areas — they carry no statistical code and
// add no drawing value (mirrors the city-borders pipeline).
const fc = {
    type: 'FeatureCollection',
    features: features.map(norm).filter(f => f.geometry && f.properties.stat != null).flatMap(explode),
}
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(fc))
console.log(
    `wrote ${fc.features.length} features -> ${outPath} (${(fs.statSync(outPath).size / 1048576).toFixed(1)} MB)`
)
