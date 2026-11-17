import { opsScope, opsStatusWindow } from '#common/functions/opsView.js'
import storeScope, { narrowStoreIds } from '#server/utils/data/storeScope.js'

// window.date is a business-day string, so "today" has to be the store's day and
// not the process clock — resolved with the same timezone the window helpers use.
export function todayStr() {
    const timezone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date())
}

// Search as its own $and branch — a row that matches the text but falls outside
// the role's scope must not appear, so search cannot be folded into the permission
// $or. processFilter would strip that $or, which is why the queue reads through the
// raw Model. Shared by list and count so a badge counts what the tab shows.
export function opsSearchMatch(Model, filter, search) {
    if (!search?.length) return filter

    // Anchored prefix (^abc): an unanchored regex forces a full scan of the queue's
    // collection on every keystroke; anchored bounds can ride the existing indexes.
    const or = [...(Model.filterFields || [])]
        .filter(field => Model.schema.path(field)?.instance === 'String')
        .map(field => ({ [field]: new RegExp('^' + String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }))

    if (!or.length) return filter
    return { $and: [filter, { $or: or }] }
}

// Shared filter builder for the ops order queue (order/ops/list, order/ops/count).
// One role rule, resolved through common/functions/opsView.js, so the tab badges
// and the tab lists cannot disagree, and the client cannot ask for more than its
// permission allows.
export default async function buildOpsFilter({ _admin, extraFilter = {} }) {
    const me = _admin.id
    const scope = opsScope({ hasPermission: _admin.hasPermission, isSuperAdmin: _admin.isSuperAdmin })
    if (!scope) throw { status: 403, message: 'Forbidden' }

    const {
        storeId: clientStoreId,
        status: clientStatus,
        'window.date': clientDates,
        ...rest
    } = extraFilter

    const filter = { active: true, ...rest }

    // Store, through the canonical scope rule. For the multi-store views nothing is
    // requested by default, so the whole scope applies; a requested store narrows inside
    // it, never outside it. For the single-store views the store is pinned — a view
    // working one store names it in its filter, and there is no store to choose.
    if (scope.stores === 'scope') {
        const scopeStores = storeScope({ _admin })
        const requested = typeof clientStoreId === 'string' ? [clientStoreId]
            : Array.isArray(clientStoreId?.$in) ? clientStoreId.$in
                : null
        const chosen = narrowStoreIds(requested, scopeStores)
        if (chosen) filter.storeId = { $in: chosen }
    } else {
        // Never a client-picked store — the current store always wins.
        // No current store → empty queue (StoreGate forces selection before any
        // orders load), which applies to every role, super included.
        filter.storeId = _admin.currentStoreId || { $in: [] }
    }

    // The default window is a queue rule, not a permission: the ops detail page
    // looks a single order up by id, and the default bounds there would hide orders
    // the role can otherwise read. An explicit date request still applies.
    const queue = opsStatusWindow({
        scope,
        status: clientStatus,
        dates: clientDates,
        today: todayStr(),
        defaults: !extraFilter.id
    })

    // Own + unclaimed, only for the roles without a read-level scope. A picked
    // order is open to any picker only when nobody picked it — pack keeps the
    // picker as history, so an empty adminId is the marker for unclaimed.
    const ownOr = scope.ownOnly
        ? [
            ...(scope.canPick ? [{ 'picker.adminId': { $in: [me, null, ''] } }] : []),
            ...(scope.canShip ? [{ 'shipper.adminId': { $in: [me, null, ''] } }] : [])
        ]
        : []

    // Each rule is its own branch: the status+window rule can be an $or (closed
    // statuses are bounded backwards, in-process ones are not) and the claim rule is
    // one too, so they cannot share the same $or key.
    const claimOr = ownOr.length ? { $or: ownOr } : null
    const merged = { ...filter, ...queue }
    const final = claimOr ? (merged.$or ? { $and: [merged, claimOr] } : { ...merged, $or: claimOr.$or }) : merged

    return {
        filter: final,
        scope,
        multiStore: scope.stores === 'scope',
        me
    }
}
