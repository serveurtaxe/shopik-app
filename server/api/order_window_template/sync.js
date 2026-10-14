import executeInBatches from '#common/functions/executeInBatches.js'
import getWindowTS from '#common/functions/getWindowTS.js'
import { buildSpecialMap, overlapsWindow } from '#common/functions/specialDay.js'
import { groupsSignature } from '#server/utils/data/windowGroups.js'
import formatISODate from '#common/functions/formatISODate.js'

const SYNC_DAYS_AHEAD = 30

async function getActiveStoreIds(DL) {
    return DL.Store.Model.distinct('id', { active: true })
}

/**
 * Bulk fetches all applicable templates for a list of stores in 2 database queries.
 */
async function fetchTemplatesForStores(storeIds, DL) {
    const templates = await DL.OrderWindowTemplate.read({
        active: true,
        $or: [
            { storeId: { $in: storeIds } },
            { master: true }
        ]
    })

    let masterTemplate
    const templateMap = new Map()
    for (const t of templates) {
        if (t.master)
            masterTemplate = t
        else
            templateMap.set(t.storeId, t)
    }
    if (!masterTemplate)
        throw new Error('No master template found')
    // Fall back to master template if a specific store template isn't found
    const finalMap = new Map()
    for (const id of storeIds) {
        const t = templateMap.get(id) || masterTemplate
        if (t && t.windows?.length) {
            finalMap.set(id, t)
        }
    }

    return finalMap
}

