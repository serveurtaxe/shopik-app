import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import useApi from 'common/functions/useApi'
import apiReq from 'common/functions/apiReq'
import Button from 'common/components/Button'
import Checkbox from 'common/components/Checkbox'
import ConfirmButton from 'common/components/ConfirmButton'
import Flex from 'common/components/Flex'
import Card from 'common/components/Card'
import Text from 'common/components/Text'
import Icon from 'common/components/Icon'
import { useText } from 'common/texts/TextProvider'
import SupplyAreaMap from './SupplyAreaMap'
import styles from './supplyAreas.module.css'

const toMessage = (err) => (typeof err === 'string' ? err : err?.message || 'something went wrong')

const MODE_META = {
    new: { icon: 'add', label: 'new area' },
    split: { icon: 'cut', label: 'supply_cut_area' },
    edit: { icon: 'edit', label: 'supply_edit_shape' },
    group: { icon: 'grid', label: 'supply_new_area_group' },
}

const ISRAEL_BOUNDS = { west: 34.2, south: 29.5, east: 35.9, north: 33.4 }
const CITY_BORDERS_KEY = 'supplyMapCityBorders'
const MAX_RINGS = 10
function padBounds(bounds, ratio = 0.5) {
    const latSpan = bounds.north - bounds.south
    const lngSpan = bounds.east - bounds.west
    const latPad = latSpan * ratio
    const lngPad = lngSpan * ratio
    return {
        north: Math.min(ISRAEL_BOUNDS.north, bounds.north + latPad),
        south: Math.max(ISRAEL_BOUNDS.south, bounds.south - latPad),
        east: Math.min(ISRAEL_BOUNDS.east, bounds.east + lngPad),
        west: Math.max(ISRAEL_BOUNDS.west, bounds.west - lngPad)
    }
}
function boundsCoversOuter(outer) {
    return outer.north >= ISRAEL_BOUNDS.north && outer.south <= ISRAEL_BOUNDS.south
        && outer.east >= ISRAEL_BOUNDS.east && outer.west <= ISRAEL_BOUNDS.west
}

function mergeById(prev, incoming) {
    const map = new Map(prev.map(a => [a.id, a]))
    let changed = false
    for (const a of incoming) {
        if (!map.has(a.id)) changed = true
        else {
            const prevA = map.get(a.id)
            if (JSON.stringify(prevA) !== JSON.stringify(a)) changed = true
        }
        map.set(a.id, a)
    }
    if (!changed && incoming.length === 0) return prev
    if (map.size === prev.length && !changed) return prev
    return [...map.values()]
}

// ——— Union adjacency pre-check (client-side, quantized; server re-validates) ———
const quant = (n) => Math.round(n * 1e6)
const ptKeyQ = ([lng, lat]) => `${quant(lng)}_${quant(lat)}`

// Planar point-on-segment with epsilon (degree space)
function ptOnSegQ([px, py], [ax, ay], [bx, by]) {
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    if (Math.abs(cross) > 1e-9) return false
    const dot = (px - ax) * (px - bx) + (py - ay) * (py - by)
    return dot <= 1e-9
}

function ringsTouch(ringA, ringB) {
    const setB = new Set(ringB.map(ptKeyQ))
    if (ringA.some(p => setB.has(ptKeyQ(p)))) return true
    for (let i = 0; i < ringB.length - 1; i++) {
        const a = ringB[i]
        const b = ringB[i + 1]
        if (a[0] === b[0] && a[1] === b[1]) continue
        if (ringA.some(p => ptOnSegQ(p, a, b))) return true
    }
    for (let i = 0; i < ringA.length - 1; i++) {
        const a = ringA[i]
        const b = ringA[i + 1]
        if (a[0] === b[0] && a[1] === b[1]) continue
        if (ringB.some(p => ptOnSegQ(p, a, b))) return true
    }
    return false
}

function areasAdjacent(a, b) {
    const ringsA = a?.location?.coordinates || []
    const ringsB = b?.location?.coordinates || []
    return ringsA.some(ra => ringsB.some(rb => ringsTouch(ra, rb)))
}

