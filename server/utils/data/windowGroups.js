/**
 * Area-group capacity helpers for order windows.
 *
 * A window's `areaGroups` array carves a dedicated slice of its maxCapacity
 * per area group: [{ groupId, capacity, count? }] (count only on concrete
 * order_window docs). Users whose address area is not part of any configured
 * group cannot see or book the window at all.
 */

const MINUTE_MS = 60 * 1000

/**
 * How long a reservation is kept after the customer picks a window. The hold
 * is capped by the window's lead time (see selectionHoldDeadline) and can be
 * extended once at checkout so a payment that already started can finish.
 */
export const HOLD_MINUTES = Math.max(1, Number(process.env.WINDOW_HOLD_MINUTES) || 30)
export const PAYMENT_GRACE_MINUTES = Math.max(0, Number(process.env.WINDOW_PAYMENT_GRACE_MINUTES) || 5)

const HOLD_MS = HOLD_MINUTES * MINUTE_MS
const PAYMENT_GRACE_MS = PAYMENT_GRACE_MINUTES * MINUTE_MS

function timestamp(value) {
    if (!value) return null
    const t = new Date(value).getTime()
    return Number.isNaN(t) ? null : t
}

/**
 * Absolute moment a reservation stops holding capacity, or null when the
 * order carries no hold information at all (legacy carts are then treated as
 * already expired by expireWindowHold/purgeExpiredHolds).
 */
export function holdDeadline(window) {
    if (!window?.id) return null
    const explicit = timestamp(window.holdUntil)
    if (explicit != null) return explicit
    const reservedAt = timestamp(window.reservedAt)
    if (reservedAt == null) return null
    const fullHold = reservedAt + HOLD_MS
    // Carts created before holdUntil existed still respect the lead-time cap.
    const lead = timestamp(window.leadTimestamp)
    return lead == null ? fullHold : Math.min(fullHold, lead)
}

/**
 * Deadline stamped at selection time: the full hold, but never past the
 * window's lead time. Picking a window five minutes before its lead time
 * leaves exactly five minutes to complete the order.
 */
export function selectionHoldDeadline({ now = Date.now(), leadTimestamp } = {}) {
    const base = now + HOLD_MS
    const lead = timestamp(leadTimestamp)
    return lead == null ? base : Math.min(base, lead)
}

function expiredHoldFilter(now) {
    return {
        $or: [
            { 'window.holdUntil': { $lte: new Date(now) } },
            { 'window.holdUntil': null, 'window.reservedAt': { $exists: true, $lte: new Date(now - HOLD_MS) } },
            { 'window.holdUntil': null, 'window.reservedAt': null }
        ]
    }
}

/**
 * Releases a single reservation if (and only if) it is still the same window
 * and its hold has run out. The order document is the guard, so concurrent
 * callers (two tabs, two endpoints) can only decrement the counters once.
 * Returns true when the hold was actually released.
 */
export async function expireWindowHold(DL, order, { now = Date.now() } = {}) {
    const windowId = order?.window?.id
    if (!order?.id || !windowId) return false

    const deadline = holdDeadline(order.window)
    if (deadline != null && deadline > now) return false

    let released
    try {
        released = await DL.Order.Model.findOneAndUpdate(
            {
                id: order.id,
                status: DL.Order.constants.ORDER_STATUS.CART,
                'window.id': windowId,
                ...expiredHoldFilter(now)
            },
            { $unset: { window: 1 } }
        )
    } catch {
        return false
    }
    if (!released) return false

    try {
        await releaseWindowReservation(DL, windowId, order.window?.reservedGroupId)
    } catch { }
    delete order.window
    return true
}

/**
 * Releases every expired reservation on the given windows. Used on demand
 * (window list, window choice) so counters correct themselves without a
 * background sweep: the first request after a hold expires sees the real
 * occupancy.
 */
export async function purgeExpiredHolds(DL, windowIds, { now = Date.now() } = {}) {
    const ids = [...new Set((windowIds || []).filter(Boolean))]
    if (!ids.length) return 0

    let orders = []
    try {
        orders = await DL.Order.Model.find(
            {
                status: DL.Order.constants.ORDER_STATUS.CART,
                active: true,
                'window.id': { $in: ids },
                ...expiredHoldFilter(now)
            },
            { _id: 0, id: 1, window: 1 }
        ).lean()
    } catch {
        return 0
    }

    let released = 0
    for (const order of orders) {
        if (await expireWindowHold(DL, order, { now })) released++
    }
    return released
}

/**
 * One-off checkout extension: adds the payment grace to the remaining hold.
 * A reservation is extended at most once, so retries cannot keep a slot
 * forever. Returns the new deadline (ms), or the unchanged one when the hold
 * had already been extended.
 */
