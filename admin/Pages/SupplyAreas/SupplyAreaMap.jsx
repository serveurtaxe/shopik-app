import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TbTextSize, TbEye, TbEyeOff } from 'react-icons/tb'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet-draw/dist/leaflet.draw.css'
import Text from 'common/components/Text'
import { useText } from 'common/texts/TextProvider'
import Icon from 'common/components/Icon'
import Button from 'common/components/Button'
import ConfirmButton from 'common/components/ConfirmButton'
import Flex from 'common/components/Flex'
import StoreListEditor from './StoreListEditor'
import VectorBasemap from './VectorBasemap'
import CityBordersLayer from './CityBordersLayer'
import styles from './supplyAreas.module.css'

const SNAP_THRESHOLD_PX = 20
const TILESET_STORAGE_KEY = 'supplyMapTileset'
const LABEL_SCALE_STORAGE_KEY = 'supplyMapLabelScale'
const LABELS_VISIBLE_STORAGE_KEY = 'supplyMapLabelsVisible'
const LABEL_SCALE_MIN = 1
const LABEL_SCALE_MAX = 1.6
const clampLabelScale = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v)
    if (!Number.isFinite(n)) return LABEL_SCALE_MIN
    return Math.min(LABEL_SCALE_MAX, Math.max(LABEL_SCALE_MIN, n))
}
const snapKeyFor = (lat, lng) => `${Math.floor(lat * 100)}_${Math.floor(lng * 100)}`

import { runtimeEnv } from 'common/functions/runtimeEnv.js'

// CARTO light/dark/standard render as vector (MapLibre GL style) with raster PNG fallback
// when no API key is configured. Satellite stays raster-only.
// Key resolves lazily (SSR window.__ENV__ first, baked build-time fallback)
// so it works regardless of module-eval order vs index.jsx.
const getCartoKey = () => runtimeEnv('CARTO_KEY', typeof CARTO_KEY !== 'undefined' ? CARTO_KEY : '')

const ATTR_CARTO = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
const getTilesets = () => {
    const key = getCartoKey()
    return {
        light: {
            label: 'supply_map_minimal',
            style: `https://basemaps.cartocdn.com/gl/positron-gl-style/style.json?key=${key}`,
            url: `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?lang=he&key=${key}`,
            attribution: ATTR_CARTO,
        },
        dark: {
            label: 'supply_map_dark',
            style: `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=${key}`,
            url: `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?lang=he&key=${key}`,
            attribution: ATTR_CARTO,
        },
        standard: {
            label: 'supply_map_standard',
            style: `https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json?key=${key}`,
            url: `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?lang=he&key=${key}`,
            attribution: ATTR_CARTO,
        },
        satellite: {
            label: 'supply_map_satellite',
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            attribution: 'Tiles &copy; Esri',
        },
    }
}

const polygonStyle = ({ selected, draftMember, groupMember, served }) => {
    if (selected) return { color: '#2563eb', weight: 2.5, fillColor: '#3b82f6', fillOpacity: 0.35 }
    if (draftMember || groupMember) return { color: '#7c3aed', weight: 2, fillColor: '#8b5cf6', fillOpacity: 0.4 }
    if (served) return { color: '#195855', weight: 2, fillColor: '#195855', fillOpacity: 0.28 }
    return { color: '#64748b', weight: 1.5, fillColor: '#94a3b8', fillOpacity: 0.15 }
}

const STORE_PIN_HTML = (color) => `
    <svg viewBox="0 0 24 24" style="width:26px;height:26px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
        <circle cx="12" cy="9" r="3" fill="#fff"/>
    </svg>`

const storePinIcon = (active) => L.divIcon({
    className: '',
    html: STORE_PIN_HTML(active ? '#16a34a' : '#64748b'),
    iconSize: [26, 26],
    iconAnchor: [13, 26],
    popupAnchor: [0, -24],
})

