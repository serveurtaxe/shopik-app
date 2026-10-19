import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import union from '@turf/union'
import { useText } from 'common/texts/TextProvider'
import styles from './supplyAreas.module.css'

// City / municipal jurisdiction borders as a clickable reference overlay.
// Click a border → popup with the city name + "create polygon" button that
// instantly duplicates the city's border as a new supply area.
//
// DATA SOURCE (official): Ministry of Interior —
// "גבולות שיפוט רשויות מקומיות וועדים מקומיים – רצף"
// (ArcGIS item 069298e81f8e4e6fb96aa59913c113cd, ITM/EPSG:2039 shapefile).
// Converted once: reproject ITM→WGS84, DISSOLVE by municipality (the source
// layer stacks whole-council + va'ad subdivision polygons — dissolving leaves
// one true outline per city/council), drop "ללא שיפוט" (unassigned) areas,
// topology-preserving simplify (~8%), 5-decimal coords.
// Bundled with the admin app at admin/public/static/ and served verbatim out of
// build/admin/static/ by express.static on the admin host. It is deliberately
// NOT imported: an import would inline ~1.9MB into the admin JS chunk and
// download it on every admin page. As a static file the browser fetches it only
// when this layer is turned on.
// TO UPDATE: the filename encodes the source release date, so check that item's
// `modified` date on ArcGIS. If it moved, redo the conversion above, add the
// result as city-borders.v<YYYY-MM-DD>.geojson, and update BORDERS_FILE. Ships
// with a redeploy — no upload step, every tenant has it once the image rolls.
// Permanent name labels only when zoomed in enough to stay readable.
const LABEL_MIN_ZOOM = 11
// Path is publicDir-relative to admin/ (served from the admin host).
const BORDERS_FILE = '/static/city-borders.v2026-10-11.geojson'
// Base vs selected style. The clicked jurisdiction gets a translucent fill so
// it reads as "picked" while a supply area is drawn over it.
const BORDERS_STYLE = { color: '#64748b', weight: 1, fillOpacity: 0 }
const BORDERS_SELECTED_STYLE = { color: '#64748b', weight: 2, fillOpacity: 0.18 }
// Manual nudge (meters, [east, north]) applied to the whole layer at load.
// The file is properly projected so this stays [0, 0] — only touch it if a
// systematic mismatch against the basemap is ever found (e.g. [70, 40]).
// No rebuild needed: plain constant, fetched file untouched.
const BORDERS_OFFSET_METERS = [0, 0]

function applyOffset(fc) {
    const [dx, dy] = BORDERS_OFFSET_METERS
    if (!dx && !dy) return fc
    const dLon = dx / 95000
    const dLat = dy / 111000
    const shift = (c) => (typeof c?.[0] === 'number' ? [c[0] + dLon, c[1] + dLat] : c.map(shift))
    for (const f of fc.features || []) {
        if (f.geometry?.coordinates) f.geometry.coordinates = shift(f.geometry.coordinates)
    }
    return fc
}

// Shared across remounts (tileset switches recreate the map) — fetched once per session.
let bordersPromise = null
function loadBorders() {
    if (!bordersPromise) {
        bordersPromise = fetch(BORDERS_FILE)
            .then(r => {
                if (!r.ok) throw new Error(`city borders HTTP ${r.status}`)
                return r.json()
            })
            .then(fc => {
                applyOffset(fc)
                for (const f of fc.features || []) f.properties._bbox = bboxOf(f.geometry)
                return fc
            })
            .catch(err => {
                console.error('[CityBorders] failed to load:', err)
                bordersPromise = null
                return null
            })
    }
    return bordersPromise
}

function bboxOf(geom) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
    const walk = (c) => {
        if (typeof c?.[0] === 'number') {
            if (c[0] < w) w = c[0]
            if (c[0] > e) e = c[0]
            if (c[1] < s) s = c[1]
            if (c[1] > n) n = c[1]
        } else if (Array.isArray(c)) {
            c.forEach(walk)
        }
    }
    walk(geom?.coordinates || [])
    return [w, s, e, n]
}

