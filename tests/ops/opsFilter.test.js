import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import buildOpsFilter, { todayStr, opsSearchMatch } from '#server/utils/data/opsFilter.js'
import count from '#server/api/order/ops/count.js'
import list from '#server/api/order/ops/list.js'
import { addDays, CLOSED_STATUSES, opsScope, viewScope, opsStatusWindow } from '#common/functions/opsView.js'

function makeAdmin({ id = 'a1', permissions = [], storeIds = [], currentStoreId = 's1', isSuperAdmin = false } = {}) {
    return {
        id,
        isSuperAdmin,
        storeIds,
        currentStoreId,
        hasPermission: permission => isSuperAdmin || permissions.includes(permission)
    }
}

const today = todayStr()
const day = n => addDays(today, n)

async function queueFor(admin, extraFilter = {}) {
    return (await buildOpsFilter({ _admin: admin, extraFilter })).filter
}

describe('ops queue roles', () => {
    it('gives a picker everything still to pick, today and tomorrow, with no past bound', async () => {
        const filter = await queueFor(makeAdmin({ id: 'p1', permissions: ['order:pick'] }))

        assert.deepEqual(filter.status, { $in: ['paid', 'picking', 'picked', 'packed'] })
        // Only the forward bound: an order late by a day or more is still his to pick.
        assert.deepEqual(filter['window.date'], { $lte: day(1) })
        assert.equal(filter.storeId, 's1')
        // Only what nobody claimed yet, plus what he claimed.
        assert.deepEqual(filter.$or, [{ 'picker.adminId': { $in: ['p1', null, ''] } }])
    })

    it('bounds a shipper backwards only for the statuses that are already closed', async () => {
        const filter = await queueFor(makeAdmin({ id: 'd1', permissions: ['order:ship'] }))
        const [open, closed] = filter.$and[0].$or

        assert.deepEqual(open.status, { $in: ['packed', 'shipped'] })
        assert.equal(open['window.date'].$gte, undefined, 'a ship still on the road is not date-bounded')
        assert.equal(open['window.date'].$lte, day(1))

        assert.deepEqual(closed.status, { $in: ['done', 'canceled'] })
        assert.deepEqual(closed['window.date'], { $gte: day(-1), $lte: day(1) })

        assert.deepEqual(filter.$and[1].$or, [{ 'shipper.adminId': { $in: ['d1', null, ''] } }])
    })

    it('keeps both queues for someone who picks and ships', async () => {
        const filter = await queueFor(makeAdmin({ id: 'x1', permissions: ['order:pick', 'order:ship'] }))
        const [open, closed] = filter.$and[0].$or

        assert.deepEqual(open.status, { $in: ['paid', 'picking', 'picked', 'packed', 'shipped'] })
        assert.deepEqual(open['window.date'], { $lte: day(1) })
        assert.deepEqual(closed.status, { $in: ['done', 'canceled'] })
        assert.deepEqual(closed['window.date'], { $gte: day(-1), $lte: day(1) })

        assert.deepEqual(filter.$and[1].$or, [
            { 'picker.adminId': { $in: ['x1', null, ''] } },
            { 'shipper.adminId': { $in: ['x1', null, ''] } }
        ])
    })

    it('gives a manager every in-process order, and closed ones over a 7 day look', async () => {
        const filter = await queueFor(makeAdmin({ id: 'm1', permissions: ['order:pick:manage', 'order:ship:manage'] }))
        const [open, closed] = filter.$or

        assert.deepEqual(open.status, { $in: ['paid-edit', 'paid', 'picking', 'picked', 'packed', 'shipped'] })
        assert.equal(open['window.date'], undefined, 'a manager reaches an order that is still open on any date')
        assert.deepEqual(closed.status, { $in: ['done', 'canceled', 'failed'] })
        assert.deepEqual(closed['window.date'], { $gte: day(-7) })
        assert.equal(filter.$and, undefined, 'no claim rule for a read-level scope')
    })

    it('reads order:read as the manager view, without the claim rule', async () => {
        const filter = await queueFor(makeAdmin({ id: 'r1', permissions: ['order:read'] }))

        assert.equal(filter.storeId, 's1')
        assert.equal(filter.$and, undefined)
        assert.equal(filter.$or.length, 2)
    })

    it('gives a contractor all his stores at once, not only the current one', async () => {
        const admin = makeAdmin({ id: 'c1', permissions: ['order:ship:manage'], storeIds: ['s1', 's2'], currentStoreId: 's1' })
        const filter = await queueFor(admin)

        assert.deepEqual(filter.storeId, { $in: ['s1', 's2'] })
        assert.equal(filter.$and, undefined)
        assert.equal(filter.$or.length, 2)
    })

    it('keeps the contractor multi-store when the admin also holds a single-store permission', async () => {
        const admin = makeAdmin({ id: 'c1', permissions: ['order:pick:manage', 'order:ship:manage'], storeIds: ['s1', 's2'] })

        // The store rule is the ceiling: he may see all his stores, and the view that
        // works one store asks for it instead of being pinned.
        assert.deepEqual((await queueFor(admin)).storeId, { $in: ['s1', 's2'] })
        assert.deepEqual((await queueFor(admin, { storeId: 's2' })).storeId, { $in: ['s2'] })
        assert.equal(viewScope('order:pick:manage').stores, 'current')
        assert.equal(viewScope('order:ship:manage').stores, 'scope')
    })

    it('narrows a contractor store request inside his scope, never outside it', async () => {
        const admin = makeAdmin({ id: 'c1', permissions: ['order:ship:manage'], storeIds: ['s1', 's2'] })
        const filter = await queueFor(admin, { storeId: { $in: ['s2', 's3'] } })

        assert.deepEqual(filter.storeId, { $in: ['s2'] })
    })

    it('keeps a single-store role on the current store, whatever the request says', async () => {
        const filter = await queueFor(makeAdmin({ id: 'p1', permissions: ['order:pick'] }), { storeId: 's2' })
        assert.equal(filter.storeId, 's1')
    })

    it('returns nothing for a status the role cannot see, instead of widening the queue', async () => {
        const filter = await queueFor(makeAdmin({ id: 'p1', permissions: ['order:pick'] }), { status: 'shipped' })
        assert.deepEqual(filter.status, { $in: [] })
    })

    it('clamps a date request inside the role, so a late order stays visible for a picker', async () => {
        const picker = makeAdmin({ id: 'p1', permissions: ['order:pick'] })
        const filter = await queueFor(picker, { 'window.date': { $gte: day(-3), $lte: day(0) } })

        assert.deepEqual(filter['window.date'], { $gte: day(-3), $lte: day(0) })
    })

    it('answers nothing for a shipper when the requested dates are past his look', async () => {
        const filter = await queueFor(makeAdmin({ id: 'd1', permissions: ['order:ship'] }),
            { 'window.date': { $gte: day(3), $lte: day(9) } })

        for (const branch of filter.$and[0].$or)
            assert.deepEqual(branch['window.date'], { $in: [] })
    })

    it('lets the manage views reach an in-process order on any date, while a closed one stays inside their look', async () => {
        const manager = makeAdmin({ id: 'm1', permissions: ['order:pick:manage'] })
        const filter = await queueFor(manager, { 'window.date': { $gte: day(-120), $lte: day(0) } })
        const [open, closed] = filter.$or

        // Nothing bounds in-process statuses backwards; the request stands as asked.
        assert.deepEqual(open['window.date'], { $gte: day(-120), $lte: day(0) })
        // A request reaching past the role's look for closed orders is clamped to it.
        assert.deepEqual(closed['window.date'], { $gte: day(-7), $lte: day(0) })
    })

    it('does not apply the default window to a single order lookup, which is how the detail page reads', async () => {
        const manager = makeAdmin({ id: 'm1', permissions: ['order:pick:manage'] })
        const filter = await queueFor(manager, { id: 'o1' })

        assert.equal(filter.$and, undefined)
        assert.equal(filter.$or.length, 2)
        for (const branch of filter.$or) assert.equal(branch['window.date'], undefined)
        assert.equal(filter.id, 'o1')
    })

    it('keeps a lookup inside the statuses the role can see, without its default window', async () => {
        const manager = makeAdmin({ id: 'm1', permissions: ['order:pick:manage'] })
        const filter = await queueFor(manager, { id: 'o1' })

        for (const branch of filter.$or) assert.equal(branch['window.date'], undefined)
        assert.equal(filter.id, 'o1')

        // A picker still cannot read what his queue never covers.
        const picker = await queueFor(makeAdmin({ id: 'p1', permissions: ['order:pick'] }), { status: 'done', id: 'o1' })
        assert.deepEqual(picker.status, { $in: [] })
    })

    it('rejects an admin with no ops permission', async () => {
        await assert.rejects(
            () => buildOpsFilter({ _admin: makeAdmin({ permissions: ['product:read'] }) }),
            err => err.status === 403
        )
    })

    it('counts exactly what the queue would show', async () => {
        const admin = makeAdmin({ id: 'p1', permissions: ['order:pick'] })
        const requested = { status: 'packed' }
        const calls = {}
        const DL = { Order: { Model: { countDocuments: async filter => { calls.filter = filter; return 0 } } } }

        await count({ filter: requested }, { DL, _admin: admin })

        assert.deepEqual(calls.filter, await queueFor(admin, requested))
    })

    it('keeps search as its own branch, never folded into the permission or', () => {
        const Model = {
            filterFields: new Set(['name', 'phone']),
            schema: { path: () => ({ instance: 'String' }) }
        }
        const permission = { storeId: 's1', $or: [{ 'picker.adminId': 'p1' }] }
        const match = opsSearchMatch(Model, permission, 'abc')

        assert.deepEqual(match.$and[0], permission)
        assert.equal(match.$and[1].$or.length, 2)
    })

    it('orders the queue by what still needs work, whatever the client sorted by', async () => {
        const pipeline = {}
        const DL = {
            Order: {
                Model: {
                    filterFields: new Set(['id']),
                    schema: { path: () => ({ instance: 'String' }) },
                    aggregate: stages => { pipeline.stages = stages; return [] }
                }
            },
            Store: { readById: async () => null }
        }
        const admin = makeAdmin({ id: 'd1', permissions: ['order:ship'] })

        await list({ filter: {}, sort: { 'window.endTimestamp': 1 } }, { DL, _admin: admin })

        // Nothing on an order says "closed", so the flag has to be computed in the
        // project stage — which is also why it can be a sort key at all.
        assert.ok(pipeline.stages.find(s => s.$project).$project.closedFirst)
        // closed last, then own, then the window order the client asked for
        assert.deepEqual(Object.keys(pipeline.stages.find(s => s.$sort).$sort),
            ['closedFirst', 'mineFirst', 'window.endTimestamp', 'id'])
    })

    it('keeps closed orders last in the route-ordered tabs too', async () => {
        // The fake aggregate answers with what the project stage would have produced,
        // so the flag is derived the same way the pipeline derives it.
        const closed = status => CLOSED_STATUSES.includes(status) ? 1 : 0
        const docs = [
            { id: 'closed1', storeId: 's1', status: 'done', closedFirst: closed('done'), shipper: { adminId: 'd1' }, window: { endTimestamp: 1000 }, cartCount: 0, handledCount: 0 },
            { id: 'open1', storeId: 's1', status: 'shipped', closedFirst: closed('shipped'), shipper: { adminId: 'd1' }, window: { endTimestamp: 2000 }, cartCount: 0, handledCount: 0 },
            { id: 'open2', storeId: 's1', status: 'shipped', closedFirst: closed('shipped'), shipper: { adminId: 'd1' }, window: { endTimestamp: 3000 }, cartCount: 0, handledCount: 0 }
        ]
        const DL = {
            Order: { Model: { filterFields: new Set(['id']), schema: { path: () => ({ instance: 'String' }) }, aggregate: async () => docs } },
            Store: { readById: async () => null }
        }
        const admin = makeAdmin({ id: 'd1', permissions: ['order:ship'], currentStoreId: 's1' })

        const rows = await list({ filter: { 'shipper.adminId': 'd1' }, sort: { 'window.endTimestamp': 1 } }, { DL, _admin: admin })

        // No origin in the harness, so the route falls back to deadline order — the
        // closed order still has to come last, after the two still to deliver.
        assert.deepEqual(rows.map(r => r.id), ['open1', 'open2', 'closed1'])
        // The flags order the rows, they are not part of what the page gets
        assert.equal(rows[0].closedFirst, undefined)
        assert.equal(rows[0].mineFirst, undefined)
        assert.ok(rows[0].isMine)
        // The queue row is a card row: counts instead of a cart, whatever the tab
        assert.equal(rows[0].cart, undefined)
        assert.ok('cartCount' in rows[0] && 'handledCount' in rows[0])
    })

    it('applies the role window on the queue read itself, not only on the count', async () => {
        const pipeline = {}
        const DL = {
            Order: {
                Model: {
                    filterFields: new Set(['name']),
                    schema: { path: () => ({ instance: 'String' }) },
                    aggregate: stages => { pipeline.stages = stages; return [] }
                }
            },
            Store: { readById: async () => null }
        }
        const admin = makeAdmin({ id: 'p1', permissions: ['order:pick'], currentStoreId: 's1' })

        await list({ filter: {}, search: 'abc' }, { DL, _admin: admin })

        const match = pipeline.stages[0].$match
        assert.deepEqual(match.$and[0]['window.date'], { $lte: day(1) })
        assert.deepEqual(match.$and[0].status, { $in: ['paid', 'picking', 'picked', 'packed'] })
        assert.equal(match.$and[1].$or.length, 1)
    })

    it('the by-id detail keeps the full cart grouped by category, the queue does not carry one', async () => {
        const docs = [{
            id: 'o1', storeId: 's1', status: 'paid', cart: [
                { barcode: 'later-l3', category: { id: 'nc:9:904:9142' } },
                { barcode: 'first', category: { id: 'nc:203:2003' } },
                { barcode: 'uncategorized' },
                { barcode: 'later-l2', category: { id: 'nc:9:904' } }
            ]
        }]
        const DL = {
            Order: {
                Model: {
                    filterFields: new Set(['id']),
                    schema: { path: () => ({ instance: 'String' }) },
                    aggregate: async () => docs
                }
            },
            Store: { readById: async () => null }
        }
        const admin = makeAdmin({ id: 'a1', permissions: ['order:read'], currentStoreId: 's1' })

        const rows = await list({ filter: { id: 'o1' } }, { DL, _admin: admin })

        assert.deepEqual(
            rows[0].cart.map(item => item.barcode),
            ['first', 'later-l2', 'later-l3', 'uncategorized']
        )
        // A detail row has the cart itself — no separate count fields on it.
        assert.equal(rows[0].cartCount, undefined)

        // The same read without an id is the queue: the cart is excluded from the
        // projection and only its counts come through.
        const queuePipeline = {}
        const queueDL = {
            ...DL,
            Order: {
                Model: {
                    ...DL.Order.Model,
                    aggregate: stages => { queuePipeline.stages = stages; return [] }
                }
            }
        }
        await list({ filter: {} }, { DL: queueDL, _admin: admin })
        const project = queuePipeline.stages.find(s => s.$project).$project
        assert.equal(project.cart, undefined)
        assert.ok(project.cartCount && project.handledCount)
    })

    it('a tab asks for its view through the same rule the server uses, so a badge cannot count more than the tab shows', () => {
        const view = viewScope('order:ship')
        const waiting = opsStatusWindow({ scope: view, status: 'packed', today })
        const mine = { ...opsStatusWindow({ scope: view, today }), 'shipper.adminId': 'd1' }

        // A view pinned to one store names it in its filter; the contractor's view asks
        // for no store, which is what keeps his queue across all his stores.
        assert.equal(view.stores, 'current')
        assert.equal(viewScope('order:ship:manage').stores, 'scope')

        assert.deepEqual(waiting, { status: 'packed', 'window.date': { $lte: day(1) } })
        assert.equal(mine['shipper.adminId'], 'd1')
        // The client's own look is never wider than its permission.
        const scope = opsScope({ hasPermission: p => p === 'order:ship' })
        const clause = opsStatusWindow({ scope, status: 'done', today })
        assert.deepEqual(clause['window.date'], { $gte: day(-1), $lte: day(1) })

        // The same table also decides what the view may show in the filter row, so a
        // control the role could not use is never rendered.
        assert.equal(view.controls, 'none')
        assert.equal(viewScope('order:pick').controls, 'search')
        assert.equal(viewScope('order:ship:manage').controls, 'filter')
    })
})
