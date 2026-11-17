import { enrichOrders } from '#server/utils/data/enrichCart.js'
import { withSortedCart } from '#server/utils/data/sortCartByCategory.js'
import buildOpsFilter, { opsSearchMatch } from '#server/utils/data/opsFilter.js'
import { withTiebreaker } from '#server/dl/defaults/read.js'
import { CLOSED_STATUSES } from '#common/functions/opsView.js'
import { deadlineFirstSort, balancedRoute } from '#common/functions/routeSort.js'

export default async function list(payload, { DL, _admin }) {
    const {
        filter: extraFilter = {},
        limit = 25,
        skip = 0,
        sort,
        search
    } = payload || {}

    // Shared queue scoping (role window, store scope, permission union) — see
    // common/functions/opsView.js and opsFilter.js.
    const { filter: finalFilter, multiStore, me } = await buildOpsFilter({
        _admin,
        extraFilter
    })

    // Two consumers with opposite needs: the queue list (the page refreshes every
    // couple of minutes) and the OpsOrder detail lookup by id (needs the whole
    // cart). The queue is only ever a window/status/store filter — an id lookup
    // is always a string — so the shape is picked from the filter itself.
    const isDetail = typeof extraFilter?.id === 'string'

    // Own orders first (mine, then unclaimed), then by window deadline.
    // mineFirst has to be computed before the sort stage, so the read is an
    // aggregation instead of find().sort() (which rejects projection fields).
    // Closed orders sit at the bottom of the queue: the work an order still needs is
    // what the roles act on, so history goes last. Both flags are computed in the
    // project stage, which is also why they can be sort keys.
    const baseSort = withTiebreaker(DL.Order.Model, sort) || { 'window.endTimestamp': 1, 'window.startTimestamp': 1 }
    const mineSort = { closedFirst: 1, mineFirst: -1, ...baseSort }

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

    // The queue row is what an ops card renders: the two cart *counts* (total and
    // handled), not the cart itself. Shipping 25 full carts — every line with its
    // images, unit and category snapshot — cost ~2.2MB brotli per page on prod;
    // the counts are computed in the project stage, so MongoDB never carries the
    // cart arrays at all. The by-id detail keeps the cart.
    const { cart: _queueCart, ...listSelect } = select
    const cartCounts = {
        cartCount: { $size: { $ifNull: ['$cart', []] } },
        // handled = a picked line (finalAmount set) or a flagged-missing one — the
        // same rule the card applies to a full cart.
        handledCount: {
            $size: {
                $filter: {
                    input: { $ifNull: ['$cart', []] },
                    // as:'item' — $$item is only in scope when $filter names it.
                    as: 'item',
                    cond: { $or: [{ $ne: [{ $ifNull: ['$$item.finalAmount', null] }, null] }, '$$item.missing'] }
                }
            }
        }
    }

    // Use raw Model for complex $or/$and that processFilter might strip — bypass read helper and use Model directly
    // But DL.Order.read will call processFilter which strips $or if not in filterFields. So we query Model directly.
    const Model = DL.Order.Model
    const query = opsSearchMatch(Model, finalFilter, search)

    // mineFirst is computed before the sort stage, so the read goes through an aggregation
    const pipelineBase = [
        { $match: query },
        {
            $project: {
                ...(isDetail ? select : listSelect),
                ...(isDetail ? {} : cartCounts),
                mineFirst: {
                    $cond: [
                        {
                            $or: [{ $eq: ['$picker.adminId', me] }, { $eq: ['$shipper.adminId', me] }]
                        },
                        1,
                        0
                    ]
                },
                // 0 for an order that still has work to do, 1 for a closed one, so
                // ascending puts the live queue first and the history last.
                closedFirst: { $cond: [{ $in: ['$status', CLOSED_STATUSES] }, 1, 0] }
            }
        }
    ]

    // Route-aware ordering for the shipper screens (store origin, static after leave-store).
    // WAITING (packed): deadline strictly wins; MINE (shipped): persisted balanced routeOrder.
    // In-memory resort over a capped fetch, then slice — keeps order correct for <30-row queues.
    // A contractor's queue spans several stores, so a single origin cannot order it: sort by window.
    const isWaiting = extraFilter?.status === 'packed' && !search && !multiStore
    const isMine = extraFilter?.['shipper.adminId'] && !search && !multiStore
    const skipN = Number(skip) || 0
    const limitN = Math.min(Number(limit) || 25, 100)

    let docs
    if (isWaiting || isMine) {
        const fetched = await Model.aggregate([...pipelineBase, { $sort: mineSort }, { $limit: 100 }])
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
            // Closed orders stay last even inside a route-ordered queue.
            const ca = a.closedFirst || 0, cb = b.closedFirst || 0
            if (ca !== cb) return ca - cb
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
        docs = await Model.aggregate([...pipelineBase, { $sort: mineSort }, { $skip: skipN }, { $limit: limitN }])
    }

    // enrich cart items with product snapshot for old orders — only the detail
    // row has a cart; queue rows ship counts and never touch the products.
    try {
        if (isDetail) await enrichOrders(docs, DL)
    } catch { }

    // Annotate isMine (mineFirst and closedFirst are only used for ordering).
    // Only the cart-carrying detail row is grouped by category for the ops screens.
    return docs.map(({ mineFirst, closedFirst, cartCount, handledCount, ...d }) => {
        const order = {
            ...d,
            isMine: (d.picker?.adminId === me) || (d.shipper?.adminId === me)
        }
        // The detail row carries the full cart: the counts are redundant there and
        // would be a second, non-enriched source of truth for the card.
        return isDetail ? withSortedCart(order) : { ...order, cartCount, handledCount }
    })
}

list.config = {
    permissions: ['order:read', 'order:pick', 'order:ship', 'order:pick:manage', 'order:ship:manage']
}