export async function extendWindowHold(DL, order, { now = Date.now() } = {}) {
    const deadline = holdDeadline(order?.window)
    if (deadline == null) return null
    if (timestamp(order.window.holdExtendedAt) != null) return deadline

    const next = deadline + PAYMENT_GRACE_MS
    const updated = await DL.Order.Model.findOneAndUpdate(
        {
            id: order.id,
            status: DL.Order.constants.ORDER_STATUS.CART,
            'window.id': order.window.id,
            'window.holdExtendedAt': null
        },
        { $set: { 'window.holdUntil': new Date(next), 'window.holdExtendedAt': new Date(now) } },
        { returnDocument: 'after' }
    )
    if (!updated) return holdDeadline(order.window) ?? deadline

    order.window.holdUntil = new Date(next)
    order.window.holdExtendedAt = new Date(now)
    return next
}

/**
 * Validates + normalizes an incoming areaGroups config.
 * Accepts [{ groupId, capacity }] entries; returns clean sorted entries,
 * or [] when empty/absent. Throws { status, message } on invalid input.
 */
export function sanitizeGroupCapacities(areaGroups, maxCapacity) {
    if (areaGroups == null) return []
    if (!Array.isArray(areaGroups))
        throw { status: 400, message: 'areaGroups must be an array' }

    const seen = new Set()
    const out = []
    for (const g of areaGroups) {
        if (!g || typeof g.groupId !== 'string' || !g.groupId.trim())
            throw { status: 400, message: 'areaGroups entry is missing groupId' }
        const groupId = g.groupId.trim()
        if (seen.has(groupId)) continue
        seen.add(groupId)

        const capacity = g.capacity
        if (!Number.isInteger(capacity) || capacity < 0 || capacity > 100)
            throw { status: 400, message: 'group capacity must be an integer between 0 and 100' }
        if (maxCapacity != null && capacity > maxCapacity)
            throw { status: 400, message: 'group capacity cannot exceed the window maxCapacity' }

        out.push({ groupId, capacity })
    }
    return out.sort((a, b) => (a.groupId < b.groupId ? -1 : 1))
}

/**
 * Maps a validated config onto existing window areaGroups, preserving live
 * counters by groupId. Entries removed from the config are dropped.
 */
export function mergeGroupCounts(existingAreaGroups = [], sanitizedConfig = []) {
    return sanitizedConfig.map(({ groupId, capacity }) => ({
        groupId,
        capacity,
        count: existingAreaGroups.find(g => g?.groupId === groupId)?.count ?? 0
    }))
}

/**
 * Canonical signature used to detect whether group config actually changed.
 */
export function groupsSignature(areaGroups = []) {
    return (areaGroups || [])
        .map(g => `${g?.groupId}:${g?.capacity}`)
        .sort()
        .join(';')
}

/**
 * Ids of the active area groups of `storeId` that contain `areaId`.
 * Business rule: an area belongs to at most one group per store — if the
 * data ever violates that, all matches are returned and consumers pick
 * the first deterministically.
 */
export async function findUserGroupIds(DL, storeId, areaId) {
    if (!storeId || !areaId) return []
    const groupsIds = await DL.AreaGroup.Model.distinct(
        'id',
        { storeId, active: true, areaIds: areaId }
    )
    return groupsIds
}

/**
 * Atomic guard ensuring the window has free global capacity AND the given
 * group bucket is not exhausted. Without groupId it reduces to the plain
 * totalOrders < maxCapacity check.
 */
export function reserveGuard(windowId, groupId) {
    const conditions = [{ $lt: ['$totalOrders', '$maxCapacity'] }]
    if (groupId) {
        conditions.push({
            $not: {
                $anyElementTrue: {
                    $map: {
                        input: '$areaGroups',
                        as: 'g',
                        in: {
                            $and: [
                                { $eq: ['$$g.groupId', groupId] },
                                { $gte: ['$$g.count', '$$g.capacity'] }
                            ]
                        }
                    }
                }
            }
        })
    }
    return { id: windowId, $expr: { $and: conditions } }
}

/**
 * Releases a reservation: decrements totalOrders (guarded > 0) and, when a
 * group counter was consumed, that counter too (best-effort so a missing or
 * already-zero entry can never block the global decrement).
 */
export async function releaseWindowReservation(DL, windowId, groupId) {
    if (!windowId) return
    await DL.OrderWindow.Model.updateOne(
        { id: windowId, totalOrders: { $gt: 0 } },
        { $inc: { totalOrders: -1 } }
    )
    if (!groupId) return
    await DL.OrderWindow.Model.updateOne(
        { id: windowId, areaGroups: { $elemMatch: { groupId, count: { $gt: 0 } } } },
        { $inc: { 'areaGroups.$[g].count': -1 } },
        { arrayFilters: [{ 'g.groupId': groupId }] }
    )
}
