import storeScope, { narrowStoreIds, assertStoreIdsAllowed } from '#server/utils/data/storeScope.js'
import formatISODate from '#common/functions/formatISODate.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export default async function read(payload, { DL, _admin }) {
    const { date, fromDate, toDate, storeIds } = payload

    let dateFilter
    if (date) {
        if (!DATE_RE.test(date)) throw { status: 400, message: 'invalid date format, expected YYYY-MM-DD' }
        dateFilter = date
    } else {
        const timezone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
        const todayStr = formatISODate(getNowInTimezone(timezone))
        dateFilter = {
            $gte: fromDate && DATE_RE.test(fromDate) ? fromDate : todayStr,
            $lte: toDate && DATE_RE.test(toDate) ? toDate : (fromDate && DATE_RE.test(fromDate) ? fromDate : todayStr)
        }
    }

    // Store scoping via the canonical rule (storeScope) — this route used to
    // re-derive it from _admin.storeIds alone, which silently returned nothing for
    // a `store:all` admin with no explicit stores.
    const scope = storeScope({ _admin })
    if (scope !== null && !scope.length) return []      // scoped to nothing

    const requested = storeIds?.length ? storeIds : null
    assertStoreIdsAllowed(requested, scope)
    const filterStoreIds = narrowStoreIds(requested, scope)

    const filter = {
        // inactive (closed) windows are included so the daily grid can show
        // and re-open them; customer-facing reads do their own active filtering.
        date: dateFilter,
        active: true,
        ...(filterStoreIds ? { storeId: { $in: filterStoreIds } } : {})
    }

    return DL.OrderWindow.Model.find(filter)
        .select({ _id: 0 })
        .sort({ storeId: 1, start: 1, date: 1 })
        .lean()
}

function getNowInTimezone(timezone) {
    // new Date() in a container with TZ set is already local; formatDate uses UTC ISO.
    // Shift by the zone offset so the "today" string matches the business timezone.
    const now = new Date()
    const local = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(now)
    return new Date(`${local}T12:00:00Z`)
}

read.config = {
    permissions: ['order_window_template:read']
}
