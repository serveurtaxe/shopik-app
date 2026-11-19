import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planBarcodeAliases } from '../../server/services/barcodeAliases/index.js'

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden', ARCHIVED: 'archived' }

const CSV = [
    'שם מוצר,ברקוד ראשי,ברקוד משני',
    'ביצים 12 יח׳ M,1111111111111,2222222222222'
].join('\n')

const MAIN = {
    _id: 'id-main',
    id: 'p-main',
    barcode: '1111111111111',
    name: 'שם ותיק',
    status: STATUS.HIDDEN,
    storeIds: [],
    totalSalesUnits: 519,
    prices: [{ domainId: 'dom', price: 12 }],
    buyingPrice: 8,
    images: { product: [{ url: 'https://example.com/a.jpg' }] },
    scannableBarcodes: []
}

const DUPLICATE = {
    _id: 'id-dup',
    id: 'p-dup',
    barcode: '2222222222222',
    name: 'ביצים 12 ישנות',
    status: STATUS.ACTIVE,
    storeIds: ['store-b'],
    totalSalesUnits: 207,
    prices: [{ domainId: 'dom', price: 11 }],
    buyingPrice: 7,
    images: { product: [{ url: 'https://example.com/b.jpg' }] },
    scannableBarcodes: []
}

const comaxRow = (barcode, overrides = {}) => ({
    barcode,
    price: 12,
    buyingPrice: 8,
    storeIds: ['store-a'],
    salesLastDays: 519,
    showInWeb: true,
    archived: false,
    subGroupCode: '10110',
    ...overrides
})

function makeDL({ orders = [] }) {
    const calls = { updates: [], deleted: [], snapshots: [], writes: [] }

    const orderModel = {
        find(filter = {}) {
            const after = filter.id?.$gt
            const wanted = filter.$or.flatMap(sub => [
                ...(sub['cart.barcode']?.$in || []),
                ...(sub['cart.id']?.$in || [])
            ])
            const found = orders
                .filter(order => !after || order.id > after)
                .filter(order => order.cart.some(item => wanted.includes(item.barcode) || wanted.includes(item.id)))
                .sort((a, b) => a.id.localeCompare(b.id))
            let cap = 0
            const chain = {
                sort: () => chain,
                limit: n => { cap = n; return chain },
                lean: async () => found.slice(0, cap || found.length).map(order => ({ id: order.id }))
            }
            return chain
        },
        async updateMany(filter = {}, update = {}, options = {}) {
            let modifiedCount = 0
            for (const order of orders) {
                if (filter.id?.$in && !filter.id.$in.includes(order.id)) continue
                let changed = 0
                for (const item of order.cart) {
                    const rule = options.arrayFilters[0]
                    const [key, wanted] = Object.entries(rule)[0]
                    if (item[key.replace(/^item\./, '')] !== wanted) continue
                    item.id = update.$set['cart.$[item].id']
                    item.barcode = update.$set['cart.$[item].barcode']
                    changed++
                }
                modifiedCount += changed
            }
            return { modifiedCount }
        }
    }

    return {
        calls,
        DL: {
            Product: {
                constants: { STATUS },
                Model: {
                    find: () => {
                        const chain = {
                            select: () => chain, sort: () => chain, limit: () => chain,
                            lean: async () => []
                        }
                        return chain
                    },
                    findById: id => ({ lean: async () => [MAIN, DUPLICATE].find(doc => doc._id === id) })
                },
                read: async filter => [MAIN, DUPLICATE].filter(doc => (filter.barcode?.$in || []).includes(doc.barcode)),
                updateOne: async (filter, update) => { calls.updates.push({ filter, update }); return { id: filter.id } },
                deleteOne: async filter => { calls.deleted.push(filter); return { deletedCount: 1 } },
                bulkWrite: async ({ docs }) => { calls.writes.push(docs); return { modifiedCount: docs.length } }
            },
            DeletedProduct: { create: async doc => { calls.snapshots.push(doc); return doc } },
            ComaxProduct: {
                count: async filter => (filter?.buyingPrice ? 1 : 2),
                read: async filter => [
                    comaxRow('1111111111111'),
                    comaxRow('2222222222222', { storeIds: ['store-b'], salesLastDays: 207, price: 11 })
                ].filter(row => (filter.barcode?.$in || []).includes(row.barcode))
            },
            Category: { read: async () => [{ id: 'nc:206:2027', name: 'ביצים', parentIds: ['nc:206'] }] },
            CategoryMap: {
                read: async () => [{ subGroupCode: '10110', categoryId: 'nc:206:2027', showOnSite: true, requireKashrut: false, categoryActive: true }]
            },
            Domain: { readOne: async () => ({ id: 'dom' }) },
            Order: { Model: orderModel },
            GuestCart: { Model: null }
        }
    }
}

