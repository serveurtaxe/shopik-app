import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import union from '@turf/union'
import { useText } from 'common/texts/TextProvider'
import styles from './supplyAreas.module.css'

// CBS statistical areas (הלמ"ס — אזורים סטטיסטיים) as a clickable sub-city
// reference overlay. Finer than the municipal city-borders layer, so it guides
// drawing supply areas inside big cities. Click → popup with the locality name +
// "create polygon" button that duplicates the statistical area as a new supply
// area (same flow as CityBordersLayer).
//
// DATA SOURCE (official): Central Bureau of Statistics (הלמ"ס) ArcGIS feature
// service "אזורים סטטיסטיים ודמוגרפיה בישראל 2024" (.../age_pyramis_test/
// FeatureServer/0). Its geometry is identical to the CBS statistical_areas_2022
// FileGDB. Converted once with server/scripts/buildStatisticalAreas.js (paged
// WGS84 GeoJSON), then a topology-preserving simplify via mapshaper — shared
// edges between neighbouring areas stay identical, so the server's area-overlap
// gate never sees false float slivers. 5-decimal coords.
// Bundled at admin/public/static/ and served verbatim out of build/admin/static
// by express.static. Deliberately NOT imported: an import would inline ~4.5MB
// into the admin JS chunk. As a static file the browser fetches it only when
// this layer is turned on.
// TO UPDATE: re-run the two steps in buildStatisticalAreas.js, add
// statistical-areas.v<YYYY-MM-DD>.geojson, and bump AREAS_FILE.
// Permanent name labels only when zoomed in enough to stay readable.
const LABEL_MIN_ZOOM = 13
// Snapping is only useful (and cheap) when few polygons are on screen — feeding
// the whole country's ~200k vertices into the snap grid on every move would
// stall drawing. Off until zoomed in.
const SNAP_MIN_ZOOM = 13
// Path is publicDir-relative to admin/ (served from the admin host).
const AREAS_FILE = '/static/statistical-areas.v2026-10-18.geojson'
// Dashed + sky-blue to read as "reference grid" and stay distinct from the
// solid slate city borders underneath.
const AREAS_STYLE = { color: '#0ea5e9', weight: 1, dashArray: '2 3', fillOpacity: 0 }
// Clicked area gets a translucent fill so it reads as "picked".
const AREAS_SELECTED_STYLE = { color: '#0ea5e9', weight: 2, dashArray: '2 3', fillOpacity: 0.18 }

// Shared across remounts (tileset switches recreate the map) — fetched once per session.
let areasPromise = null
function loadAreas() {
    if (!areasPromise) {
        areasPromise = fetch(AREAS_FILE)
            .then(r => {
                if (!r.ok) throw new Error(`statistical areas HTTP ${r.status}`)
                return r.json()
            })
            .then(fc => {
                for (const f of fc.features || []) f.properties._bbox = bboxOf(f.geometry)
                return fc
            })
            .catch(err => {
                console.error('[StatisticalAreas] failed to load:', err)
                areasPromise = null
                return null
            })
    }
    return areasPromise
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

export default function StatisticalAreasLayer({ visible, drawing, toggleMode, geometryEditingId, cuttingId, darkBasemap, onCreateArea, onSnapData }) {
    const map = useMap()
    const { TR } = useText()
    const dataRef = useRef(null)
    const stRef = useRef({ visible, drawing, toggleMode, geometryEditingId, cuttingId, darkBasemap, onCreateArea, onSnapData, TR })
    stRef.current = { visible, drawing, toggleMode, geometryEditingId, cuttingId, darkBasemap, onCreateArea, onSnapData, TR }

    useEffect(() => {
        let layer = null
        // Ctrl/Cmd+click accumulates a multi-selection; a plain click replaces it.
        // `selected` holds the same feature objects stored in dataRef, so identity
        // survives the pan/zoom rebuild in refresh().
        const selected = new Set()
        let popup = null
        const applySelection = () => {
            layer?.eachLayer(l => l.setStyle(selected.has(l.feature) ? AREAS_SELECTED_STYLE : AREAS_STYLE))
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
        // Heading: the single area's locality name, or a generic "N selected" one.
        const selectionTitle = () => {
            const feats = [...selected]
            if (feats.length === 1) return feats[0].properties?.name || ''
            return stRef.current.TR('supply_selected_areas')
        }
        const selectionMeta = () => {
            const feats = [...selected]
            if (feats.length === 1) {
                const p = feats[0].properties
                return p?.stat != null ? `#${p.stat}` : `vertices: ${countVertices(feats[0].geometry)}`
            }
            return `${feats.length}`
        }
        // Name only carries over for a single pick — a merged shape spans several
        // localities, so it's created unnamed and the user renames it.
        const selectionName = () => (selected.size === 1 ? selectionTitle() : '')

        const openAreaPopup = (latlng) => {
            const st = stRef.current
            const el = L.DomUtil.create('div', styles.cityPopup)
            // Same guard as the area popup: keep popup clicks off the map bg-click handler
            L.DomEvent.on(el, 'mousedown', L.DomEvent.stopPropagation)
            L.DomEvent.on(el, 'click', L.DomEvent.stopPropagation)
            const head = L.DomUtil.create('div', styles.cityPopupHead, el)
            const title = L.DomUtil.create('strong', styles.cityPopupTitle, head)
            title.textContent = selectionTitle()
            const meta = L.DomUtil.create('span', styles.cityPopupVerts, head)
            meta.textContent = selectionMeta()
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

        layer = L.geoJSON(null, {
            style: AREAS_STYLE,
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
                        // Ctrl/Cmd+click toggles this area in the multi-selection.
                        if (selected.has(f)) selected.delete(f); else selected.add(f)
                        if (!selected.size) { map.closePopup(); return }
                    } else {
                        selected.clear()
                        selected.add(f)
                    }
                    applySelection()
                    openAreaPopup(e.latlng)
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
            const onScreen = (data.features || []).filter(f => intersects(f.properties._bbox, bounds))
            layer.clearLayers()
            layer.addData(onScreen)
            layer.bringToBack()
            layer.eachLayer(l => {
                l.setStyle(selected.has(l.feature) ? AREAS_SELECTED_STYLE : AREAS_STYLE)
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
            // Feed the drawing snap grid, but only when zoomed in enough that the
            // on-screen subset is small (see SNAP_MIN_ZOOM).
            stRef.current.onSnapData?.(map.getZoom() >= SNAP_MIN_ZOOM ? onScreen.map(f => f.geometry) : [])
        }

        if (stRef.current.visible) {
            layer.addTo(map)
            loadAreas().then(data => {
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
            stRef.current.onSnapData?.([])
        }
    }, [map, visible, darkBasemap])

    return null
}
