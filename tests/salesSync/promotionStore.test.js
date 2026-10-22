import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    resolvePromotionStoreCodes,
    buildOtherStoreFilter,
    matchesPromotionStore
} from '../../server/api/comax_sale/promotionStore.js'
import { buildComaxPromotionParams } from '../../server/external/comax/utils.js'

const ENV_KEY = 'COMAX_PROMOTION_STORE_ID'
const originalValue = process.env[ENV_KEY]

afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = originalValue
})

describe('comax promotion store', () => {
    it('resolves the configured promotion store id', () => {
        process.env[ENV_KEY] = ' 711 '
        assert.deepEqual(resolvePromotionStoreCodes(), '711')
    })

    it('supports a comma-separated store list', () => {
        process.env[ENV_KEY] = '711, 712'
        assert.deepEqual(resolvePromotionStoreCodes(), '711,712')
    })

    it('fails when the promotion store id is missing', () => {
        delete process.env[ENV_KEY]
        assert.throws(() => resolvePromotionStoreCodes(), /COMAX_PROMOTION_STORE_ID/)
    })

    it('fails when the promotion store id is blank', () => {
        process.env[ENV_KEY] = '  '
        assert.throws(() => resolvePromotionStoreCodes(), /COMAX_PROMOTION_STORE_ID/)
    })

    it('builds a filter that keeps all-branch promotions', () => {
        assert.deepEqual(buildOtherStoreFilter('711'), {
            swAllBranches: { $ne: true },
            'stores.Kod': { $nin: ['711'] }
        })
    })

    it('builds a filter that excludes every configured store', () => {
        assert.deepEqual(buildOtherStoreFilter('711,712'), {
            swAllBranches: { $ne: true },
            'stores.Kod': { $nin: ['711', '712'] }
        })
    })

    it('matches promotions for the configured store or all branches', () => {
        assert.equal(matchesPromotionStore({ swAllBranches: true }, '711'), true)
        assert.equal(matchesPromotionStore({ stores: [{ Kod: '711' }] }, '711'), true)
        assert.equal(matchesPromotionStore({ stores: [{ Kod: 711 }] }, '711'), true)
        assert.equal(matchesPromotionStore({ stores: [{ Kod: '999' }] }, '711'), false)
        assert.equal(matchesPromotionStore({ stores: [] }, '711'), false)
    })

    it('matches a store code exactly, not as a substring of another', () => {
        // A substring check against '711,712' would match '71' as well.
        assert.equal(matchesPromotionStore({ stores: [{ Kod: '712' }] }, '711,712'), true)
        assert.equal(matchesPromotionStore({ stores: [{ Kod: '71' }] }, '711,712'), false)
    })

    it('sends the store list to Comax as a comma separated string', () => {
        process.env[ENV_KEY] = '711, 712'
        const params = JSON.parse(buildComaxPromotionParams({ storeList: resolvePromotionStoreCodes() }))

        assert.equal(params.StoreList, '711,712')
    })
})