describe('barcode alias import apply', () => {
    it('writes the family onto the main product', async () => {
        const { calls, DL } = makeDL({})
        const report = await planBarcodeAliases({ csv: CSV, dryRun: true }, { DL })

        assert.equal(report.dryRun, true)
        assert.deepEqual(report.stats, {
            rows: 1, validRows: 1, applicable: 1, blocked: 0, missingMain: 0,
            aliases: 1, duplicateDocs: 1, parseErrors: 0
        })
        assert.equal(calls.updates.length, 0, 'a check pass writes nothing')

        const plan = report.rows[0]
        assert.equal(plan.update.name, 'ביצים 12 יח׳ M')
        assert.equal(plan.statusBefore, STATUS.HIDDEN)
        assert.equal(plan.salesAfter, 726)
    })

    it('snapshots the duplicate, deletes it and repoints the orders', async () => {
        const orders = [
            { id: 'o1', cart: [{ id: 'p-dup', barcode: '2222222222222', name: 'ביצים 12 ישנות', price: 11 }] },
            { id: 'o2', cart: [{ id: 'p-other', barcode: '5555555555555' }] }
        ]
        const { calls, DL } = makeDL({ orders })

        const report = await planBarcodeAliases({ csv: CSV, dryRun: false, adminId: 'admin-1' }, { DL })

        assert.deepEqual(calls.updates[0].filter, { id: 'p-main' })
        assert.deepEqual(calls.updates[0].update, {
            name: 'ביצים 12 יח׳ M',
            nameLocked: true,
            scannableBarcodes: ['2222222222222'],
            status: STATUS.ACTIVE,
            storeIds: ['store-a', 'store-b'],
            totalSalesUnits: 726
        })

        // The whole duplicate doc is kept before it is removed.
        assert.deepEqual(calls.snapshots.map(s => s.barcode), ['2222222222222'])
        assert.equal(calls.snapshots[0].product.id, 'p-dup')
        assert.equal(calls.snapshots[0].mainBarcode, '1111111111111')
        assert.equal(calls.snapshots[0].deletedBy, 'admin-1')
        assert.deepEqual(calls.deleted, [{ id: 'p-dup' }])

        assert.equal(report.applied.deleted, 1)
        assert.equal(report.applied.ordersRewritten, 1)
        assert.deepEqual(orders[0].cart[0], {
            id: 'p-main', barcode: '1111111111111', name: 'ביצים 12 ישנות', price: 11
        })
        assert.deepEqual(orders[1].cart[0], { id: 'p-other', barcode: '5555555555555' })
    })

    it('applies nothing when every row is blocked', async () => {
        const { calls, DL } = makeDL({})
        const report = await planBarcodeAliases({
            csv: 'ברקוד ראשי,ברקוד משני\n9999999999999,8888888888888',
            dryRun: false
        }, { DL })

        assert.equal(report.stats.applicable, 0)
        assert.equal(report.applied.rows, 0)
        assert.deepEqual(calls.updates, [])
        assert.deepEqual(calls.deleted, [])
    })

    it('refuses an empty csv', async () => {
        const { DL } = makeDL({})
        const error = await planBarcodeAliases({ csv: '   ' }, { DL }).catch(e => e)
        assert.equal(error?.status, 400)
    })
})
