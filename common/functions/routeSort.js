import distanceMeters from './distance.js'

// Hardcoded routing constants (simplest form — no store settings yet).
export const ROUTE_CONSTANTS = {
    AVG_KMH: 30,        // urban Israel average speed for ETA estimates
    SERVICE_MIN: 4,     // minutes spent per drop-off
    LATE_WEIGHT: 3,     // penalty multiplier per minute late (balanced mode)
    URGENT_SLACK_MIN: 20, // below this slack, urgency boost kicks in (balanced)
    URGENT_WEIGHT: 2,   // urgency boost multiplier (balanced)
    TIE_MIN: 15,        // deadlines within this window are one urgency bucket (deadline-first)
}

export function travelMin(a, b) {
    const d = distanceMeters(a, b)
    if (!Number.isFinite(d)) return Infinity
    return d / ((ROUTE_CONSTANTS.AVG_KMH * 1000) / 60)
}

function toMs(v) {
    if (v == null) return null
    const ms = v instanceof Date ? v.getTime() : new Date(v).getTime()
    return Number.isFinite(ms) ? ms : null
}

function validCoords(c) {
    return Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])
}

// Accept flexible order shapes: { orderId|id, coords | address.location.coordinates,
// end | endMs | window.endTimestamp }. Returns normalized stops.
export function normalizeStops(orders = []) {
    return (orders || []).map(o => {
        const orderId = o?.orderId ?? o?.id ?? null
        const coords = validCoords(o?.coords)
            ? o.coords
            : validCoords(o?.address?.location?.coordinates)
                ? o.address.location.coordinates
                : null
        const end = toMs(o?.end ?? o?.endMs ?? o?.window?.endTimestamp ?? null)
        return { orderId, coords, end, ref: o }
    }).filter(s => s.orderId != null)
}

// WAITING list: deadline strictly wins. Within TIE_MIN buckets, nearest-neighbor
// from origin to avoid zigzag without violating urgency.
export function deadlineFirstSort(orders = [], origin = null) {
    const stops = normalizeStops(orders)
    const withData = stops.filter(s => s.coords && s.end != null)
    const tail = stops.filter(s => !(s.coords && s.end != null))
    // deadline order first
    withData.sort((a, b) => a.end - b.end)

    // group into urgency buckets (ends within TIE_MIN of bucket start)
    const buckets = []
    const tieMs = ROUTE_CONSTANTS.TIE_MIN * 60 * 1000
    for (const s of withData) {
        const last = buckets[buckets.length - 1]
        if (!last || (s.end - last[0].end) > tieMs) buckets.push([s])
        else last.push(s)
    }

    // within each bucket, greedy nearest from running position
    const ordered = []
    let cur = validCoords(origin) ? origin : null
    for (const bucket of buckets) {
        if (!cur) {
            ordered.push(...bucket)
            cur = bucket[bucket.length - 1]?.coords || cur
            continue
        }
        const pool = [...bucket]
        while (pool.length) {
            let bestIdx = 0, bestD = Infinity
            pool.forEach((p, i) => {
                const d = travelMin(cur, p.coords)
                if (d < bestD) { bestD = d; bestIdx = i }
            })
            const [best] = pool.splice(bestIdx, 1)
            ordered.push(best)
            cur = best.coords
        }
    }
    const all = [...ordered, ...tail]

    // attach seq + simple ETA chain for display
    let clock = Date.now()
    let pos = validCoords(origin) ? origin : null
    return all.map((s, i) => {
        let etaMs = null, slackMin = null, late = false
        if (s.coords && pos) {
            const t = travelMin(pos, s.coords)
            if (Number.isFinite(t)) {
                etaMs = clock + t * 60 * 1000
                if (s.end != null) {
                    slackMin = Math.round((s.end - etaMs) / 60000)
                    late = etaMs > s.end
                }
                clock = etaMs + ROUTE_CONSTANTS.SERVICE_MIN * 60 * 1000
                pos = s.coords
            }
        } else if (s.coords && !pos) {
            pos = s.coords
        }
        return { orderId: s.orderId, seq: i, etaMs, slackMin, late }
    })
}

// IN-SHIPMENT: balanced cost = travel + lateness penalty + urgency boost,
// so the driver is not zigzagging but urgent stops still surface.
export function balancedRoute(orders = [], origin = null, nowMs = Date.now()) {
    const stops = normalizeStops(orders)
    const pool = stops.filter(s => s.coords)
    const tail = stops.filter(s => !s.coords)
    // no origin → fall back to deadline order (matches old !current behavior, window-aware)
    if (!validCoords(origin)) {
        const byDeadline = [...stops].sort((a, b) => (a.end ?? Infinity) - (b.end ?? Infinity))
        return byDeadline.map((s, i) => ({ orderId: s.orderId, seq: i, etaMs: null, slackMin: null, late: false }))
    }

    const { SERVICE_MIN, LATE_WEIGHT, URGENT_SLACK_MIN, URGENT_WEIGHT } = ROUTE_CONSTANTS
    const remaining = [...pool]
    const result = []
    let cur = origin
    let clock = nowMs
    let seq = 0

    while (remaining.length) {
        let bestIdx = -1, bestCost = Infinity, bestEta = 0, bestSlack = null, bestLate = false
        remaining.forEach((s, i) => {
            const t = travelMin(cur, s.coords)
            if (!Number.isFinite(t)) return
            const eta = clock + t * 60 * 1000
            let cost = t
            let slack = null, late = false
            if (s.end != null) {
                const slackMin = (s.end - eta) / 60000
                slack = slackMin
                if (slackMin < 0) cost += (-slackMin) * LATE_WEIGHT
                else if (slackMin < URGENT_SLACK_MIN) cost += (URGENT_SLACK_MIN - slackMin) * URGENT_WEIGHT
                late = eta > s.end
            }
            if (cost < bestCost) {
                bestCost = cost; bestIdx = i; bestEta = eta; bestSlack = slack; bestLate = late
            }
        })
        if (bestIdx === -1) break
        const [best] = remaining.splice(bestIdx, 1)
        result.push({
            orderId: best.orderId,
            seq: seq++,
            etaMs: bestEta,
            slackMin: bestSlack == null ? null : Math.round(bestSlack),
            late: bestLate,
        })
        clock = bestEta + SERVICE_MIN * 60 * 1000
        cur = best.coords
    }
    tail.forEach(s => result.push({ orderId: s.orderId, seq: seq++, etaMs: null, slackMin: null, late: false }))
    return result
}
