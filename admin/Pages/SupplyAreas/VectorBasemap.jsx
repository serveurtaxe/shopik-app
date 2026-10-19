import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import 'maplibre-gl/dist/maplibre-gl.css'

// Vector basemap rendered *inside* Leaflet via @maplibre/maplibre-gl-leaflet.
// Leaflet keeps owning pan/zoom/events and every overlay (area polygons,
// leaflet-draw, store pins); MapLibre paints CARTO vector tiles into the
// tile pane, non-interactive, following the Leaflet view.

// maplibre-gl v6 is ESM-only and needs its worker URL configured for Vite.
// `?worker&url` (not plain `?url`) routes the worker through Vite's worker
// pipeline so its `./maplibre-gl-shared.mjs` import is bundled into a
// self-contained chunk. See https://maplibre.org/maplibre-gl-js/docs/
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

// CARTO vector tiles carry `name:he` on every label layer (place, poi,
// transportation_name, water_name, ...). Point all name-based label layers
// at Hebrew with local-name fallback — the vector equivalent of the old
// raster `?lang=he`. Layers using {ref}/{housenumber} (road shields, house
// numbers) are left untouched.
//
// NOTE: CARTO switches language by zoom — most label layers use a stops
// function like {"stops": [[8, "{name_en}"], [13, "{name}"]]} (English far,
// local near). Collapsing the whole text-field to one Hebrew-first
// expression is what makes Hebrew stick at *every* zoom.
const HEBREW_TEXT_FIELD = ['coalesce', ['get', 'name:he'], ['get', 'name']]

function isNameLabel(textField) {
    if (typeof textField === 'string') return textField.includes('name')
    if (!textField || typeof textField !== 'object') return false
    return /(name_en|name:latin|name:he|name_int|\{name\})/.test(JSON.stringify(textField))
}

function applyHebrewLabels(mbMap) {
    const layers = mbMap?.getStyle?.()?.layers
    if (!layers) return
    layers.forEach(layer => {
        if (layer.type !== 'symbol') return
        if (!isNameLabel(layer.layout?.['text-field'])) return
        try {
            mbMap.setLayoutProperty(layer.id, 'text-field', HEBREW_TEXT_FIELD)
        } catch {
            // Unknown/unsupported layer — leave the default label.
        }
    })
}

// text-size comes in three shapes: plain number, legacy stops function, or
// expression. Scale from the captured original so re-applying never compounds.
function scaledSize(original, scale) {
    if (scale === 1 || original == null) return original ?? null
    if (typeof original === 'number') return original * scale
    if (Array.isArray(original)) return ['*', original, scale]
    if (Array.isArray(original.stops)) {
        return {
            ...original,
            stops: original.stops.map(([z, s]) => [z, typeof s === 'number' ? s * scale : s]),
        }
    }
    return null
}

function applyLabelScale(mbMap, sizeOriginals, scale) {
    if (!mbMap || !sizeOriginals) return
    sizeOriginals.forEach((original, layerId) => {
        const next = scaledSize(original, scale)
        if (next == null) return
        try {
            mbMap.setLayoutProperty(layerId, 'text-size', next)
        } catch {
            // Leave the default size.
        }
    })
}

// Show/hide the same name-label layers the Hebrew pass targets. Road
// shields and house numbers (non-name text-fields) are left untouched.
function applyLabelsVisibility(mbMap, visible) {
    const layers = mbMap?.getStyle?.()?.layers
    if (!layers) return
    layers.forEach(layer => {
        if (layer.type !== 'symbol') return
        if (!isNameLabel(layer.layout?.['text-field'])) return
        try {
            mbMap.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none')
        } catch {
            // Leave the default visibility.
        }
    })
}

let workerConfigured = false

export default function VectorBasemap({ styleUrl, labelScale = 1, labelsVisible = true }) {
    const map = useMap()
    const liveRef = useRef(null)
    const scaleRef = useRef(labelScale)
    scaleRef.current = labelScale
    const appliedScaleRef = useRef(null)
    const visibilityRef = useRef(labelsVisible)
    visibilityRef.current = labelsVisible

    useEffect(() => {
        let layer = null
        let cancelled = false

        async function add() {
            const { setWorkerUrl, setRTLTextPlugin } = await import('maplibre-gl')
            if (!workerConfigured) {
                setWorkerUrl(workerUrl)
                try {
                    // Correct BiDi shaping for Hebrew labels. Fire-and-forget:
                    // if the CDN is unreachable the map still renders.
                    setRTLTextPlugin('https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.3.0/dist/mapbox-gl-rtl-text.js')
                } catch {
                    // ignore — labels fall back to unshaped rendering
                }
                workerConfigured = true
            }
            const { maplibreGL } = await import('@maplibre/maplibre-gl-leaflet')
            if (cancelled) return
            layer = maplibreGL({ style: styleUrl })
            layer.addTo(map)
            const mbMap = layer.getMaplibreMap()
            mbMap.once('load', () => {
                if (cancelled) return
                applyHebrewLabels(mbMap)
                applyLabelsVisibility(mbMap, visibilityRef.current)
                const sizeOriginals = new Map()
                mbMap.getStyle()?.layers?.forEach(l => {
                    if (l.type === 'symbol') sizeOriginals.set(l.id, l.layout?.['text-size'])
                })
                liveRef.current = { mbMap, sizeOriginals }
                applyLabelScale(mbMap, sizeOriginals, scaleRef.current)
                appliedScaleRef.current = scaleRef.current
            })
            mbMap.on('error', (e) => console.error('[VectorBasemap] maplibre error:', e?.error || e))
        }
        add()

        return () => {
            cancelled = true
            liveRef.current = null
            if (layer) {
                map.removeLayer(layer)
                layer = null
            }
        }
    }, [map, styleUrl])

    // Re-scale from captured originals once the user stops sliding for 200ms.
    // The slider thumb itself stays instant (controlled upstream); only the
    // ~30 setLayoutProperty calls are debounced. Tracks the last applied
    // value so mount / style-load application never double-fires.
    useEffect(() => {
        if (appliedScaleRef.current === labelScale) return
        const t = setTimeout(() => {
            const live = liveRef.current
            if (!live) return
            applyLabelScale(live.mbMap, live.sizeOriginals, labelScale)
            appliedScaleRef.current = labelScale
        }, 200)
        return () => clearTimeout(t)
    }, [labelScale])

    // Visibility toggles fire once per click — apply immediately, no debounce.
    useEffect(() => {
        const live = liveRef.current
        if (!live) return
        applyLabelsVisibility(live.mbMap, labelsVisible)
    }, [labelsVisible])

    // MapLibre's GL canvas doesn't follow Leaflet container growth on its own
    // (sidebar toggle, fullscreen) — the gl-leaflet bridge resizes its wrapper
    // div but never calls resize(). Leaflet fires 'resize' on invalidateSize —
    // forward it so the canvas backing store matches the new container size.
    // Deferred: the bridge grows its wrapper in a requestAnimationFrame after
    // this handler, so resizing synchronously would lock in the old size.
    useEffect(() => {
        let t = null
        const onResize = () => {
            clearTimeout(t)
            t = setTimeout(() => {
                try { liveRef.current?.mbMap.resize() } catch { /* not loaded yet */ }
            }, 80)
        }
        map.on('resize', onResize)
        return () => { clearTimeout(t); map.off('resize', onResize) }
    }, [map])

    return null
}