const TEST_ICON = L.divIcon({
    className: '',
    html: `
        <svg viewBox="0 0 24 24" style="width:30px;height:30px;filter:drop-shadow(0 1px 3px rgba(0,0,0,.5))">
            <path d="M12 1.8l2.6 5.8 6.4.5-4.8 4.2 1.5 6.3L12 15.5 6.3 18.6l1.5-6.3L3 8.1l6.4-.5z" fill="#7c3aed" stroke="#fff" stroke-width="1.3"/>
        </svg>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -18],
})

function FlyToPoint({ point }) {
    const map = useMap()
    useEffect(() => {
        if (point) map.panTo([point.lat, point.lng], { animate: true, duration: 1 })
    }, [point, map])
    return null
}

function MapRegistrar({ mapRef }) {
    const map = useMap()
    useEffect(() => {
        mapRef.current = map
        return () => { mapRef.current = null }
    }, [map, mapRef])
    return null
}

const buttonStyle = `
display:block;
min-width: 200px;
border-radius:6px;
margin-bottom:10px;
padding:10px 14px;
color:#fff;
font-weight:600;
font-size:13px;
text-align:center;`
// Custom Save/Cancel control shown while a single area is being vertex-edited
function createEditActionsControl(map, labels, onSave, onCancel) {
    const control = new L.Control({ position: 'bottomright' })
    control.onAdd = () => {
        const container = L.DomUtil.create('div', 'leaflet-control')
        container.style.cssText = 'display:flex;flex-direction:row;gap:8px;background:transparent;overflow:hidden;'

        const save = L.DomUtil.create('a', '', container)
        save.href = '#'
        save.title = labels.save
        save.innerHTML = `&#10003; ${labels.save}`
        save.style.cssText = `${buttonStyle}background:#195855;`
        save.onclick = (ev) => { L.DomEvent.stop(ev); onSave() }

        const cancel = L.DomUtil.create('a', '', container)
        cancel.href = '#'
        cancel.title = labels.cancel
        cancel.innerHTML = `&#10005; ${labels.cancel}`
        cancel.style.cssText = `${buttonStyle}background:#475569;`
        cancel.onclick = (ev) => { L.DomEvent.stop(ev); onCancel() }

        return container
    }
    map.addControl(control)
    return control
}

// leaflet-draw is a UMD bundle referencing the global `L`. Under Vite there is no
// global, so expose it first and then dynamically import the plugin.
function useDrawReady() {
    const [ready, setReady] = useState(false)

    useEffect(() => {
        let mounted = true

        async function load() {
            try {
                if (!window.L) window.L = L
                await import('leaflet-draw')
                if (mounted) setReady(true)
            } catch (e) {
                console.error('Failed to load leaflet-draw:', e)
            }
        }
        load()

        return () => { mounted = false }
    }, [])

    return ready
}

function getPaddedBounds(map) {
    const b = map.getBounds().pad(0.1)
    return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() }
}

