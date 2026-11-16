import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    buildSyncFilter,
    hideActiveProduct,
    hideCategoryFlaggedProducts,
    hideInactiveProducts,
    hideKashrutMissingProducts,
    hideStorelessProducts
} from '../../server/api/comax_product/syncRules.js'
import { KASHRUT_VALID_CODES } from '../../common/components/Kashrut/constants.js'

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden' }
const INACTIVE_FILTER = { active: false, barcode: { $nin: [null, ''] } }

describe('comax sync rules', () => {
    it('excludes explicitly inactive comax products', () => {
        assert.deepEqual(buildSyncFilter(), {
            active: { $ne: false },
            isTrailingItem: { $ne: true },
            superDepartmentCode: { $exists: true, $nin: ['12', null] },
            departmentCode: { $exists: true },
            groupCode: { $exists: true }
        })
    })

    it('hides only an active product for one barcode', async () => {
        const calls = []
        const DL = {
            Product: {
                constants: { STATUS },
                update: async (filter, update) => {
                    calls.push({ filter, update })
                    return { modifiedCount: 1 }
                }
            }
        }

        const hidden = await hideActiveProduct({ DL, barcode: '123' })

        assert.equal(hidden, 1)
        assert.deepEqual(calls, [{
            filter: { barcode: '123', status: 'active' },
            update: { status: 'hidden' }
        }])
    })

    it('does nothing without a barcode', async () => {
        const DL = {
            Product: {
                constants: { STATUS },
                update: async () => { throw new Error('should not update') }
            }
        }

        assert.equal(await hideActiveProduct({ DL }), 0)
    })

    it('hides active products for inactive comax rows in barcode pages', async () => {
        const rows = [{ barcode: '1' }, { barcode: '2' }, { barcode: '3' }]
        const updates = []
        const pages = []
        const DL = {
            ComaxProduct: {
                read: async (filter, select, options) => {
                    pages.push({ filter, select, options })
                    const after = filter.barcode?.$gt
                    return rows.filter(row => !after || row.barcode > after).slice(0, options.limit)
                }
            },
            Product: {
                constants: { STATUS },
                update: async (filter, update) => {
                    updates.push({ filter, update })
                    return { modifiedCount: filter.barcode.$in.length }
                }
            }
        }

        const hidden = await hideInactiveProducts({ DL, batchSize: 2 })

        assert.equal(hidden, 3)
        assert.deepEqual(updates, [
            {
                filter: { barcode: { $in: ['1', '2'] }, status: 'active' },
                update: { status: 'hidden' }
            },
            {
                filter: { barcode: { $in: ['3'] }, status: 'active' },
                update: { status: 'hidden' }
            }
        ])
        // Keyset pages on the unique barcode, never skip: MongoDB bounds a
        // blocking sort by skip + limit, which the whole catalog walks past.
        assert.deepEqual(pages.map(page => page.filter.barcode), [
            INACTIVE_FILTER.barcode,
            { $gt: '2' }
        ])
        assert.deepEqual(pages.map(page => page.options), [
            { limit: 2, sort: { barcode: 1 } },
            { limit: 2, sort: { barcode: 1 } }
        ])
    })

    it('stops when there are no inactive comax rows', async () => {
        const DL = {
            ComaxProduct: {
                read: async () => []
            },
            Product: {
                constants: { STATUS },
                update: async () => { throw new Error('should not update') }
            }
        }

        assert.equal(await hideInactiveProducts({ DL }), 0)
    })

    it('hides every active product that is in no store', async () => {
        const calls = []
        const DL = {
            Product: {
                constants: { STATUS },
                update: async (filter, update) => {
                    calls.push({ filter, update })
                    return { modifiedCount: 7 }
                }
            }
        }

        const hidden = await hideStorelessProducts({ DL })

        assert.equal(hidden, 7)
        assert.deepEqual(calls, [{
            filter: { status: 'active', 'storeIds.0': { $exists: false } },
            update: { status: 'hidden' }
        }])
    })

    it('counts only the products the sweep actually changed', async () => {
        const DL = {
            Product: {
                constants: { STATUS },
                update: async () => ({ modifiedCount: 0 })
            }
        }

        assert.equal(await hideStorelessProducts({ DL }), 0)
    })

    it('hides active products in sub-groups marked hide on site or in an inactive category', async () => {
        const calls = []
        const filters = []
        const DL = {
            CategoryMap: {
                read: async (filter, select) => {
                    filters.push({ filter, select })
                    return filter.showOnSite === false
                        ? [{ subGroupCode: '1' }, { subGroupCode: 2 }]
                        : [{ subGroupCode: '3' }]
                }
            },
            Product: {
                constants: { STATUS },
                update: async (filter, update) => {
                    calls.push({ filter, update })
                    return { modifiedCount: 3 }
                }
            }
        }

        const hidden = await hideCategoryFlaggedProducts({ DL })

        assert.equal(hidden, 3)
        assert.deepEqual(filters, [
            { filter: { showOnSite: false }, select: { _id: 0, subGroupCode: 1 } },
            { filter: { categoryActive: false }, select: { _id: 0, subGroupCode: 1 } }
        ])
        assert.deepEqual(calls, [{
            filter: { status: 'active', comaxSubGroupCode: { $in: ['1', '2', '3'] } },
            update: { status: 'hidden' }
        }])
    })

    it('hides active products in kashrut-required sub-groups without a valid code', async () => {
        const calls = []
        const DL = {
            CategoryMap: {
                read: async filter => {
                    assert.deepEqual(filter, { requireKashrut: true })
                    return [{ subGroupCode: '90200' }]
                }
            },
            Product: {
                constants: { STATUS },
                update: async (filter, update) => {
                    calls.push({ filter, update })
                    return { modifiedCount: 2 }
                }
            }
        }

        const hidden = await hideKashrutMissingProducts({ DL })

        assert.equal(hidden, 2)
        assert.deepEqual(calls, [{
            filter: {
                status: 'active',
                comaxSubGroupCode: { $in: ['90200'] },
                'kashrut.rabbinates': { $not: { $elemMatch: { code: { $in: [...KASHRUT_VALID_CODES] } } } }
            },
            update: { status: 'hidden' }
        }])
    })

    it('does not touch products when no sub-group carries the flag', async () => {
        const DL = {
            CategoryMap: { read: async () => [] },
            Product: {
                constants: { STATUS },
                update: async () => { throw new Error('should not update') }
            }
        }

        assert.equal(await hideCategoryFlaggedProducts({ DL }), 0)
        assert.equal(await hideKashrutMissingProducts({ DL }), 0)
    })
})