export default function SupplyAreas() {
    const { TR } = useText()
    const [areas, setAreas] = useState([])
    const [loading, setLoading] = useState(true)
    const [bgLoading, setBgLoading] = useState(false)
    const viewportBoundsRef = useRef(null)
    const bgRunningRef = useRef(false)
    const { data: stores = [] } = useApi('store/read')
    const { data: groups = [], callReq: refetchGroups } = useApi('area_group/read', { limit: 0 })

    // No full collection refetch — mutations patch single ids (see handleGeometryCommit/handleDeleteAreaPopup/handleMapCreated)
    const patchArea = useCallback((updated) => {
        if (!updated?.id) return
        setAreas(prev => {
            const idx = prev.findIndex(a => a.id === updated.id)
            if (idx === -1) return [...prev, updated]
            const next = [...prev]
            next[idx] = updated
            return next
        })
    }, [])
    const removeArea = useCallback((id) => {
        setAreas(prev => prev.filter(a => a.id !== id))
    }, [])

    const viewportFetchedRef = useRef(false)
    const fetchViewport = useCallback(async (bounds) => {
        if (viewportFetchedRef.current) return
        viewportFetchedRef.current = true
        viewportBoundsRef.current = bounds
        try {
            const data = await apiReq('supply_area/read', {
                // bounds,
                limit: 0,
                select: { id: 1, name: 1, location: 1, stores: 1 }
            })
            if (Array.isArray(data)) {
                setAreas(prev => {
                    if (prev.length === 0) return data
                    return mergeById(prev, data)
                })
            }
        } catch (_) { }
        setLoading(false)
    }, [])

    const startBackgroundFetch = useCallback(async () => {
        return
        if (bgRunningRef.current) return
        bgRunningRef.current = true
        setBgLoading(true)
        try {
            const initial = viewportBoundsRef.current
            if (!initial) return
            let inner = initial
            let outer = padBounds(inner, 0.3)
            for (let ringIdx = 0; ringIdx < MAX_RINGS; ringIdx++) {
                // Stop if outer already covers Israel
                if (boundsCoversOuter(outer) && ringIdx > 0) {
                    // one final ring to catch remainder up to Israel edge
                }
                let skip = 0
                const limit = 200
                while (true) {
                    const page = await apiReq('supply_area/read', { ring: { inner, outer }, skip, limit, select: { id: 1, name: 1, location: 1, stores: 1 } })
                    if (!Array.isArray(page) || page.length === 0) break
                    setAreas(prev => mergeById(prev, page))
                    if (page.length < limit) break
                    skip += limit
                    await new Promise(r => setTimeout(r, 60))
                }
                if (boundsCoversOuter(outer)) break
                // expand for next ring; keep constant pad
                const nextOuter = padBounds(outer, 0.3)
                // if outer didn't grow (already at Israel bounds) stop
                if (nextOuter.north === outer.north && nextOuter.south === outer.south && nextOuter.east === outer.east && nextOuter.west === outer.west) break
                inner = outer
                outer = nextOuter
                await new Promise(r => setTimeout(r, 40))
                // even if ring was empty, continue expanding until Israel covered (sparse areas)
            }
        } finally {
            setBgLoading(false)
            bgRunningRef.current = false
        }
    }, [])

    const handleViewportChange = useCallback((bounds) => {
        fetchViewport(bounds)
    }, [fetchViewport])

    // Kick off background streaming once first viewport has delivered data
    const hasStartedBgRef = useRef(false)
    useEffect(() => {
        if (!hasStartedBgRef.current && areas.length > 0 && !loading) {
            hasStartedBgRef.current = true
            startBackgroundFetch()
        }
    }, [areas.length, loading, startBackgroundFetch])

    const [selectedId, setSelectedId] = useState(null)
    const [unionIds, setUnionIds] = useState([]) // ctrl+click multi-select (selection order, first survives)
    const [merging, setMerging] = useState(false)
    const [areaDraft, setAreaDraft] = useState(null) // { id, name, storeIds }
    const [geometryEditingId, setGeometryEditingId] = useState(null)
    const [cuttingId, setCuttingId] = useState(null)
    const [cuttingSaving, setCuttingSaving] = useState(false)
    const [savingArea, setSavingArea] = useState(false)
    const [focusStoreId, setFocusStoreId] = useState(null)
    // Most recent map-focus intent — decides whether a store click or an
    // address search wins the FlyTo when both points exist.
    const [lastFocus, setLastFocus] = useState(null) // 'store' | 'test' | 'group'
    const [creating, setCreating] = useState(false)
    // City borders overlay visibility — shared by the header switch and the map basemap picker
    const [showCityBorders, setShowCityBorders] = useState(() => localStorage.getItem(CITY_BORDERS_KEY) !== '0')
    function toggleCityBorders(next) {
        const v = typeof next === 'boolean' ? next : !showCityBorders
        localStorage.setItem(CITY_BORDERS_KEY, v ? '1' : '0')
        setShowCityBorders(v)
    }
    const [expandedStores, setExpandedStores] = useState([])
    const [groupDraft, setGroupDraft] = useState(null) // { id?, name, storeId, areaIds }
    const [editingGroupName, setEditingGroupName] = useState(false)
    const [savingGroup, setSavingGroup] = useState(false)
    const [error, setError] = useState(null)
    const [testQuery, setTestQuery] = useState('')
    const [searchOpen, setSearchOpen] = useState(false)
    const searchInputRef = useRef(null)
    const [testPoint, setTestPoint] = useState(null)
    const [testLabel, setTestLabel] = useState('')
    const [testResult, setTestResult] = useState(null)
    const [testing, setTesting] = useState(false)

    // ——— Fullscreen mode ———
    const containerRef = useRef(null)
    const [isFullscreen, setIsFullscreen] = useState(false)
    const [sidebarOpen, setSidebarOpen] = useState(true) // collapsible in every mode; fullscreen starts closed
    const selfExitFsRef = useRef(false)

    const mapMode = useMemo(() => {
        if (creating) return 'new'
        if (cuttingId) return 'split'
        if (geometryEditingId) return 'edit'
        if (groupDraft) return 'group'
        return null
    }, [creating, cuttingId, geometryEditingId, groupDraft])
    const modeMeta = mapMode ? MODE_META[mapMode] : null

    const enterFullscreen = useCallback(() => {
        setIsFullscreen(true)
        setSidebarOpen(false)
        setSearchOpen(false)
    }, [])

    // CSS state paints first; the native request runs after commit so it can't
    // race React's render (a same-tick requestFullscreen blanked the map).
    useEffect(() => {
        if (!isFullscreen) return
        document.body.classList.add('supply-map-fullscreen')
        const el = containerRef.current
        if (el && !document.fullscreenElement && el.requestFullscreen) {
            try {
                const p = el.requestFullscreen()
                if (p?.catch) p.catch(() => { /* CSS-only fallback */ })
            } catch (_) { /* CSS-only fallback */ }
        }
    }, [isFullscreen])

    const exitFullscreen = useCallback(() => {
        setIsFullscreen(false)
        setSidebarOpen(true)
        document.body.classList.remove('supply-map-fullscreen')
        if (document.fullscreenElement) {
            selfExitFsRef.current = true
            try {
                const p = document.exitFullscreen()
                if (p?.catch) p.catch(() => { /* noop */ })
            } catch (_) { /* noop */ }
        }
    }, [])

    // Single source of truth for leaving the active map mode (pill X, ESC, native fullscreen ESC)
    function exitMapMode() {
        if (geometryEditingId) { handleGeometryCancel(); return true }
        if (cuttingId) { handleCutCancel(); return true }
        if (creating) { handleCancelCreate(); return true }
        if (groupDraft) { handleCancelGroupDraft(); return true }
        if (unionIds.length) { setUnionIds([]); setError(null); return true }
        return false
    }

    // ESC unwinds map modes first, fullscreen last. A native browser-ESC (which
    // can't be preventDefaulted) is treated as one unwind step while keeping CSS fullscreen.
    // Capture phase: leaflet-draw also handles ESC and stops propagation, which used to
    // leave our mode state (and the pill) stuck — we run first and swallow the event.
    useEffect(() => {
        function unwindStep() {
            if (exitMapMode()) return true
            if (areaDraft) { handleCancelAreaPropsEdit(); return true }
            if (selectedId) { setSelectedId(null); setAreaDraft(null); return true }
            if (sidebarOpen) { setSidebarOpen(false); return true }
            if (searchOpen) { setSearchOpen(false); return true }
            return false
        }
        function onKey(e) {
            const t = e.target
            const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
            // Ctrl/Cmd+F opens + focuses address search — physical key position so
            // it works in any keyboard language. Runs before the plain-F
            // fullscreen branch and even while typing. Suppresses browser Find.
            if (e.code === 'KeyF' && (e.ctrlKey || e.metaKey) && !e.altKey) {
                e.preventDefault()
                e.stopPropagation()
                setSearchOpen(true)
                // Already-open case focuses immediately; closed→open case is
                // covered by the searchOpen focus effect below.
                searchInputRef.current?.focus()
                searchInputRef.current?.select?.()
                return
            }
            // F toggles fullscreen (YouTube-style) — physical key position so it
            // works in any keyboard language (Hebrew layout produces ש here).
            // Never while typing.
            if (e.code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) {
                if (isFullscreen) exitFullscreen()
                else enterFullscreen()
                e.stopPropagation()
                return
            }
            // Single-key map shortcuts, also by physical position. Never while typing.
            if (!e.ctrlKey && !e.metaKey && !e.altKey && !typing) {
                // A — in/out of add (new area) mode
                if (e.code === 'KeyA') {
                    if (creating) handleCancelCreate()
                    else handleNewArea()
                    e.stopPropagation()
                    return
                }
                // E — in/out of polygon edit mode (needs a selected area, clean state)
                if (e.code === 'KeyE') {
                    if (geometryEditingId) handleGeometryCancel()
                    else if (selectedArea && !creating && !cuttingId && !groupDraft && !areaDraft) handleStartGeometryEdit()
                    else return
                    e.stopPropagation()
                    return
                }
                // P — in/out of cut (split) mode (needs a selected area, clean state)
                if (e.code === 'KeyP') {
                    if (cuttingId) handleCutCancel()
                    else if (selectedArea && !creating && !geometryEditingId && !groupDraft && !areaDraft) handleStartCut(selectedId)
                    else return
                    e.stopPropagation()
                    return
                }
                // S — open/close the stores sidebar
                if (e.code === 'KeyS') {
                    setSidebarOpen(v => !v)
                    e.stopPropagation()
                    return
                }
            }
            if (e.key !== 'Escape') return
            // ESC in the search field closes search even while typing
            // (input is autofocused, so the generic typing guard below
            // would otherwise swallow it).
            if (typing) {
                if (searchOpen && t === searchInputRef.current) {
                    setSearchOpen(false)
                    e.stopPropagation()
                }
                return
            }
            if (unwindStep()) { e.stopPropagation(); return }
            if (document.body.classList.contains('supply-map-fullscreen')) exitFullscreen()
        }
        function onFsChange() {
            if (document.fullscreenElement) return
            if (selfExitFsRef.current) { selfExitFsRef.current = false; return }
            if (unwindStep()) return
            exitFullscreen()
        }
        window.addEventListener('keydown', onKey, true)
        document.addEventListener('fullscreenchange', onFsChange)
        return () => {
            window.removeEventListener('keydown', onKey, true)
            document.removeEventListener('fullscreenchange', onFsChange)
        }
    })
    // Focus search input on closed→open transitions (e.g. Ctrl+F when closed).
    useEffect(() => {
        if (searchOpen) searchInputRef.current?.focus()
    }, [searchOpen])
    // Never leave fullscreen behind (unmount while fullscreen)
    useEffect(() => () => {
        document.body.classList.remove('supply-map-fullscreen')
        if (document.fullscreenElement) {
            try {
                const p = document.exitFullscreen()
                if (p?.catch) p.catch(() => { /* noop */ })
            } catch (_) { /* noop */ }
        }
    }, [])
    const modeHintText = groupDraft
        ? `${TR('supply_group_hint')} "${groupDraft.name}"`
        : creating
            ? TR('supply_draw_hint')
            : cuttingId
                ? TR('supply_cut_hint')
                : unionIds.length
                    ? TR('supply_union_hint')
                    : null
    const servedStoreId = testResult?.area?.stores?.[0]?.storeId
    const servedByName = stores.find(s => s.id === servedStoreId)?.name || testResult?.area?.name || ''

    const selectedArea = areas.find(a => a.id === selectedId) || null

    useEffect(() => {
        if (groupDraft || creating) {
            setTestResult(null)
        }
    }, [groupDraft, creating])

    // While drafting, keep the saved member state of the edited group visible (purple)
    const viewGroup = groupDraft?.id ? groups.find(g => g.id === groupDraft.id) : null
    const groupAreaIds = useMemo(() => viewGroup?.areaIds || [], [viewGroup])
    const draftAreaIds = useMemo(() => groupDraft?.areaIds || [], [groupDraft])

    const focusStore = stores.find(s => s.id === focusStoreId) || null
    const servedAreaIds = useMemo(
        () => areas.filter(a => a.stores?.some(s => s.storeId === focusStoreId)).map(a => a.id),
        [areas, focusStoreId]
    )
    const focusStoreCoords = focusStore?.address?.location?.coordinates
    const focusPoint = useMemo(() => {
        if (focusStoreCoords) return { lat: focusStoreCoords[1], lng: focusStoreCoords[0] }
        return null
    }, [focusStoreCoords])

    // Pan to the selected area group (center of its polygons, or its store when empty) — only on group selection, not on every area toggle
    const focusGroupPoint = useMemo(() => {
        if (!groupDraft) return null
        const targetGroup = groupDraft.id ? groups.find(g => g.id === groupDraft.id) : null
        const ids = targetGroup?.areaIds?.length ? targetGroup.areaIds : groupDraft.areaIds
        if (ids?.length) {
            let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity, count = 0
            areas.forEach(a => {
                if (!ids.includes(a.id)) return
                const coords = a.location?.coordinates || []
                coords.forEach(ring => ring.forEach(([lng, lat]) => {
                    if (lat < minLat) minLat = lat
                    if (lat > maxLat) maxLat = lat
                    if (lng < minLng) minLng = lng
                    if (lng > maxLng) maxLng = lng
                    count++
                }))
            })
            if (count) return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 }
        }
        const storeId = targetGroup?.storeId || groupDraft.storeId
        const store = stores.find(s => s.id === storeId)
        const c = store?.address?.location?.coordinates
        if (Array.isArray(c) && c.length === 2) return { lat: c[1], lng: c[0] }
        return null
    }, [groupDraft?.id, groups, areas, stores])
    const groupDraftId = groupDraft?.id
    useEffect(() => {
        if (groupDraftId) setLastFocus('group')
    }, [groupDraftId])

    function handleNewArea() {
        if (groupDraft || geometryEditingId || cuttingId) return
        setError(null)
        setCreating(true)
        setSelectedId(null)
        setAreaDraft(null)
        setGeometryEditingId(null)
    }

    // From a city-border popup: duplicate the city's border as a new supply area immediately.
    // Server stores Polygon only — a MultiPolygon city (detached exclaves) keeps its largest part.
    function largestPolygonPart(geometry) {
        if (geometry?.type === 'Polygon' && geometry.coordinates?.length) return geometry
        if (geometry?.type === 'MultiPolygon' && geometry.coordinates?.length) {
            let best = null
            let bestArea = 0
            for (const poly of geometry.coordinates) {
                const ring = poly?.[0]
                if (!ring?.length) continue
                let a = 0
                for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
                a = Math.abs(a)
                if (a > bestArea) { bestArea = a; best = poly }
            }
            if (best) return { type: 'Polygon', coordinates: best }
        }
        return null
    }
    function handleCityCreateArea(cityName, geometry) {
        if (groupDraft || geometryEditingId || creating || cuttingId) return
        const location = largestPolygonPart(geometry)
        if (!location) return
        setError(null)
        setSelectedId(null)
        setAreaDraft(null)
        apiReq('supply_area/create', { location, ...(cityName ? { name: cityName } : {}) })
            .then(created => {
                if (created?.id) patchArea(created)
                if (created?.id) setSelectedId(created.id)
            })
            .catch(err => setError(toMessage(err)))
    }

    // ——— Area popup (Option H: view → edit via bubble, geometry via footer) ———
    function handleSelectArea(id) {
        if (groupDraft) return
        if (geometryEditingId) return
        if (cuttingId) return
        if (merging) return
        setError(null)
        if (unionIds.length) setUnionIds([])
        setSelectedId(id)
        setAreaDraft(null)
    }

    // ——— Union (ctrl+click multi-select → merge into first selected) ———
    function handleUnionToggle(id) {
        if (!id || groupDraft || creating || geometryEditingId || cuttingId || merging) return
        if (unionIds.includes(id)) {
            setError(null)
            const rest = unionIds.filter(x => x !== id)
            // A lone remainder is just a selection again (popup reopens)
            if (rest.length === 1) {
                setUnionIds([])
                setSelectedId(rest[0])
                setAreaDraft(null)
                return
            }
            setUnionIds(rest)
            return
        }
        setError(null)
        if (unionIds.length === 0) {
            // Fold an existing single selection in as the survivor (first)
            const seed = selectedId && selectedId !== id
                ? [areas.find(a => a.id === selectedId)].filter(Boolean)
                : []
            if (seed.length) {
                const candidate = areas.find(a => a.id === id)
                if (!candidate || !areasAdjacent(seed[0], candidate)) {
                    setError('supply_union_not_adjacent')
                    return
                }
                setSelectedId(null)
                setAreaDraft(null)
                setUnionIds([selectedId, id])
                return
            }
            setSelectedId(null)
            setAreaDraft(null)
            setUnionIds([id])
            return
        }
        const candidate = areas.find(a => a.id === id)
        const touches = unionIds.some(pid => {
            const other = areas.find(a => a.id === pid)
            return candidate && other && areasAdjacent(candidate, other)
        })
        if (!touches) {
            setError('supply_union_not_adjacent')
            return
        }
        setUnionIds([...unionIds, id])
    }

    function handleUnionCommit() {
        if (unionIds.length < 2 || merging) return
        const picked = unionIds.map(id => areas.find(a => a.id === id))
        if (picked.some(a => !a)) {
            setError('supply_union_not_adjacent')
            return
        }
        const storeKey = a => [...(a.stores || []).map(s => s.storeId)].sort().join(',')
        const sameStores = picked.every(a => storeKey(a) === storeKey(picked[0]))
        setMerging(true)
        setError(null)
        apiReq('supply_area/merge', { ids: unionIds })
            .then(({ updated, deletedIds }) => {
                if (updated?.id) patchArea(updated)
                if (Array.isArray(deletedIds) && deletedIds.length)
                    setAreas(prev => prev.filter(a => !deletedIds.includes(a.id)))
                const survivorId = updated?.id || unionIds[0]
                const survivor = updated || picked[0]
                setUnionIds([])
                setSelectedId(survivorId)
                // Different store sets → open the store bubble for reconciliation;
                // survivor keeps the first-selected area's stores until saved
                if (!sameStores && survivor) {
                    setAreaDraft({ id: survivorId, name: survivor.name || '', storeIds: (survivor.stores || []).map(s => s.storeId) })
                } else {
                    setAreaDraft(null)
                }
            })
            .catch(err => setError(toMessage(err)))
            .finally(() => setMerging(false))
    }
    function handleStartAreaPropsEdit() {
        if (!selectedArea) return
        setError(null)
        setAreaDraft({ id: selectedArea.id, name: selectedArea.name || '', storeIds: (selectedArea.stores || []).map(s => s.storeId) })
    }
    function handleCancelAreaPropsEdit() {
        setAreaDraft(null)
        setError(null)
    }
    function handleSaveAreaProps(draftOverride) {
        const draft = draftOverride || areaDraft
        if (!draft) return
        const { id, name, storeIds } = draft
        setSavingArea(true)
        setError(null)
        apiReq('supply_area/update', { id, name: (name || '').trim(), stores: storeIds })
            .then(updated => {
                setAreas(prev => prev.map(a => a.id === id ? { ...a, name: updated.name, stores: updated.stores } : a))
                setAreaDraft(null)
            })
            .catch(err => setError(toMessage(err)))
            .finally(() => setSavingArea(false))
    }
    function handleStartGeometryEdit() {
        if (!selectedArea || cuttingId) return
        setError(null)
        setAreaDraft(null)
        setGeometryEditingId(selectedArea.id)
    }
    // ——— Cut (split area by user-drawn line) ———
    function handleStartCut(id) {
        if (!id || groupDraft || creating || geometryEditingId) return
        setError(null)
        setAreaDraft(null)
        setCuttingId(id)
    }
    function handleCutCancel() {
        if (cuttingSaving) return
        setCuttingId(null)
    }
    function handleCutCommit(id, line) {
        setCuttingSaving(true)
        setError(null)
        apiReq('supply_area/split', { id, line })
            .then(({ original, created }) => {
                if (original?.id) patchArea(original)
                if (created?.id) {
                    setAreas(prev => [...prev, created])
                    setSelectedId(created.id)
                }
                setAreaDraft(null)
                setCuttingId(null)
            })
            .catch(err => {
                setError(toMessage(err))
                setCuttingId(null)
            })
            .finally(() => setCuttingSaving(false))
    }
    function handleGeometryCommit(id, geometry) {
        setGeometryEditingId(null)
        setError(null)
        apiReq('supply_area/update', { id, location: geometry })
            .then(updated => { if (updated?.id) patchArea(updated) })
            .catch(err => setError(toMessage(err)))
    }
    function handleGeometryCancel() { setGeometryEditingId(null) }
    function handleDeleteAreaPopup() {
        if (!selectedArea) return
        const deletedId = selectedArea.id
        setError(null)
        apiReq('supply_area/delete', { id: deletedId })
            .then(() => { removeArea(deletedId); setSelectedId(null); setAreaDraft(null); setGeometryEditingId(null) })
            .catch(err => setError(toMessage(err)))
    }

    // Clicking a saved group expands it inline into edit mode with its areas highlighted
    function startGroupEdit(group) {
        if (groupDraft?.id === group.id) return
        if (geometryEditingId || cuttingId) return
        setError(null)
        setCreating(false)
        setSelectedId(null)
        setAreaDraft(null)
        setGeometryEditingId(null)
        setGroupDraft({ id: group.id, name: group.name, storeId: group.storeId, areaIds: [...(group.areaIds || [])] })
        setEditingGroupName(false)
        setExpandedStores(prev => prev.includes(group.storeId) ? prev : [...prev, group.storeId])
    }

    // Dirty: name changed OR area membership changed (set equality). Save disabled until dirty.
    const groupDirty = useMemo(() => {
        if (!groupDraft) return false
        // New group (no id yet) — considered dirty when it has a valid name; enables Save for creation
        if (!groupDraft.id) return !!groupDraft.name?.trim() && !!groupDraft.storeId
        const orig = groups.find(g => g.id === groupDraft.id)
        if (!orig) return true
        const nameChanged = (orig.name || '').trim() !== (groupDraft.name || '').trim()
        const a = [...(orig.areaIds || [])].sort()
        const b = [...(groupDraft.areaIds || [])].sort()
        const areasChanged = a.length !== b.length || a.some((v, i) => v !== b[i])
        return nameChanged || areasChanged
    }, [groupDraft, groups])

    function toggleStoreExpand(storeId) {
        setExpandedStores(prev =>
            prev.includes(storeId) ? prev.filter(id => id !== storeId) : [...prev, storeId])
    }

    function handleToggleGroupArea(areaId) {
        if (!groupDraft) return
        if (!groupDraft.id && error) setError(null)
        const has = groupDraft.areaIds.includes(areaId)
        setGroupDraft({
            ...groupDraft,
            areaIds: has ? groupDraft.areaIds.filter(id => id !== areaId) : [...groupDraft.areaIds, areaId]
        })
    }

    async function handleSaveGroup() {
        if (!groupDraft) return
        const { id, name, storeId, areaIds } = groupDraft
        if (!name?.trim() || !storeId) {
            setError('supply_group_details_required')
            return
        }
        if (id && !groupDirty) return
        setSavingGroup(true)
        setError(null)
        try {
            // Auto-assign store to member areas if not already assigned — patch single ids
            const areasNeedingStore = areas.filter(a => areaIds.includes(a.id) && !a.stores?.some(s => s.storeId === storeId))
            if (areasNeedingStore.length) {
                const updatedAreas = await Promise.all(areasNeedingStore.map(area => {
                    const storeIds = [...new Set([...(area.stores || []).map(s => s.storeId), storeId])]
                    return apiReq('supply_area/update', { id: area.id, stores: storeIds })
                }))
                updatedAreas.forEach(u => { if (u?.id) patchArea(u) })
            }
            await apiReq(id ? 'area_group/update' : 'area_group/create', { ...(id ? { id } : {}), name: name.trim(), storeId, areaIds })
            refetchGroups()
            setGroupDraft(null)
            setEditingGroupName(false)
        } catch (err) {
            setError(toMessage(err))
        } finally {
            setSavingGroup(false)
        }
    }

    function handleCreateGroup() {
        if (!groupDraft || groupDraft.id) return
        const { name, areaIds } = groupDraft
        const missingName = !name?.trim()
        const missingAreas = !areaIds?.length
        if (missingName || missingAreas) {
            const parts = []
            if (missingName) parts.push(TR('supply_group_name_required'))
            if (missingAreas) parts.push(TR('supply_no_area_groups'))
            setError(parts.join(' — '))
            return
        }
        handleSaveGroup()
    }

    function handleNewGroupInline(storeId) {
        if (creating || geometryEditingId || cuttingId) return
        if (groupDraft && !groupDraft.id && groupDraft.storeId === storeId) return
        setError(null)
        setCreating(false)
        setSelectedId(null)
        setAreaDraft(null)
        setGeometryEditingId(null)
        setGroupDraft({ id: null, name: '', storeId, areaIds: [] })
        setEditingGroupName(true)
        setExpandedStores(prev => prev.includes(storeId) ? prev : [...prev, storeId])
    }

    function handleCancelGroupDraft() {
        setGroupDraft(null)
        setEditingGroupName(false)
        setError(null)
    }

    function handleDeleteGroup() {
        const groupId = groupDraft?.id
        if (!groupId) return
        setError(null)
        apiReq('area_group/delete', { id: groupId })
            .then(() => {
                refetchGroups()
                setGroupDraft(null)
                setEditingGroupName(false)
            })
            .catch(err => setError(toMessage(err)))
    }

    function handleMapBackgroundClick() {
        if (groupDraft || creating || geometryEditingId || cuttingId) return
        if (unionIds.length) { setUnionIds([]); setError(null); return }
        setSelectedId(null)
        setAreaDraft(null)
    }

    function handleCancelCreate() {
        setCreating(false)
    }

    function handleMapCreated(geometry) {
        setCreating(false)
        setError(null)
        apiReq('supply_area/create', { location: geometry })
            .then(created => {
                if (created?.id) patchArea(created)
                if (created?.id) setSelectedId(created.id)
            })
            .catch(err => setError(toMessage(err)))
    }

    async function handleTest() {
        if (!testQuery?.trim()) {
            setTestResult({ error: 'supply_test_missing_query' })
            return
        }
        setTesting(true)
        setError(null)
        setTestResult(null)
        try {
            const geocoded = await apiReq('geocode/lookup', { q: testQuery.trim() })
            const coords = geocoded?.location?.coordinates
            if (!Array.isArray(coords) || coords.length < 2) {
                setTestResult({ error: TR('supply_no_service') })
                return
            }
            const [lng, lat] = coords
            const res = await apiReq('supply_area/lookup', { lng, lat })
            setTestResult(res)
            setTestPoint({ lat, lng })
            setLastFocus('test')
            setTestLabel(res.hasService ? `${TR('supply_in_area')}: ${res.area?.name}` : TR('supply_no_service'))
        } catch (err) {
            setTestResult({ error: toMessage(err) })
        } finally {
            setTesting(false)
        }
    }
    return (
        <Flex tag={Card} ref={containerRef} col className={`${styles.container} ${isFullscreen ? styles.containerFs : ''}`}>
            <Flex className={styles.body}>
                <div className={`${styles.sidebar} ${isFullscreen ? styles.sidebarDrawer : ''} ${!sidebarOpen ? (isFullscreen ? styles.sidebarDrawerClosed : styles.sidebarClosed) : ''}`}>

                    <div className={styles.storeListPane}>
                        <h4 className={styles.storeListTitle}>
                            <Text>supply_stores_groups</Text>
                            <button
                                type="button"
                                className={styles.drawerClose}
                                onClick={() => setSidebarOpen(false)}
                                title={TR('cancel')}
                            >
                                <Icon name="x" />
                            </button>
                        </h4>
                        {!stores.length && <div className={styles.empty}><Text>supply_no_stores</Text></div>}
                        {stores.map(store => {
                            const storeGroups = groups.filter(g => g.storeId === store.id)
                            const expanded = expandedStores.includes(store.id)
                            return (
                                <div key={store.id} className={styles.storeBranch}>
                                    <div
                                        className={`${styles.storeListItem} ${store.id === focusStoreId ? styles.active : ''}`}
                                        onClick={() => {
                                            setFocusStoreId(prev => prev != store.id ? store.id : null)
                                            setLastFocus('store')
                                        }}
                                    >
                                        <span className={styles.storeListName}>{store.name}</span>
                                        <span className={styles.storeListAddress}>{[store.address?.city, store.address?.street, store.address?.building].filter(Boolean).join(', ')}</span>
                                        <button
                                            type="button"
                                            className={`${styles.expander} ${expanded ? styles.expanderOpen : ''}`}
                                            title={TR(expanded ? 'supply_hide_groups' : 'supply_show_groups')}
                                            onClick={(e) => { e.stopPropagation(); toggleStoreExpand(store.id) }}
                                        >
                                            <Icon name="down" />
                                        </button>
                                    </div>
                                    {expanded && (
                                        <div className={styles.groupChildren}>
                                            {storeGroups.map(group => {
                                                const isEditing = groupDraft?.id === group.id
                                                return (
                                                    <div key={group.id} className={`${styles.groupCard} ${isEditing ? styles.groupCardExpanded : ''}`}>
                                                        <div
                                                            className={`${styles.groupCardHeader} ${isEditing ? styles.groupCardHeaderExpanded : ''}`}
                                                            onClick={() => {
                                                                if (isEditing) {
                                                                    handleCancelGroupDraft()
                                                                } else {
                                                                    startGroupEdit(group)
                                                                }
                                                            }}
                                                            title={isEditing ? TR('cancel') : undefined}
                                                        >
                                                            <div className={styles.groupHeaderStart}>
                                                                <span className={styles.groupHeaderIcon}>
                                                                    {isEditing ? (
                                                                        <Icon name="sortUp" className={styles.groupArrowIcon} />
                                                                    ) : (
                                                                        <span className={styles.groupDot} />
                                                                    )}
                                                                </span>
                                                                {!isEditing && (
                                                                    <span className={styles.storeListName}>{group.name}</span>
                                                                )}
                                                            </div>
                                                            {!isEditing && (
                                                                <span className={styles.groupCount}>{(group.areaIds || []).length}</span>
                                                            )}
                                                        </div>
                                                        <div className={styles.groupCardContentWrap}>
                                                            <div className={styles.groupCardContentInner}>
                                                                <div className={styles.groupEditPane} onClick={e => e.stopPropagation()}>
                                                                    {editingGroupName && isEditing ? (
                                                                        <input
                                                                            className={styles.groupNameInput}
                                                                            value={groupDraft?.name ?? group.name}
                                                                            onChange={e => setGroupDraft(prev => ({ ...prev, name: e.target.value }))}
                                                                            onBlur={() => setEditingGroupName(false)}
                                                                            onKeyDown={e => { if (e.key === 'Enter') setEditingGroupName(false) }}
                                                                            placeholder={TR('name')}
                                                                            autoFocus
                                                                        />
                                                                    ) : (
                                                                        <div
                                                                            className={styles.groupNameRow}
                                                                            onClick={() => { if (isEditing) setEditingGroupName(true) }}
                                                                        >
                                                                            <span className={styles.groupNameText}>
                                                                                {(isEditing ? groupDraft?.name : group.name) || TR('name')}
                                                                            </span>
                                                                            <span className={styles.groupNameEditIcon} title={TR('edit')}>
                                                                                <Icon name="edit" />
                                                                            </span>
                                                                        </div>
                                                                    )}
                                                                    <div className={styles.editorMeta}>
                                                                        <Text size="none">{`${(isEditing ? groupDraft?.areaIds : group.areaIds || []).length} ${TR('supply_areas_selected')}`}</Text>
                                                                    </div>
                                                                    <div className={styles.groupEditHint}>
                                                                        <Text size="none">supply_group_hint</Text>
                                                                    </div>
                                                                    <Flex gap={8} justifyContent="space-between" alignItems="center">
                                                                        <ConfirmButton
                                                                            q={`${TR('supply_delete_group_confirm')} "${groups.find(g => g.id === groupDraft?.id)?.name}"?`}
                                                                            onOk={handleDeleteGroup}
                                                                            size="s"
                                                                            mode="outline"
                                                                            icon="trash"
                                                                            tooltip="supply_delete_group"
                                                                            className={styles.deleteButton}
                                                                        />
                                                                        <Flex gap={8}>
                                                                            <Button size="s" mode="outline" onClick={handleCancelGroupDraft}>cancel</Button>
                                                                            <Button
                                                                                size="s"
                                                                                icon="check"
                                                                                loading={savingGroup}
                                                                                disabled={!groupDirty || !groupDraft?.name?.trim()}
                                                                                onClick={handleSaveGroup}
                                                                            >
                                                                                save
                                                                            </Button>
                                                                        </Flex>
                                                                    </Flex>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                            {/* New group draft (id === null) — shown inline under its store */}
                                            {groupDraft && !groupDraft.id && groupDraft.storeId === store.id && (
                                                <div className={`${styles.groupCard} ${styles.groupCardExpanded}`}>
                                                    <div
                                                        className={`${styles.groupCardHeader} ${styles.groupCardHeaderExpanded}`}
                                                        onClick={handleCancelGroupDraft}
                                                        title={TR('cancel')}
                                                    >
                                                        <div className={styles.groupHeaderStart}>
                                                            <span className={styles.groupHeaderIcon}>
                                                                <Icon name="sortUp" className={styles.groupArrowIcon} />
                                                            </span>
                                                            <span className={styles.storeListName}><Text size="none">supply_new_area_group</Text></span>
                                                        </div>
                                                    </div>
                                                    <div className={styles.groupCardContentWrap}>
                                                        <div className={styles.groupCardContentInner}>
                                                            <div className={styles.groupEditPane} onClick={e => e.stopPropagation()}>
                                                                <input
                                                                    className={styles.groupNameInput}
                                                                    value={groupDraft.name}
                                                                    onChange={e => { if (error) setError(null); setGroupDraft(prev => ({ ...prev, name: e.target.value })) }}
                                                                    placeholder={TR('name')}
                                                                    autoFocus
                                                                />
                                                                <div className={styles.editorMeta}>
                                                                    <Text size="none">{`${groupDraft.areaIds.length} ${TR('supply_areas_selected')}`}</Text>
                                                                </div>
                                                                <div className={styles.groupEditHint}>
                                                                    <Text size="none">supply_group_hint</Text>
                                                                </div>
                                                                <Flex gap={8} justifyContent="end">
                                                                    <Button size="s" mode="outline" onClick={handleCancelGroupDraft}>cancel</Button>
                                                                    <Button
                                                                        size="s"
                                                                        icon="check"
                                                                        loading={savingGroup}
                                                                        onClick={handleCreateGroup}
                                                                    >
                                                                        create
                                                                    </Button>
                                                                </Flex>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                            <div
                                                className={`${styles.storeListItem} ${styles.addGroupRow}`}
                                                onClick={() => handleNewGroupInline(store.id)}
                                            >
                                                <Icon name="add" />
                                                <span className={styles.addGroupLabel}><Text size="none">supply_new_area_group</Text></span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>

                </div>

                <div className={styles.mapPane}>
                    {loading && !areas.length ? (
                        <div style={{ position: 'absolute', inset: 0, zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.7)', color: '#64748b' }}>Loading areas…</div>
                    ) : null}
                    <div className={styles.cornerStack}>
                        {!searchOpen ? (
                            <button
                                type="button"
                                className={styles.cornerBtn}
                                title={`${TR('supply_search_address')} (Ctrl+F)`}
                                onClick={() => setSearchOpen(true)}
                            >
                                <Icon name="search" />
                            </button>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    className={styles.cornerBtn}
                                    title={TR('cancel')}
                                    onClick={() => setSearchOpen(false)}
                                >
                                    <Icon name="x" />
                                </button>
                                <button
                                    type="button"
                                    className={styles.searchGo}
                                    title={TR('supply_search_address')}
                                    disabled={testing}
                                    onClick={handleTest}
                                >
                                    <Icon name={testing ? 'load' : 'search'} />
                                </button>
                                <input
                                    ref={searchInputRef}
                                    className={styles.searchField}
                                    value={testQuery}
                                    onChange={e => setTestQuery(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') handleTest() }}
                                    placeholder={TR('supply_search_address_placeholder')}
                                    autoFocus
                                />
                            </>
                        )}
                    </div>
                    {searchOpen && testResult && (
                        <div className={styles.searchResult}>
                            <div className={testResult.error ? styles.testResultError : styles.testResult}>
                                <Text size="none">
                                    {testResult.error
                                        ? testResult.error
                                        : testResult.hasService
                                            ? TR('supply_served_by_store', { name: servedByName })
                                            : TR('supply_no_service')}
                                </Text>
                            </div>
                        </div>
                    )}
                    {!modeMeta ? (
                        unionIds.length ? (
                            <div className={styles.toolbarWrap}>
                                <div className={styles.toolbarPill}>
                                    <span
                                        className={`${styles.pillMain} ${styles.pillStatic} ${styles.pillMode_union}`}
                                        title={TR('supply_union')}
                                    >
                                        <Icon name="combine" />
                                        <span className={styles.pillLabel}>{unionIds.length} <Text size="none">supply_areas_selected</Text></span>
                                    </span>
                                    <Button
                                        size="s"
                                        icon="check"
                                        loading={merging}
                                        disabled={unionIds.length < 2}
                                        onClick={handleUnionCommit}
                                    >
                                        supply_union
                                    </Button>
                                    <button
                                        type="button"
                                        className={styles.pillX}
                                        title={TR('cancel')}
                                        disabled={merging}
                                        onClick={() => { setUnionIds([]); setError(null) }}
                                    >
                                        <Icon name="x" />
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <button
                                type="button"
                                className={styles.centerPlus}
                                title={`${TR('new area')} (A)`}
                                onClick={handleNewArea}
                            >
                                <Icon name="add" />
                            </button>
                        )
                    ) : (
                        <div className={styles.toolbarWrap}>
                            <div className={styles.toolbarPill}>
                                <span
                                    className={`${styles.pillMain} ${styles.pillStatic} ${styles[`pillMode_${mapMode}`] || ''}`}
                                    title={TR(modeMeta.label)}
                                >
                                    <Icon name={modeMeta.icon} />
                                    <span className={styles.pillLabel}><Text size="none">{modeMeta.label}</Text></span>
                                </span>
                                <button
                                    type="button"
                                    className={styles.pillX}
                                    title={TR('cancel')}
                                    disabled={mapMode === 'split' && cuttingSaving}
                                    onClick={exitMapMode}
                                >
                                    <Icon name="x" />
                                </button>
                            </div>
                        </div>
                    )}
                    {(modeHintText || error) && (
                        <div className={styles.hintBar}>
                            {error
                                ? <div className={styles.errorBanner}><Text size="none">{error}</Text></div>
                                : <div className={`${styles.hint} ${groupDraft ? styles.groupHint : ''}`}><Text size="none">{modeHintText}</Text></div>}
                        </div>
                    )}
                    {!sidebarOpen && (
                        <button
                            type="button"
                            className={styles.storeFab}
                            title={`${TR('supply_stores_groups')} (S)`}
                            onClick={() => setSidebarOpen(true)}
                        >
                            <Icon name="stores" />
                        </button>
                    )}
                    {isFullscreen && sidebarOpen && (
                        <div
                            className={styles.drawerBackdrop}
                            onClick={() => setSidebarOpen(false)}
                        />
                    )}
                    <SupplyAreaMap
                        areas={areas}
                        stores={stores}
                        activeStoreIds={selectedArea?.stores?.map(s => s.storeId) || []}
                        servedAreaIds={servedAreaIds}
                        groupAreaIds={groupAreaIds}
                        draftAreaIds={draftAreaIds}
                        toggleMode={!!groupDraft}
                        onToggleArea={handleToggleGroupArea}
                        focusPoint={focusPoint}
                        focusGroupPoint={focusGroupPoint}
                        lastFocus={lastFocus}
                        selectedId={selectedId}
                        unionIds={unionIds}
                        onUnionToggle={handleUnionToggle}
                        areaDraft={areaDraft}
                        setAreaDraft={setAreaDraft}
                        geometryEditingId={geometryEditingId}
                        cuttingId={cuttingId}
                        drawing={creating}
                        testPoint={testPoint}
                        testLabel={testLabel}
                        savingArea={savingArea}
                        onSelect={handleSelectArea}
                        onBackgroundClick={handleMapBackgroundClick}
                        onCreated={handleMapCreated}
                        onEdited={handleGeometryCommit}
                        onGeometryCancel={handleGeometryCancel}
                        onStartAreaPropsEdit={handleStartAreaPropsEdit}
                        onSaveAreaProps={handleSaveAreaProps}
                        onCancelAreaPropsEdit={handleCancelAreaPropsEdit}
                        onDeleteArea={handleDeleteAreaPopup}
                        onStartGeometryEdit={handleStartGeometryEdit}
                        onStartCut={handleStartCut}
                        onCutCommit={handleCutCommit}
                        onViewportChange={handleViewportChange}
                        onCreateArea={handleCityCreateArea}
                        cityBorders={showCityBorders}
                        onToggleCityBorders={toggleCityBorders}
                        isFullscreen={isFullscreen}
                        onToggleFullscreen={isFullscreen ? exitFullscreen : enterFullscreen}
                        sidebarOpen={sidebarOpen}
                    />
                    {bgLoading && areas.length > 0 ? (
                        <div style={{ position: 'absolute', bottom: 8, right: 60, background: 'rgba(255,255,255,0.9)', padding: '4px 8px', borderRadius: 6, fontSize: 11, color: '#64748b' }}>Loading all areas… {areas.length}</div>
                    ) : null}
                </div>
            </Flex>
        </Flex>
    )
}