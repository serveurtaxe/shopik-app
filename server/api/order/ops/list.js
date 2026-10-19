import { enrichOrders } from '#server/utils/data/enrichCart.js'
import buildOpsFilter from '#server/utils/data/opsFilter.js'
import { deadlineFirstSort, balancedRoute } from '#common/functions/routeSort.js'

export default async function list(payload, { DL, _admin }) {
    const {
        filter: extraFilter = {},
        limit = 25,
        skip = 0,
        sort,
        search
    } = payload || {}

    // Shared queue scoping (current store, window limits, permission union) — see opsFilter.js,
    // which also strips any client-passed storeId from extraFilter.
    const { filter: finalFilter, perms: { me } } = await buildOpsFilter({
        _admin,
        extraFilter,
        statusFilter: { $in: ['paid', 'picking', 'picked', 'packed', 'shipped'] }
    })

    const finalSort = sort || { 'window.endTimestamp': 1, 'window.startTimestamp': 1 }

    const select = {
        _id: 0,
        id: 1,
        number: 1,
        name: 1,
        phone: 1,
        email: 1,
        status: 1,
        deliveryMethod: 1,
        storeId: 1,
        storeName: 1,
        window: 1,
        picker: 1,
        shipper: 1,
        address: 1,
        cart: 1,
        bags: 1,
        boxes: 1,
        sum: 1,
        finalSum: 1,
        comment: 1,
        leaveOrderAtDoor: 1,
        shipmentId: 1,
        labels: 1,
        userOrderNumber: 1,
        shipperComment: 1,
        orderRestoredFrom: 1,
    }

    // search via DL layer if provided
    const options = { sort: finalSort, skip, limit }
    if (search) options.search = search

    // Use raw Model for complex $or/$and that processFilter might strip — bypass read helper and use Model directly
    // But DL.Order.read will call processFilter which strips $or if not in filterFields. So we query Model directly.
    const Model = DL.Order.Model
    let query = finalFilter

    // Route-aware ordering for the shipper screens (store origin, static after leave-store).
    // WAITING (packed): deadline strictly wins; MINE (shipped): persisted balanced routeOrder.
    // In-memory resort over a capped fetch, then slice — keeps order correct for <30-row queues.
    const isWaiting = extraFilter?.status === 'packed' && !search
    const isMine = extraFilter?.status === 'shipped' && extraFilter?.['shipper.adminId'] && !search
    const skipN = Number(skip) || 0
    const limitN = Math.min(Number(limit) || 25, 100)

    let docs
    if (isWaiting || isMine) {
        const fetched = await Model.find(query, { _id: 0, ...select })
            .sort(finalSort)
            .limit(100)
            .lean()
        let route = []
        try {
            const storeId = fetched[0]?.storeId
                || (typeof finalFilter?.storeId === 'string' ? finalFilter.storeId : null)
            const store = storeId ? await DL.Store.readById(storeId) : null
            const origin = store?.address?.location?.coordinates || null
            if (isWaiting) {
                route = deadlineFirstSort(fetched, origin)
            } else {
                // static persisted order from shipment/start (or explicit shipment/route recalc)
                let seqById = null
                try {
                    const shipments = await DL.Shipment.Model.find(
                        { 'shipper.adminId': extraFilter['shipper.adminId'], status: 'active' },
                        { _id: 0, routeOrder: 1 }
                    ).lean()
                    seqById = new Map()
                    for (const s of (shipments || []))
                        for (const r of (s?.routeOrder || []))
                            if (r?.orderId != null && !seqById.has(r.orderId)) seqById.set(r.orderId, r.seq)
                } catch { seqById = null }
                if (seqById?.size) {
                    route = fetched.map(d => ({ orderId: d.id, seq: seqById.has(d.id) ? seqById.get(d.id) : 1e9, etaMs: null, slackMin: null, late: false }))
                        .sort((a, b) => (a.seq - b.seq) || ((a.orderId < b.orderId) ? -1 : 1))
                } else {
                    route = balancedRoute(fetched, origin, Date.now())
                }
            }
        } catch { route = [] }
        const routeById = new Map((route || []).map(r => [r.orderId, r]))
        const ordered = [...fetched].sort((a, b) => {
            const ra = routeById.get(a.id), rb = routeById.get(b.id)
            const sa = ra?.seq ?? 1e9, sb = rb?.seq ?? 1e9
            return sa - sb
        })
        docs = ordered.slice(skipN, skipN + limitN).map(d => {
            const r = routeById.get(d.id)
            return r ? { ...d, _route: { seq: r.seq, etaMs: r.etaMs ?? null, slackMin: r.slackMin ?? null, late: !!r.late } } : d
        })
    } else {
        // Handle $and case from above
        docs = await Model.find(query, { _id: 0, ...select })
            .sort(finalSort)
            .skip(skipN)
            .limit(limitN)
            .lean()
    }

    // enrich cart items with product snapshot for old orders
    try {
        await enrichOrders(docs, DL)
    } catch { }

    // Annotate isMine
    return docs.map(d => ({
        ...d,
        isMine: (d.picker?.adminId === me) || (d.shipper?.adminId === me)
    }))
}

list.config = {
    permissions: ['order:read', 'order:pick', 'order:ship']
}