export default async function sync(payload, { DL }) {
    const storeIds = payload.storeIds || await getActiveStoreIds(DL)
    if (!storeIds.length) return []

    // 1. Fetch all store templates at once
    const templateMap = await fetchTemplatesForStores(storeIds, DL)
    const validStoreIds = Array.from(templateMap.keys())

    if (!validStoreIds.length) {
        return storeIds.map(id => ({ storeId: id, synced: 0 }))
    }

    // Calculate date bounds
    const timezone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const today = getWindowTS({ date: formatISODate(new Date()), hour: 12, timezone })

    const endDate = new Date(today)
    endDate.setDate(endDate.getDate() + SYNC_DAYS_AHEAD)

    const startDateStr = formatISODate(today)
    const endDateStr = formatISODate(endDate)

    // Future-only guard: template saves pass fromDate (tomorrow) so today's
    // generated windows are never rewritten by an edit. Cron-style full sync
    // keeps the default of today.
    const fromDateStr = payload.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(payload.fromDate)
        ? payload.fromDate
        : startDateStr

    // Preload active special days once for the whole range; generation skips
    // windows covered by them (read-time enforcement keeps existing rows intact).
    const specialDays = await DL.SpecialDay.read(
        {
            active: true,
            date: { $gte: startDateStr, $lte: endDateStr }
        },
        { _id: 0, date: 1, storeIds: 1, start: 1, end: 1 },
        { limit: 0 }
    )
    const specialMap = buildSpecialMap(specialDays)

    // 2. Bulk fetch all existing order windows for all stores within the date range
    const existingWindows = await DL.OrderWindow.read({
        storeId: { $in: validStoreIds },
        date: { $gte: startDateStr, $lte: endDateStr }
    }, { _id: 0 }, { limit: 0 })

    // Index existing windows by composite key: `storeId_date_start`
    const existingMap = new Map()
    for (const ew of existingWindows) {
        existingMap.set(`${ew.storeId}_${ew.date}_${ew.start}`, ew)
    }

    // Generate list of dates in range
    const datesInfo = []
    for (let d = new Date(today); d <= endDate; d.setDate(d.getDate() + 1)) {
        const current = new Date(d)
        const date = formatISODate(current)
        if (date < fromDateStr) continue
        datesInfo.push({
            date,
            dayOfWeek: current.getDay()
        })
    }

    const bulkOperations = []
    const storeStats = Map.groupBy ?
        new Map(validStoreIds.map(id => [id, { created: 0, updated: 0, deleted: 0 }])) :
        new Map()

    if (!Map.groupBy) {
        validStoreIds.forEach(id => storeStats.set(id, { created: 0, updated: 0, deleted: 0 }))
    }

    // 3. Evaluate updates, creates, and soft-deletes in memory
    for (const storeId of validStoreIds) {
        const template = templateMap.get(storeId)
        const stats = storeStats.get(storeId)
        const { timezone } = template

        // Only group ids that actually exist for this store may restrict a
        // window — stale template references (deleted groups) are dropped so a
        // restricted window can never become invisible to everyone.
        let validGroupIds
        try {
            validGroupIds = new Set(await DL.AreaGroup.Model.distinct(
                'id',
                { storeId, active: true }
            ))
        } catch {
            validGroupIds = new Set()
        }
        const templateGroupsFor = tw =>
            (tw.areaGroups || []).filter(g => g && validGroupIds.has(g.groupId))

        for (const { date, dayOfWeek } of datesInfo) {
            const templateWindows = template.windows.filter(w => w.dayOfWeek === dayOfWeek)
            if (!templateWindows.length) continue

            const templateStarts = new Set(templateWindows.map(w => w.start))
            const daySpecials = specialMap.get(date)

            // Check template windows against existing windows
            for (const tw of templateWindows) {
                const key = `${storeId}_${date}_${tw.start}`
                const existing = existingMap.get(key)
                const leadHours = tw.leadHours ?? template.leadHours

                if (existing) {
                    // Manual capacity overrides survive re-sync; only a deleted
                    // template window (deactivation flow below) can remove them.
                    if (existing.manualCapacity) continue

                    const incomingGroups = templateGroupsFor(tw)
                    const needsUpdate = (
                        !existing.active ||
                        existing.end !== tw.end ||
                        existing.maxCapacity !== tw.maxCapacity ||
                        existing.leadHours !== leadHours ||
                        existing.timezone !== template.timezone ||
                        groupsSignature(existing.areaGroups) !== groupsSignature(incomingGroups)
                    )

                    if (needsUpdate) {
                        bulkOperations.push({
                            updateOne: {
                                filter: { id: existing.id },
                                update: {
                                    $set: {
                                        active: true,
                                        end: tw.end,
                                        leadHours,
                                        endTimestamp: getWindowTS({ date, hour: tw.end, timezone }),
                                        leadTimestamp: getWindowTS({ date, hour: tw.start - leadHours, timezone }),
                                        maxCapacity: tw.maxCapacity,
                                        timezone: template.timezone,
                                        areaGroups: incomingGroups.map(({ groupId, capacity }) => ({
                                            groupId,
                                            capacity,
                                            count: (existing.areaGroups || []).find(g => g?.groupId === groupId)?.count ?? 0
                                        }))
                                    }
                                }
                            }
                        })
                        stats.updated++
                    }
                } else {
                    // Special-day aware generation: don't create future windows
                    // fully/partially covered by an active closure.
                    const covered = daySpecials?.some(sd =>
                        (!sd.storeIds?.length || sd.storeIds.includes(storeId)) &&
                        overlapsWindow(sd, tw)
                    )
                    if (covered) continue

                    bulkOperations.push({
                        insertOne: {
                            document: {
                                storeId,
                                date,
                                dayOfWeek,
                                start: tw.start,
                                end: tw.end,
                                maxCapacity: tw.maxCapacity,
                                totalOrders: 0,
                                areaGroups: templateGroupsFor(tw).map(({ groupId, capacity }) => ({
                                    groupId, capacity, count: 0
                                })),
                                leadHours: leadHours,
                                timezone: template.timezone,
                                startTimestamp: getWindowTS({ date, hour: tw.start, timezone }),
                                endTimestamp: getWindowTS({ date, hour: tw.end, timezone }),
                                leadTimestamp: getWindowTS({ date, hour: tw.start - leadHours, timezone }),
                                manualCapacity: false,
                                disabled: false
                            }
                        }
                    })
                    stats.created++
                }
            }

            // Deactivate windows missing from template with 0 orders
            for (const [key, existing] of existingMap.entries()) {
                if (existing.storeId === storeId && existing.date === date) {
                    if (existing.active && !templateStarts.has(existing.start) && existing.totalOrders === 0) {
                        bulkOperations.push({
                            updateOne: {
                                filter: { id: existing.id },
                                update: { $set: { active: false } }
                            }
                        })
                        stats.deleted++
                    }
                }
            }
        }
    }

    // 4. Execute all writes in batched MongoDB bulkWrite calls
    if (bulkOperations.length > 0) {
        const BATCH_SIZE = 2500
        await executeInBatches(
            bulkOperations,
            batch => DL.OrderWindow.Model.bulkWrite(batch, { ordered: false }),
            BATCH_SIZE
        )
    }

    // Format response
    return storeIds.map(storeId => {
        const stats = storeStats.get(storeId)
        return { storeId, synced: stats ?? {} }
    })
}

sync.config = {
    permissions: 'order_window:sync'
}