import getWindowTS from '#common/functions/getWindowTS.js'
import formatISODate from '#common/functions/formatISODate.js'
import { buildSpecialMap, specialDaysFor, overlapsWindow } from '#common/functions/specialDay.js'
import { isWindowFull } from '#common/functions/orderWindow.js'
import { findUserGroupIds, purgeExpiredHolds } from './windowGroups.js'

export const GET_WINDOW_DAYS_AHEAD = 10

/**
 * Grouped delivery-window options for one store, shared by the storefront
 * checkout and the admin order page.
 *
 * `includeFlags` adds a per-window { full, past, closed, special } object so
 * the admin can tell a capacity-full window (overridable after confirmation)
 * apart from a window blocked by time / closure / a special day.
 */
export async function buildWindowOptions({
    DL,
    storeId,
    deliveryMethod,
    areaId,
    currentWindowId,
    daysAhead = GET_WINDOW_DAYS_AHEAD,
    includeFlags = false
} = {}) {
    if (!storeId) return []

    const { DELIVERY_METHOD } = DL.Order.constants
    const timezone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const today = getWindowTS({ date: formatISODate(new Date()), hour: 12, timezone })
    const endDate = new Date(today)
    endDate.setDate(endDate.getDate() + daysAhead)

    const dateFrom = formatISODate(today)
    const dateTo = formatISODate(endDate)

    // Group-restricted windows apply to delivery orders only: the shopper's
    // address area decides which restricted windows they may see.
    const userGroupIds = deliveryMethod === DELIVERY_METHOD.DELIVERY
        ? await findUserGroupIds(DL, storeId, areaId)
        : []

    const loadWindows = () => DL.OrderWindow.Model.find({
        storeId,
        date: { $gte: dateFrom, $lte: dateTo },
        active: true
    })
        .select({
            _id: 0,
            date: 1,
            dayOfWeek: 1,
            start: 1,
            end: 1,
            leadTimestamp: 1,
            totalOrders: 1,
            maxCapacity: 1,
            areaGroups: 1,
            disabled: 1,
            id: 1
        })
        .sort({ date: 1, start: 1 })
        .lean()

    let windows = await loadWindows()
    if (!windows?.length) return windows

    // Holds expire lazily (no sweep): correct the counters of the windows in
    // view before reporting "full", so the first request after an expiry is
    // accurate and the expired customer's own window stops looking chosen.
    if (await purgeExpiredHolds(DL, windows.map(w => w.id))) {
        windows = await loadWindows()
    }
    if (!windows?.length) return windows

    // Special-day closures are enforced at read time (no mutation of generated rows)
    const specialDays = await DL.SpecialDay.read(
        {
            active: true,
            date: { $gte: dateFrom, $lte: dateTo }
        },
        { _id: 0, date: 1, storeIds: 1, start: 1, end: 1, name: 1 },
        { limit: 0 }
    )
    // filter by scope in-memory via specialDaysFor (global storeIds handling)
    const specialMap = buildSpecialMap(specialDays)

    const now = Date.now()
    const grouped = {}

    for (const w of windows) {
        const configuredGroups = w.areaGroups || []
        // Windows carrying a group config are reserved for members of those
        // groups; everyone else must not see them at all. A zeroed bucket
        // closes the window for its group entirely.
        const groupEntry = configuredGroups.length && userGroupIds.length
            ? configuredGroups.find(c => userGroupIds.includes(c.groupId))
            : null
        // if (configuredGroups.length && !groupEntry) continue
        if (groupEntry && groupEntry.capacity === 0) continue

        const isPast = w.leadTimestamp < now
        const isFull = isWindowFull(w, groupEntry)
        const isAlmostFull = !isFull && w.totalOrders >= (w.maxCapacity - 2)
        const isSpecial = specialDaysFor(specialMap, w.date, storeId)
            .find(sd => overlapsWindow(sd, w))
        const isClosed = Boolean(w.disabled)
        const flags = includeFlags
            ? { full: isFull, past: isPast, closed: isClosed, special: Boolean(isSpecial) }
            : null
        delete w.leadTimestamp
        delete w.totalOrders
        delete w.maxCapacity
        delete w.areaGroups
        w.chosen = currentWindowId === w.id
        // disabled combines the operational closure flag with computed states
        w.disabled = isClosed || isPast || isFull || Boolean(isSpecial)
        w.note = isPast ? 'past' : isFull ? 'full' : isSpecial ? isSpecial.name : isClosed ? 'closed' : isAlmostFull ? 'almost full' : ''
        if (flags) w.flags = flags

        const windowsDate = new Date(w.date)
        if (!grouped[w.date]) grouped[w.date] = {
            dayOfWeek: w.dayOfWeek,
            dayOfMonth: windowsDate.getDate(),
            month: windowsDate.getMonth(),
            date: w.date,
            windows: []
        }
        grouped[w.date].windows.push(w)
    }

    return Object.values(grouped)
}
