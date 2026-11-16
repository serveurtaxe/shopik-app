import getWindowTS from '#common/functions/getWindowTS.js'
import formatISODate from '#common/functions/formatISODate.js'
import { buildSpecialMap, specialDaysFor, overlapsWindow } from '#common/functions/specialDay.js'
import { findUserGroupIds, purgeExpiredHolds } from '#server/utils/data/windowGroups.js'
const GET_DAYS_AHEAD = 10

export default async function options(payload, { DL, _user, utils }) {
    const cartOrder = await utils.data.getUserOrder({ DL, _user })

    if (!cartOrder?.storeId) return []

    const { storeId, window } = cartOrder
    const timezone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const today = getWindowTS({ date: formatISODate(new Date()), hour: 12, timezone })
    const endDate = new Date(today)
    endDate.setDate(endDate.getDate() + GET_DAYS_AHEAD)

    const dateFrom = formatISODate(today)
    const dateTo = formatISODate(endDate)

    // Group-restricted windows apply to delivery orders only: the shopper's
    // address area decides which restricted windows they may see.
    const userGroupIds = cartOrder.deliveryMethod === DL.Order.constants.DELIVERY_METHOD.DELIVERY
        ? await findUserGroupIds(DL, storeId, cartOrder.address?.areaId)
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
        const isFull = w.totalOrders >= w.maxCapacity ||
            (groupEntry ? groupEntry.count >= groupEntry.capacity : false)
        const isAlmostFull = !isFull && w.totalOrders >= (w.maxCapacity - 2)
        const isSpecial = specialDaysFor(specialMap, w.date, storeId)
            .find(sd => overlapsWindow(sd, w))
        const isClosed = Boolean(w.disabled)
        delete w.leadTimestamp
        delete w.totalOrders
        delete w.maxCapacity
        delete w.areaGroups
        w.chosen = window?.id === w.id
        // disabled combines the operational closure flag with computed states
        w.disabled = isClosed || isPast || isFull || isSpecial
        w.note = isPast ? 'past' : isFull ? 'full' : isSpecial ? isSpecial.name : isClosed ? 'closed' : isAlmostFull ? 'almost full' : ''

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

options.config = { auth: 'required' }
