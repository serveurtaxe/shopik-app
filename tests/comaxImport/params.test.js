import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildComaxParams, buildSalesPriceArray } from '../../server/external/comax/utils.js'

describe('Comax request params', () => {
    it('hides archived items by default', () => {
        assert.equal(buildComaxParams({ itemId: '10068012' }).WithOutArchive, 1)
    })

    it('sends WithOutArchive=0 when a caller explicitly wants archived items', () => {
        // The backfill keeps the default; the archived-products work needs the
        // opposite, and a caller must be able to ask for it.
        assert.equal(buildComaxParams({ itemId: '10068012', withOutArchive: false }).WithOutArchive, 0)
        assert.equal(buildComaxParams({ itemId: '10068012', withOutArchive: true }).WithOutArchive, 1)
    })

    it('only sends the optional filters the caller asked for', () => {
        const plain = buildComaxParams({ itemId: '10068012' })
        assert.equal('HasInventory' in plain, false)
        assert.equal('SelByPriceList' in plain, false)
        assert.equal('SalesPriceArray' in plain, false)

        const storeFeed = buildComaxParams({
            itemId: '10068012',
            hasInventory: true,
            selByPriceList: true,
            salesPriceArray: '1069,255'
        })
        assert.equal(storeFeed.HasInventory, 1)
        assert.equal(storeFeed.SelByPriceList, 1)
        assert.equal(storeFeed.SalesPriceArray, '1069,255')
    })

    it('maps camelCase options, booleans and dates to the Comax shape', () => {
        const params = buildComaxParams({
            itemId: '1001004',
            departmentId: ['13', '14'],
            lastUpdatedFromDate: new Date(2026, 10, 12)
        })
        assert.equal(params.ItemID, '1001004')
        assert.equal(params.DepartmentID, '13,14')
        assert.equal(params.LastUpdatedFromDate, '12/11/2026')
    })

    it('lists the retail and delivery price lists once each', () => {
        assert.equal(buildSalesPriceArray({ priceListId: '1069', deliveryPriceListId: '255' }), '1069,255')
        assert.equal(buildSalesPriceArray({ priceListId: '255', deliveryPriceListId: '255' }), '255')
    })
})