function MapController({
    areas,
    selectedId,
    unionIds = [],
    geometryEditingId,
    cuttingId,
    servedAreaIds,
    groupAreaIds,
    draftAreaIds,
    toggleMode,
    drawing,
    onSelect,
    onUnionToggle,
    onToggleArea,
    onCreated,
    onCutCommit,
    onEdited,
    onGeometryCancel,
    onBackgroundClick,
    onViewportChange
}) {
    const map = useMap()
    const { TR } = useText()
    const drawReady = useDrawReady()
    const groupRef = useRef(null)
    const layersRef = useRef(new Map())
    const drawHandlerRef = useRef(null)
    const snapTargetsRef = useRef(new Map())
    const snapEdgesRef = useRef([])
    const editLayerRef = useRef(null)
    const editOriginalRef = useRef(null)
    const editControlRef = useRef(null)
    const cbRef = useRef({ onSelect, onUnionToggle, onToggleArea, onCreated, onCutCommit, onEdited, onGeometryCancel, onBackgroundClick, onViewportChange, selectedId, geometryEditingId, cuttingId, drawing, toggleMode })
    cbRef.current = { onSelect, onUnionToggle, onToggleArea, onCreated, onCutCommit, onEdited, onGeometryCancel, onBackgroundClick, onViewportChange, selectedId, geometryEditingId, cuttingId, drawing, toggleMode }

    const removeEditControl = useCallback(() => {
        if (editControlRef.current) {
            map.removeControl(editControlRef.current)
            editControlRef.current = null
        }
    }, [map])

    // Discard unsaved vertex moves and restore the original shape
    const revertEdit = useCallback(() => {
        const cur = editLayerRef.current
        if (cur && editOriginalRef.current) {
            cur.getLatLngs().forEach((ring, i) => ring.forEach((point, j) => {
                const orig = editOriginalRef.current?.[i]?.[j]
                if (orig) {
                    point.lat = orig.lat
                    point.lng = orig.lng
                }
            }))
            cur.redraw()
        }
    }, [])

    // Disable vertex editing on the active layer and remove Save/Cancel control
    const stopEdit = useCallback(() => {
        const layer = editLayerRef.current
        if (layer?.editing) layer.editing.disable()
        editLayerRef.current = null
        editOriginalRef.current = null
        removeEditControl()
    }, [removeEditControl])

    const commitEdit = useCallback(() => {
        const cur = editLayerRef.current
        const geometry = cur?.toGeoJSON?.().geometry
        const id = cur?.supplyAreaId
        stopEdit()
        if (cur && geometry) cbRef.current.onEdited?.(id, geometry)
    }, [stopEdit])

    const cancelEdit = useCallback(() => {
        revertEdit()
        stopEdit()
        cbRef.current.onGeometryCancel?.()
    }, [revertEdit, stopEdit])

    const startEdit = useCallback((layer) => {
        if (editLayerRef.current === layer) return
        if (!L.Edit?.Poly || !L.LatLngUtil?.cloneLatLngs) return
        stopEdit()
        if (layer.editing) layer.editing.disable()
        layer.editing = new L.Edit.Poly(layer)
        editOriginalRef.current = L.LatLngUtil.cloneLatLngs(layer.getLatLngs())
        layer.editing.enable()
        editLayerRef.current = layer
        editControlRef.current = createEditActionsControl(map, {
            save: TR('supply_save_changes'),
            cancel: TR('cancel')
        }, () => commitEdit(), () => cancelEdit())
    }, [map, stopEdit, TR, commitEdit, cancelEdit])

    // Viewport tracking: emit padded bounds once on mount (background rings cover rest)
    useEffect(() => {
        if (!cbRef.current.onViewportChange) return
        const t = setTimeout(() => cbRef.current.onViewportChange?.(getPaddedBounds(map)), 10)
        return () => clearTimeout(t)
    }, [map])

    // Clicking empty map closes area popup (when not drawing/group-editing/geometry-editing)
    // Guard against polygon clicks bubbling to map (they fire layer 'click' then map 'click')
    useEffect(() => {
        function onBgClick(e) {
            if (cbRef.current.drawing || cbRef.current.toggleMode || cbRef.current.geometryEditingId || cbRef.current.cuttingId) return
            // Ignore clicks that originated on a polygon/path - handled by layer handler
            const target = e.originalEvent?.target
            if (target?.closest?.('.leaflet-interactive')) return
            if (target?.tagName?.toLowerCase() === 'path') return
            // Leaflet may have _stopped flag on the DOM event when layer called stopPropagation
            if (e.originalEvent?._stopped) return
            cbRef.current.onBackgroundClick?.()
        }
        map.on('click', onBgClick)
        return () => map.off('click', onBgClick)
    }, [map])

    // Render all area polygons — click selects area (popup); geometry edit only via footer button
    useEffect(() => {
        stopEdit()
        const group = groupRef.current || L.featureGroup().addTo(map)
        groupRef.current = group
        group.clearLayers()
        layersRef.current.clear()

        areas.forEach(area => {
            const rings = (area.location?.coordinates || []).map(ring =>
                ring.map(([lng, lat]) => [lat, lng])
            )
            const layer = L.polygon(rings, polygonStyle({}))
            layer.supplyAreaId = area.id
            layer.on('click', (e) => {
                if (e.originalEvent) L.DomEvent.stop(e.originalEvent)
                if (cbRef.current.toggleMode) {
                    cbRef.current.onToggleArea?.(area.id)
                    return
                }
                if (cbRef.current.drawing) return
                if (cbRef.current.geometryEditingId) return
                if (cbRef.current.cuttingId) return
                if (e.originalEvent?.ctrlKey || e.originalEvent?.metaKey) {
                    cbRef.current.onUnionToggle?.(area.id)
                    return
                }
                const isSelected = cbRef.current.selectedId === area.id
                cbRef.current.onSelect?.(isSelected ? null : area.id)
            })
            group.addLayer(layer)
            layersRef.current.set(area.id, layer)
        })

        return () => group.clearLayers()
    }, [map, areas])

    // Highlight: selected / union members (blue) > current group members (purple) > served by store (orange) > default.
    useEffect(() => {
        layersRef.current.forEach((layer, id) => {
            layer.setStyle(polygonStyle({
                selected: id === selectedId || unionIds.includes(id),
                draftMember: draftAreaIds.includes(id),
                groupMember: !toggleMode && groupAreaIds.includes(id),
                served: servedAreaIds.includes(id)
            }))
        })
    }, [selectedId, unionIds, servedAreaIds, groupAreaIds, draftAreaIds, toggleMode])

    // Refresh snapping targets (existing area vertices + edges) — bucketed grid for vertices + flat edge list
    useEffect(() => {
        const grid = new Map()
        const edges = []
        areas.forEach(area =>
            area.location?.coordinates?.forEach(ring => {
                ring.forEach(([lng, lat]) => {
                    const p = L.latLng(lat, lng)
                    const k = snapKeyFor(lat, lng)
                    if (!grid.has(k)) grid.set(k, [])
                    grid.get(k).push(p)
                })
                for (let i = 0; i < ring.length - 1; i++) {
                    const [lng1, lat1] = ring[i]
                    const [lng2, lat2] = ring[i + 1]
                    if (lng1 === lng2 && lat1 === lat2) continue
                    edges.push([L.latLng(lat1, lng1), L.latLng(lat2, lng2)])
                }
            })
        )
        snapTargetsRef.current = grid
        snapEdgesRef.current = edges
    }, [areas])

    // Find nearest snap target — vertices win over edges. If any vertex within threshold, snap to vertex; otherwise try edge projection.
    const findSnapLatLng = useCallback((latlng) => {
        const hasVertices = snapTargetsRef.current.size > 0
        const hasEdges = snapEdgesRef.current.length > 0
        if (!latlng || (!hasVertices && !hasEdges)) return null

        const cursorPt = map.latLngToContainerPoint(latlng)
        let best = null
        let bestDist = SNAP_THRESHOLD_PX

        // Vertex snap (bucketed) — strongest priority
        if (hasVertices) {
            const baseLat = Math.floor(latlng.lat * 100)
            const baseLng = Math.floor(latlng.lng * 100)
            for (let dLat = -1; dLat <= 1; dLat++) {
                for (let dLng = -1; dLng <= 1; dLng++) {
                    const bucket = snapTargetsRef.current.get(`${baseLat + dLat}_${baseLng + dLng}`)
                    if (!bucket) continue
                    for (const target of bucket) {
                        if (target.lat === latlng.lat && target.lng === latlng.lng) continue
                        const dist = cursorPt.distanceTo(map.latLngToContainerPoint(target))
                        if (dist <= bestDist) {
                            bestDist = dist
                            best = target
                        }
                    }
                }
            }
            if (best) return best
        }

        // Edge snap: project cursor onto each segment (in container-pixel space for hit-test) — only if no vertex within threshold
        // Snapped point is interpolated in geographic (lat/lng) space so it lies *exactly* on the stored segment.
        if (hasEdges) {
            let edgeBest = null
            let edgeBestDist = SNAP_THRESHOLD_PX
            let edgeBestT = 0
            let edgeBestA = null
            let edgeBestB = null
            for (const [a, b] of snapEdgesRef.current) {
                if (a.lat === b.lat && a.lng === b.lng) continue
                const aPt = map.latLngToContainerPoint(a)
                const bPt = map.latLngToContainerPoint(b)
                const dx = bPt.x - aPt.x
                const dy = bPt.y - aPt.y
                const len2 = dx * dx + dy * dy
                if (len2 === 0) continue
                const t = ((cursorPt.x - aPt.x) * dx + (cursorPt.y - aPt.y) * dy) / len2
                const tClamped = Math.max(0, Math.min(1, t))
                const projX = aPt.x + tClamped * dx
                const projY = aPt.y + tClamped * dy
                const projPt = L.point(projX, projY)
                const dist = cursorPt.distanceTo(projPt)
                if (dist < edgeBestDist) {
                    edgeBestDist = dist
                    edgeBestT = tClamped
                    edgeBestA = a
                    edgeBestB = b
                }
            }
            if (edgeBestA && edgeBestB) {
                // Interpolate in lat/lng space — guarantees the snapped point is exactly colinear with the stored edge
                const lat = edgeBestA.lat + edgeBestT * (edgeBestB.lat - edgeBestA.lat)
                const lng = edgeBestA.lng + edgeBestT * (edgeBestB.lng - edgeBestA.lng)
                const projLatLng = L.latLng(lat, lng)
                if (projLatLng.lat === latlng.lat && projLatLng.lng === latlng.lng) return null
                return projLatLng
            }
        }

        return best
    }, [map])

    // Snap vertices to nearby existing-area vertex OR edge within threshold (in screen px).
    const snapInPlace = useCallback((rings) => {
        if (!rings?.length) return false
        if (!snapTargetsRef.current.size && !snapEdgesRef.current.length) return false

        let changed = false
        rings.forEach(ring => ring.forEach(point => {
            const snapped = findSnapLatLng(point)
            if (snapped && (snapped.lat !== point.lat || snapped.lng !== point.lng)) {
                point.lat = snapped.lat
                point.lng = snapped.lng
                changed = true
            }
        }))

        return changed
    }, [findSnapLatLng])

    // Live snap while dragging a vertex (in place, so dragging away again unsnaps)
    const onEditVertex = useCallback((e) => {
        const poly = e?.poly
        if (!poly || poly !== editLayerRef.current) return
        if (!snapInPlace(poly.getLatLngs())) return

        poly.redraw()
        const edit = poly.editing
        const rings = poly.getLatLngs()
        edit?._verticesHandlers?.forEach((handler, ringIdx) => {
            const ring = rings[ringIdx]
            handler._markers?.forEach((marker, j) => {
                const latlng = ring?.[j]
                if (latlng) marker.setLatLng(latlng)
            })
        })
    }, [snapInPlace])

    // Start/cancel vertex editing when parent sets geometryEditingId (Edit shape flow, Option H)
    useEffect(() => {
        if (!geometryEditingId) {
            if (editLayerRef.current) {
                revertEdit()
                stopEdit()
            }
            return
        }
        const layer = layersRef.current.get(geometryEditingId)
        if (layer) startEdit(layer)
    }, [geometryEditingId, startEdit, revertEdit, stopEdit])

    // leaflet-draw ships English mouse hints — localize to Hebrew once loaded
    useEffect(() => {
        if (!drawReady) return
        const handlers = L.drawLocal?.draw?.handlers
        if (!handlers) return
        if (handlers.polygon?.tooltip) {
            handlers.polygon.tooltip.start = TR('supply_draw_shape_start')
            handlers.polygon.tooltip.cont = TR('supply_draw_shape_cont')
            handlers.polygon.tooltip.end = TR('supply_draw_shape_end')
        }
        if (handlers.polyline) {
            handlers.polyline.error = TR('supply_draw_error_cross')
            if (handlers.polyline.tooltip) {
                handlers.polyline.tooltip.start = TR('supply_draw_line_start')
                handlers.polyline.tooltip.cont = TR('supply_draw_line_cont')
                handlers.polyline.tooltip.end = TR('supply_draw_line_end')
            }
        }
    }, [drawReady, TR])

    // New-area draw completion + live vertex snapping
    useEffect(() => {
        if (!drawReady) return

        function onCreated(e) {
            const layer = e.layer
            if (!(layer instanceof L.Polygon)) return

            if (drawHandlerRef.current) {
                drawHandlerRef.current.disable()
                drawHandlerRef.current = null
            }

            const rings = layer.getLatLngs?.()
            if (rings?.length && snapInPlace(rings)) layer.redraw()
            map.removeLayer(layer)
            cbRef.current.onCreated?.(layer.toGeoJSON().geometry)
        }

        map.on(L.Draw.Event.CREATED, onCreated)
        map.on(L.Draw.Event.EDITVERTEX, onEditVertex)

        return () => {
            map.off(L.Draw.Event.CREATED, onCreated)
            map.off(L.Draw.Event.EDITVERTEX, onEditVertex)
        }
    }, [map, drawReady, onEditVertex, snapInPlace])

    // "New Area" mode: programmatic polygon draw handler with live snap to nearby vertices/edges
    useEffect(() => {
        if (!drawReady) return

        if (!drawing) {
            if (drawHandlerRef.current) {
                drawHandlerRef.current.disable()
                drawHandlerRef.current = null
            }
            return
        }

        const handler = new L.Draw.Polygon(map, {
            allowIntersection: false,
            shapeOptions: { color: '#3b82f6', weight: 2 }
        })

        // Snap the actual vertex that gets added on click/tap (vertex or edge)
        const origAddVertex = handler.addVertex.bind(handler)
        handler.addVertex = function (latlng) {
            const snapped = findSnapLatLng(latlng)
            return origAddVertex(snapped ? L.latLng(snapped.lat, snapped.lng) : latlng)
        }

        handler.enable()
        drawHandlerRef.current = handler
        stopEdit()

        // Live snap of the guide / mouse-marker while moving (runs after handler's own mousemove)
        function onDrawMouseMove() {
            const cur = handler._currentLatLng
            if (!cur) return
            const snapped = findSnapLatLng(cur)
            if (!snapped || (snapped.lat === cur.lat && snapped.lng === cur.lng)) return
            const snapLatLng = L.latLng(snapped.lat, snapped.lng)
            handler._currentLatLng = snapLatLng
            handler._mouseMarker.setLatLng(snapLatLng)
            handler._updateGuide(map.latLngToLayerPoint(snapLatLng))
            handler._updateTooltip(snapLatLng)
        }
        map.on('mousemove', onDrawMouseMove)

        function onDrawStop() {
            drawHandlerRef.current = null
        }
        map.on(L.Draw.Event.DRAWSTOP, onDrawStop)

        return () => {
            map.off('mousemove', onDrawMouseMove)
            map.off(L.Draw.Event.DRAWSTOP, onDrawStop)
            handler.disable()
            if (drawHandlerRef.current === handler) drawHandlerRef.current = null
            handler.addVertex = origAddVertex
        }
    }, [map, drawReady, drawing, stopEdit, findSnapLatLng])

    // "Cut area" mode: polyline draw session for the area being split.
    // Double-click / Enter finishes and commits the cut line to the parent.
    useEffect(() => {
        if (!drawReady) return
        if (!cuttingId) return

        const handler = new L.Draw.Polyline(map, {
            shapeOptions: { color: '#dc2626', weight: 3 }
        })
        handler.enable()
        stopEdit()

        function onCutCreated(e) {
            const layer = e.layer
            // L.Polygon extends L.Polyline — only accept a true open polyline
            if (!(layer instanceof L.Polyline) || layer instanceof L.Polygon) return
            if (drawHandlerRef.current) {
                drawHandlerRef.current.disable()
                drawHandlerRef.current = null
            }
            const id = cbRef.current.cuttingId
            map.removeLayer(layer)
            if (id) cbRef.current.onCutCommit?.(id, layer.toGeoJSON().geometry)
        }
        function onCutStop() {
            drawHandlerRef.current = null
        }
        drawHandlerRef.current = handler
        map.on(L.Draw.Event.CREATED, onCutCreated)
        map.on(L.Draw.Event.DRAWSTOP, onCutStop)

        return () => {
            map.off(L.Draw.Event.CREATED, onCutCreated)
            map.off(L.Draw.Event.DRAWSTOP, onCutStop)
            handler.disable()
            if (drawHandlerRef.current === handler) drawHandlerRef.current = null
        }
    }, [map, drawReady, cuttingId, stopEdit])

    return null
}

