import executeInBatches from '#common/functions/executeInBatches.js'

const DELIVERY = 'delivery'
const ORDER_STATUS = { CANCELED: 'canceled', FAILED: 'failed' }

function holdsSlot(order) {
    if (order.status === ORDER_STATUS.FAILED) return false
    if (order.status === ORDER_STATUS.CANCELED && !order.pickStart) return false
    return true
}

function buildAreaIndex(groups) {
    const byStore = new Map()
    for (const g of groups) {
        if (g.active === false) continue
        for (const areaId of g.areaIds || []) {
            if (!areaId) continue
            if (!byStore.has(g.storeId)) byStore.set(g.storeId, new Map())
            const byArea = byStore.get(g.storeId)
            if (!byArea.has(areaId)) byArea.set(areaId, new Set())
            byArea.get(areaId).add(g.id)
        }
    }
    return byStore
}

function inferGroupId(order, windowDoc, areaIndex) {
    if ((order.deliveryMethod || DELIVERY) !== DELIVERY) return null
    const areaId = order.address?.areaId
    if (!areaId) return null
    const candidateIds = areaIndex.get(windowDoc.storeId)?.get(areaId)
    if (!candidateIds) return null
    return (windowDoc.areaGroups || []).find(g => candidateIds.has(g.groupId))?.groupId ?? null
}

export default async function reconcileWindowGroupCounts({ DL } = {}, { dryRun = false } = {}) {
    if (!DL) {
        console.log('[windowGroups] DL required — call reconcileWindowGroupCounts({ DL }) from boot')
        return
    }

    console.log('[windowGroups] Loading windows and area groups...')
    const [windows, groups] = await Promise.all([
        DL.OrderWindow.Model.find({}, { _id: 0, id: 1, storeId: 1, totalOrders: 1, areaGroups: 1 }).lean(),
        DL.AreaGroup.Model.find({}, { _id: 0, id: 1, storeId: 1, areaIds: 1, active: 1 }).lean()
    ])

    const windowById = new Map(windows.map(w => [w.id, w]))
    const areaIndex = buildAreaIndex(groups)

    const totals = new Map()
    const counts = new Map()
    const backfill = []
    let scanned = 0
    let skipped = 0
    let orphanWindows = 0

    console.log('[windowGroups] Scanning orders...')
    const cursor = DL.Order.Model.find(
        { 'window.id': { $exists: true, $ne: null } },
        {
            _id: 0, id: 1, status: 1, pickStart: 1, deliveryMethod: 1,
            'address.areaId': 1, 'window.id': 1, 'window.reservedGroupId': 1
        }
    ).lean().cursor()

    for await (const order of cursor) {
        scanned++
        if (!holdsSlot(order)) { skipped++; continue }

        const windowId = order.window.id
        const windowDoc = windowById.get(windowId)
        if (!windowDoc) { orphanWindows++; continue }

        const groupId = order.window.reservedGroupId || inferGroupId(order, windowDoc, areaIndex)
        const known = groupId && (windowDoc.areaGroups || []).some(g => g.groupId === groupId)

        totals.set(windowId, (totals.get(windowId) || 0) + 1)

        if (known) {
            if (!counts.has(windowId)) counts.set(windowId, new Map())
            const byGroup = counts.get(windowId)
            byGroup.set(groupId, (byGroup.get(groupId) || 0) + 1)
        }

        if (!order.window.reservedGroupId && groupId && known)
            backfill.push({ id: order.id, reservedGroupId: groupId })
    }

    const windowUpdates = []
    for (const w of windows) {
        const newTotal = totals.get(w.id) || 0
        const byGroup = counts.get(w.id) || new Map()
        const newGroups = (w.areaGroups || []).map(g => ({
            groupId: g.groupId,
            capacity: g.capacity,
            count: byGroup.get(g.groupId) || 0
        }))
        const changed = newTotal !== (w.totalOrders ?? 0) ||
            newGroups.some((g, i) => g.count !== (w.areaGroups?.[i]?.count ?? 0))
        if (changed) windowUpdates.push({ id: w.id, totalOrders: newTotal, areaGroups: newGroups })
    }

    console.log(`[windowGroups] orders scanned: ${scanned}, non-holding skipped: ${skipped}, orphan windows skipped: ${orphanWindows}`)
    console.log(`[windowGroups] windows to update: ${windowUpdates.length}, orders to backfill: ${backfill.length}`)

    if (dryRun) {
        console.log('[windowGroups] dry-run — no writes')
        return { scanned, windowUpdates: windowUpdates.length, backfill: backfill.length }
    }

    console.log('[windowGroups] Writing window counters...')
    await executeInBatches(windowUpdates, batch =>
        DL.OrderWindow.Model.bulkWrite(batch.map(u => ({
            updateOne: {
                filter: { id: u.id },
                update: { $set: { totalOrders: u.totalOrders, areaGroups: u.areaGroups } }
            }
        })), { ordered: false }))

    console.log('[windowGroups] Backfilling order reservedGroupId...')
    await executeInBatches(backfill, batch =>
        DL.Order.Model.bulkWrite(batch.map(u => ({
            updateOne: {
                filter: { id: u.id },
                update: { $set: { 'window.reservedGroupId': u.reservedGroupId } }
            }
        })), { ordered: false }))

    console.log('[windowGroups] Done')
    return { scanned, windowUpdates: windowUpdates.length, backfill: backfill.length }
}
