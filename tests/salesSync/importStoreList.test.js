import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import importComaxSales from '../../server/api/comax_sale/import.js'

const ENV_KEY = 'COMAX_PROMOTION_STORE_ID'
const originalValue = process.env[ENV_KEY]

afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = originalValue
})

function fakeDL(staleSales = []) {
    const calls = {
        deleteMany: [],
        saleUpdates: [],
        bulkWrite: null,
        pruneFilter: null
    }
    const DL = {
        ComaxSale: {
            Model: {
                findOne: () => ({
                    sort: () => ({
                        lean: async () => null
                    })
                }),
                // The prune reads through Model.find on purpose: DL.read runs
                // the filter through processFilter, which drops swAllBranches
                // and stores.Kod (neither is a filter field) and would make the
                // prune delete every store's promotions.
                find: (filter, select) => {
                    calls.pruneFilter = filter
                    return {
                        lean: async () => staleSales
                    }
                },
                deleteMany: async filter => {
                    calls.deleteMany.push(filter)
                    return { deletedCount: staleSales.length }
                }
            },
            bulkWrite: async args => {
                calls.bulkWrite = args
                return { upsertedCount: args.docs.length }
            }
        },
        Sale: {
            constants: {
                STATUS: { ACTIVE: 'active', PENDING: 'pending', CANCELED: 'canceled' }
            },
            update: async (filter, update) => {
                calls.saleUpdates.push({ filter, update })
                return { modifiedCount: staleSales.length }
            }
        }
    }
    return { DL, calls }
}

describe('comax sales import store list', () => {
    it('requests only promotions for COMAX_PROMOTION_STORE_ID and prunes other stores', async () => {
        process.env[ENV_KEY] = '711'
        const { DL, calls } = fakeDL([{ comaxId: 'old-other' }])
        const promotions = [
            { comaxId: '711-promo', swAllBranches: false, stores: [{ Kod: '711' }] },
            { comaxId: 'all-branches', swAllBranches: true, stores: [] },
            { comaxId: 'other-store', swAllBranches: false, stores: [{ Kod: '999' }] }
        ]
        const external = {
            comax: {
                getPromotions: async options => {
                    calls.promotionsOptions = options
                    return promotions
                }
            }
        }

        const result = await importComaxSales({}, { DL, external })

        assert.deepEqual(calls.promotionsOptions.storeList, '711')
        assert.deepEqual(calls.pruneFilter, {
            swAllBranches: { $ne: true },
            'stores.Kod': { $nin: ['711'] }
        })
        assert.deepEqual(calls.deleteMany, [{ comaxId: { $in: ['old-other'] } }])
        assert.deepEqual(calls.saleUpdates, [{
            filter: {
                id: { $in: ['old-other'] },
                createdBy: 'Comax Sync',
                status: { $in: ['active', 'pending'] }
            },
            update: { status: 'canceled' }
        }])
        assert.deepEqual(calls.bulkWrite.docs.map(s => s.comaxId), ['711-promo', 'all-branches'])
        assert.equal(result.count, 2)
        assert.equal(result.pruned, 1)
        assert.equal(result.canceled, 1)
    })

    it('fails before calling Comax when the store id is missing', async () => {
        delete process.env[ENV_KEY]
        const { DL } = fakeDL()
        const external = {
            comax: {
                getPromotions: async () => {
                    throw new Error('should not call Comax')
                }
            }
        }

        await assert.rejects(
            importComaxSales({}, { DL, external }),
            /COMAX_PROMOTION_STORE_ID/
        )
    })
})