function AreaEditForm({ areaDraft, setAreaDraft, stores, savingArea, onCancel, onSave }) {
    const { TR } = useText()
    const [localName, setLocalName] = useState(areaDraft.name)
    // Sync when switching to a different area (id changes), but not on every keystroke
    useEffect(() => { setLocalName(areaDraft.name) }, [areaDraft.id])
    const handleSave = () => {
        // Commit local name to parent draft before save
        const toSave = { ...areaDraft, name: localName }
        setAreaDraft(toSave)
        onSave(toSave)
    }
    const handleBlur = () => {
        if (localName !== areaDraft.name) setAreaDraft(prev => ({ ...prev, name: localName }))
    }
    return (
        <>
            <div className={styles.areaPopupHeader}>
                <input
                    className={styles.groupNameInput}
                    value={localName}
                    onChange={e => setLocalName(e.target.value)}
                    onBlur={handleBlur}
                    placeholder={TR('name')}
                    autoFocus
                />
            </div>
            <StoreListEditor
                stores={stores}
                storeIds={areaDraft.storeIds || []}
                onChange={ids => setAreaDraft(prev => ({ ...prev, storeIds: ids }))}
            />
            <Flex gap={8} justifyContent="end" style={{ marginTop: 8 }}>
                <Button size="s" mode="outline" onClick={onCancel}>cancel</Button>
                <Button size="s" icon="check" loading={savingArea} onClick={handleSave}>save</Button>
            </Flex>
        </>
    )
}