const intersects = (bb, b) =>
    bb[0] <= b.getEast() && bb[2] >= b.getWest() && bb[1] <= b.getNorth() && bb[3] >= b.getSouth()

// Exterior-ring vertex count (closed ring repeats first point — don't count it twice)
function countVertices(geometry) {
    if (!geometry?.coordinates?.length) return 0
    const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
    return polys.reduce((n, poly) => n + (poly[0]?.length ? poly[0].length - 1 : 0), 0)
}

export default function CityBordersLayer({ visible, drawing, toggleMode, geometryEditingId, cuttingId, darkBasemap, onCreateArea }) {
    const map = useMap()
    const { TR } = useText()
    const dataRef = useRef(null)
    const stRef = useRef({ visible, drawing, toggleMode, geometryEditingId, cuttingId, darkBasemap, onCreateArea, TR })
    stRef.current = { visible, drawing, toggleMode, geometryEditingId, cuttingId, darkBasemap, onCreateArea, TR }

    useEffect(() => {
        let layer = null
        // Ctrl/Cmd+click accumulates a multi-selection; a plain click replaces it.
        // `selected` holds the same feature objects stored in dataRef, so identity
        // survives the pan/zoom rebuild in refresh().
        const selected = new Set()
        let popup = null
        const applySelection = () => {
            layer?.eachLayer(l => l.setStyle(selected.has(l.feature) ? BORDERS_SELECTED_STYLE : BORDERS_STYLE))
        }
        const resetSelection = () => { selected.clear(); applySelection() }

        // Union of the current selection, or the lone geometry when one is picked.
        const selectionGeometry = () => {
            const feats = [...selected]
            if (!feats.length) return null
            if (feats.length === 1) return feats[0].geometry
            const merged = union({
                type: 'FeatureCollection',
                features: feats.map(f => ({ type: 'Feature', properties: {}, geometry: f.geometry })),
            })
            return merged?.geometry || null
        }
        // Heading: the single area's name, or a generic "N selected" heading.
        const selectionTitle = () => {
            const feats = [...selected]
            if (feats.length === 1) return feats[0].properties?.name || ''
            return stRef.current.TR('supply_selected_areas')
        }
        const selectionMeta = () => {
            const feats = [...selected]
            if (feats.length === 1) return `vertices: ${countVertices(feats[0].geometry)}`
            return `${feats.length}`
        }
        // Name only carries over for a single pick — a merged shape spans several
        // localities, so it's created unnamed and the user renames it.
        const selectionName = () => (selected.size === 1 ? selectionTitle() : '')

        const openCityPopup = (latlng) => {
            const st = stRef.current
            const el = L.DomUtil.create('div', styles.cityPopup)
            // Same guard as the area popup: keep popup clicks off the map bg-click handler
            L.DomEvent.on(el, 'mousedown', L.DomEvent.stopPropagation)
            L.DomEvent.on(el, 'click', L.DomEvent.stopPropagation)
            const head = L.DomUtil.create('div', styles.cityPopupHead, el)
            const title = L.DomUtil.create('strong', styles.cityPopupTitle, head)
            title.textContent = selectionTitle()
            // Same convention as the area popup (vertices of exterior rings)
            const verts = L.DomUtil.create('span', styles.cityPopupVerts, head)
            verts.textContent = selectionMeta()
            const btn = L.DomUtil.create('button', styles.cityPopupBtn, el)
            btn.type = 'button'
            // Plus icon matching the shared Button's `add` icon (Lucide LuPlus)
            btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>'
            btn.appendChild(document.createTextNode(st.TR('supply_create_polygon')))
            L.DomEvent.on(btn, 'click', (ev) => {
                L.DomEvent.stop(ev)
                const geometry = selectionGeometry()
                if (!geometry) return
                // Server stores one Polygon; a scattered multi-select can't collapse
                // into one shape, so block it the way the area-merge endpoint does.
                if (selected.size > 1 && geometry.type !== 'Polygon') {
                    const warn = L.DomUtil.create('div', styles.cityPopupWarn, el)
                    warn.textContent = st.TR('supply_areas_not_adjacent')
                    return
                }
                // Read the name before closePopup: its 'remove' clears the selection.
                const name = selectionName()
                btn.disabled = true
                map.closePopup()
                st.onCreateArea?.(name, geometry)
            })
            // Reuse one popup instance, and disable closeOnClick: Leaflet closes a
            // popup on the map's synthetic `preclick` for EVERY click, which would
            // fire 'remove' and wipe the multi-selection we're accumulating.
            if (!popup) popup = L.popup({ maxWidth: 260, closeButton: true, closeOnClick: false, className: styles.cityPopupWrap })
                .on('remove', resetSelection)
            popup.setLatLng(latlng).setContent(el)
            if (!popup.isOpen()) popup.openOn(map)
        }

        // Interactive (clickable) but kept under area polygons via bringToBack,
        // so area clicks still select areas, not cities.
        // Solid (not dashed): adjacent municipalities share exact edges, and two
        // dashed strokes with different phase look like a double line.
        layer = L.geoJSON(null, {
            style: BORDERS_STYLE,
            interactive: true,
            onEachFeature: (f, l) => {
                l.on('click', (e) => {
                    const st = stRef.current
                    if (!st.visible || st.drawing || st.toggleMode || st.geometryEditingId || st.cuttingId) return
                    // Stop the click at the layer so the map never sees it: canvas
                    // paths aren't DOM targets, so the map bg-click guard can't filter
                    // them. Also keeps the accumulating selection popup open.
                    L.DomEvent.stopPropagation(e)
                    const oe = e.originalEvent
                    if (oe?.ctrlKey || oe?.metaKey) {
                        // Ctrl/Cmd+click toggles this city in the multi-selection.
                        if (selected.has(f)) selected.delete(f); else selected.add(f)
                        if (!selected.size) { map.closePopup(); return }
                    } else {
                        selected.clear()
                        selected.add(f)
                    }
                    applySelection()
                    openCityPopup(e.latlng)
                })
            },
        })
        // Background clicks close the popup (closeOnClick is off so Ctrl+clicks on
        // the polygons, which stopPropagation, don't close it).
        const closeRefPopup = () => { if (popup?.isOpen()) map.closePopup() }
        map.on('click', closeRefPopup)
        let cancelled = false

        const refresh = () => {
            const data = dataRef.current
            if (cancelled || !data || !stRef.current.visible) return
            const bounds = map.getBounds()
            const showLabels = map.getZoom() >= LABEL_MIN_ZOOM
            layer.clearLayers()
            layer.addData((data.features || []).filter(f => intersects(f.properties._bbox, bounds)))
            layer.bringToBack()
            layer.eachLayer(l => {
                l.setStyle(selected.has(l.feature) ? BORDERS_SELECTED_STYLE : BORDERS_STYLE)
                const name = l.feature?.properties?.name
                if (showLabels && name) {
                    l.bindTooltip(name, {
                        permanent: true,
                        direction: 'center',
                        className: stRef.current.darkBasemap
                            ? `${styles.cityLabel} ${styles.cityLabelDark}`
                            : styles.cityLabel,
                    })
                } else {
                    l.unbindTooltip()
                }
            })
        }

        if (stRef.current.visible) {
            layer.addTo(map)
            loadBorders().then(data => {
                if (cancelled) return
                dataRef.current = data
                refresh()
            })
        }
        map.on('moveend zoomend', refresh)
        return () => {
            cancelled = true
            map.off('moveend zoomend', refresh)
            map.off('click', closeRefPopup)
            map.removeLayer(layer)
        }
    }, [map, visible, darkBasemap])

    return null
}