export default function SupplyAreaMap({
    areas = [], stores = [], activeStoreIds = [], servedAreaIds = [], groupAreaIds = [], draftAreaIds = [],
    focusPoint, focusGroupPoint, testPoint, testLabel, lastFocus,
    selectedId, unionIds = [], geometryEditingId, cuttingId, areaDraft, setAreaDraft, savingArea,
    onSelect, onUnionToggle, onStartAreaPropsEdit, onSaveAreaProps, onCancelAreaPropsEdit, onDeleteArea, onStartGeometryEdit, onStartCut,
    onViewportChange, onCreateArea, cityBorders, onToggleCityBorders,
    toggleMode, drawing, onToggleArea, onCreated, onCutCommit, onEdited, onGeometryCancel, onBackgroundClick,
    isFullscreen, onToggleFullscreen, sidebarOpen = true,
}) {
    const { TR } = useText()

    // Leaflet caches its container size — re-measure on any layout change
    // (sidebar toggle, fullscreen, drawer) via ResizeObserver on the map wrapper
    const mapRef = useRef(null)
    const wrapRef = useRef(null)
    useEffect(() => {
        const el = wrapRef.current
        if (!el || typeof ResizeObserver === 'undefined') {
            const t = setTimeout(() => mapRef.current?.invalidateSize(), 120)
            return () => clearTimeout(t)
        }
        let t = null
        const ro = new ResizeObserver(() => {
            clearTimeout(t)
            t = setTimeout(() => mapRef.current?.invalidateSize(), 100)
        })
        ro.observe(el)
        return () => { clearTimeout(t); ro.disconnect() }
    }, [])

    // Explicit re-measure on sidebar open/close (in addition to the observer)
    useEffect(() => {
        const t = setTimeout(() => mapRef.current?.invalidateSize(), 150)
        return () => clearTimeout(t)
    }, [sidebarOpen])

    const selectedArea = useMemo(() => areas.find(a => a.id === selectedId) || null, [areas, selectedId])
    const popupPosition = useMemo(() => {
        if (!selectedArea?.location?.coordinates?.length || geometryEditingId || cuttingId) return null
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity, count = 0
        selectedArea.location.coordinates.forEach(ring => ring.forEach(([lng, lat]) => {
            if (lat < minLat) minLat = lat
            if (lat > maxLat) maxLat = lat
            if (lng < minLng) minLng = lng
            if (lng > maxLng) maxLng = lng
            count++
        }))
        if (!count) return null
        return [(minLat + maxLat) / 2, (minLng + maxLng) / 2]
    }, [selectedArea, geometryEditingId, cuttingId])
    const isAreaEditing = !!areaDraft && areaDraft.id === selectedId
    // Tileset: explicit user pick persists; otherwise follows the admin dark/light theme
    const [tilesetId, setTilesetId] = useState(() => {
        const stored = localStorage.getItem(TILESET_STORAGE_KEY)
        if (stored && getTilesets()[stored]) return stored
        return document.documentElement.getAttribute('data-theme')
    })
    const [customTileset, setCustomTileset] = useState(() => !!localStorage.getItem(TILESET_STORAGE_KEY))

    useEffect(() => {
        if (customTileset) return
        const observer = new MutationObserver(() => {
            setTilesetId(document.documentElement.getAttribute('data-theme'))
        })
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
        return () => observer.disconnect()
    }, [customTileset])

    const pickTileset = (id) => {
        localStorage.setItem(TILESET_STORAGE_KEY, id)
        setCustomTileset(true)
        setTilesetId(id)
    }

    const tilesets = useMemo(getTilesets, [])
    const tileset = tilesets[tilesetId] || tilesets.light
    const isVector = !!(tileset.style && getCartoKey())
    // City-border labels follow the basemap, not the admin UI theme —
    // otherwise light-theme text + white halo glows on a dark basemap.
    const isDarkBasemap = tilesetId === 'dark' || tilesetId === 'satellite'
    // Vector label size multiplier (1–1.6) — raster PNGs bake labels in, so
    // the slider only shows for vector basemaps. Persists across sessions.
    const [labelScale, setLabelScale] = useState(() => clampLabelScale(localStorage.getItem(LABEL_SCALE_STORAGE_KEY)))
    const changeLabelScale = (v) => {
        const next = clampLabelScale(v)
        localStorage.setItem(LABEL_SCALE_STORAGE_KEY, String(next))
        setLabelScale(next)
    }
    // Basemap (vector) label visibility — same persistence pattern as label scale
    const [labelsVisible, setLabelsVisible] = useState(() => localStorage.getItem(LABELS_VISIBLE_STORAGE_KEY) !== '0')
    const toggleLabelsVisible = () => {
        const next = !labelsVisible
        localStorage.setItem(LABELS_VISIBLE_STORAGE_KEY, next ? '1' : '0')
        setLabelsVisible(next)
    }

    const storePins = useMemo(() => stores.filter(s => {
        const c = s.address?.location?.coordinates
        return Array.isArray(c) && c.length === 2
    }), [stores])

    // Most recent user intent wins: a store click after a search pans to the
    // store, a new search after a store click pans to the searched address.
    const activeFlyPoint = useMemo(() => {
        if (lastFocus === 'store') return focusPoint || focusGroupPoint || testPoint || null
        if (lastFocus === 'test') return testPoint || focusPoint || focusGroupPoint || null
        if (lastFocus === 'group') return focusGroupPoint || focusPoint || testPoint || null
        return testPoint || focusGroupPoint || focusPoint || null
    }, [lastFocus, testPoint, focusGroupPoint, focusPoint])
    const center = useMemo(() => {
        const c = storePins[0]?.address?.location?.coordinates
        return c ? [c[1], c[0]] : null
    }, [storePins])

    return (
        center && <div ref={wrapRef} className={styles.mapInnerWrap}>
            <MapContainer
                center={center}
                zoom={12}
                style={{ height: '100%', width: '100%' }}
                scrollWheelZoom
                preferCanvas
            >
                {isVector ? (
                    <VectorBasemap
                        key={tilesetId}
                        styleUrl={tileset.style}
                        labelScale={labelScale}
                        labelsVisible={labelsVisible}
                    />
                ) : (
                    <TileLayer
                        key={tilesetId}
                        url={tileset.url}
                        attribution={tileset.attribution}
                    />
                )}
                <CityBordersLayer
                    visible={cityBorders}
                    drawing={drawing}
                    toggleMode={toggleMode}
                    geometryEditingId={geometryEditingId}
                    cuttingId={cuttingId}
                    darkBasemap={isDarkBasemap}
                    onCreateArea={onCreateArea}
                />
                <MapController
                    areas={areas}
                    servedAreaIds={servedAreaIds}
                    groupAreaIds={groupAreaIds}
                    draftAreaIds={draftAreaIds}
                    selectedId={selectedId}
                    unionIds={unionIds}
                    geometryEditingId={geometryEditingId}
                    cuttingId={cuttingId}
                    toggleMode={toggleMode}
                    drawing={drawing}
                    onSelect={onSelect}
                    onUnionToggle={onUnionToggle}
                    onToggleArea={onToggleArea}
                    onCreated={onCreated}
                    onCutCommit={onCutCommit}
                    onEdited={onEdited}
                    onGeometryCancel={onGeometryCancel}
                    onBackgroundClick={onBackgroundClick}
                    onViewportChange={onViewportChange}
                />
                {selectedArea && popupPosition && !unionIds.length && (
                    <Popup
                        position={popupPosition}
                        maxWidth={420}
                        minWidth={300}
                        autoClose={false}
                        closeOnClick={false}
                        eventHandlers={{ remove: () => onSelect?.(null) }}
                    >
                        <div className={styles.areaPopup} onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
                            {!isAreaEditing ? (
                                <>
                                    <div className={styles.areaPopupHeader}>
                                        <strong className={styles.areaPopupTitle}>{selectedArea.name || <Text size="none">no_name</Text>}</strong>
                                        <span>vertices: {selectedArea.location.coordinates?.[0].length - 1}</span>
                                        <Flex gap={6} className={styles.areaPopupActions}>
                                            <Button size="s" icon="edit" tooltip="supply_edit_details" onClick={onStartAreaPropsEdit}></Button>
                                            <ConfirmButton
                                                q={`${TR('supply_delete_area_confirm')}${selectedArea.name ? ` "${selectedArea.name}"` : ''}?`}
                                                onOk={onDeleteArea}
                                                size="s"
                                                icon="trash"
                                                tooltip="supply_delete_area"
                                                mode="outline"
                                                className={styles.deleteButton}
                                            />
                                        </Flex>
                                    </div>
                                    <div className={styles.areaPopupStores}>
                                        {(selectedArea.stores || []).length ? (
                                            (selectedArea.stores || []).map(s => {
                                                const st = stores.find(x => x.id === s.storeId)
                                                return <span key={s.storeId} className={styles.areaPopupTag}>{st ? `${st.name}` : s.storeId}</span>
                                            })
                                        ) : (
                                            <span className={styles.areaPopupEmpty}><Text size="none">supply_no_stores_assigned</Text></span>
                                        )}
                                    </div>
                                    <Flex gap={8} justifyContent="end" style={{ marginTop: 8 }}>
                                        <Button size="s" mode="outline" onClick={() => onSelect?.(null)}>cancel</Button>
                                        <Button size="s" icon="cut" tooltip={`${TR('supply_cut_area')} (P)`} onClick={() => onStartCut?.(selectedArea.id)}>supply_cut_area</Button>
                                        <Button size="s" icon="edit" tooltip={`${TR('supply_edit_shape')} (E)`} onClick={onStartGeometryEdit}>supply_edit_shape</Button>
                                    </Flex>
                                </>
                            ) : (
                                <AreaEditForm
                                    areaDraft={areaDraft}
                                    setAreaDraft={setAreaDraft}
                                    stores={stores}
                                    savingArea={savingArea}
                                    onCancel={onCancelAreaPropsEdit}
                                    onSave={onSaveAreaProps}
                                />
                            )}
                        </div>
                    </Popup>
                )}
                {storePins.map(store => {
                    const [lng, lat] = store.address.location.coordinates
                    const active = activeStoreIds.includes(store.id)
                    const a = store.address || {}
                    return (
                        <Marker
                            key={store.id}
                            position={[lat, lng]}
                            icon={storePinIcon(active)}
                        >
                            <Popup>
                                <div>
                                    <strong>{store.name}</strong>
                                    <div className={styles.popupSubtle}>
                                        {[a.city, a.street, a.building].filter(Boolean).join(', ')}
                                    </div>
                                </div>
                            </Popup>
                        </Marker>
                    )
                })}
                {testPoint && (
                    <Marker
                        position={[testPoint.lat, testPoint.lng]}
                        icon={TEST_ICON}
                    >
                        <Popup>{testLabel}</Popup>
                    </Marker>
                )}
                <FlyToPoint point={activeFlyPoint} />
                <MapRegistrar mapRef={mapRef} />
            </MapContainer>
            {onToggleFullscreen && (
                <button
                    type="button"
                    className={styles.fullscreenBtn}
                    title={`${TR(isFullscreen ? 'supply_map_exit_fullscreen' : 'supply_map_fullscreen')} (F)`}
                    onClick={onToggleFullscreen}
                >
                    <Icon name={isFullscreen ? 'minimize' : 'maximize'} />
                </button>
            )}
            <div className={`${styles.tilePickerWrap} ${!sidebarOpen ? styles.tilePickerWrapShifted : ''}`}>
                <div className={styles.tilePicker}>
                    {Object.entries(tilesets).map(([id, ts]) => (
                        <button
                            key={id}
                            type="button"
                            title={`${TR('supply_basemap')}: ${TR(ts.label)}`}
                            className={id === tilesetId ? `${styles.tileBtn} ${styles.tileBtnActive}` : styles.tileBtn}
                            onClick={() => pickTileset(id)}
                        >
                            <Text size="none">{ts.label}</Text>
                        </button>
                    ))}
                    <button
                        type="button"
                        title={TR('supply_city_borders')}
                        className={cityBorders ? `${styles.tileBtn} ${styles.tileBtnActive}` : styles.tileBtn}
                        onClick={() => onToggleCityBorders()}
                    >
                        <Text size="none">supply_city_borders</Text>
                    </button>
                </div>
                {isVector && (
                    <div className={styles.labelScaleRow}>
                        <button
                            type="button"
                            onClick={toggleLabelsVisible}
                            className={labelsVisible ? styles.labelScaleToggle : `${styles.labelScaleToggle} ${styles.labelScaleToggleOff}`}
                        >
                            {labelsVisible ? <TbEye /> : <TbEyeOff />}
                        </button>
                        <TbTextSize className={styles.labelScaleIcon} />
                        <input
                            type="range"
                            min={LABEL_SCALE_MIN}
                            max={LABEL_SCALE_MAX}
                            step={0.01}
                            value={labelScale}
                            title={labelScale.toFixed(2)}
                            onChange={e => changeLabelScale(e.target.value)}
                            disabled={!labelsVisible}
                            className={styles.labelScaleSlider}
                        />
                    </div>
                )}
            </div>
        </div>
    )
}
